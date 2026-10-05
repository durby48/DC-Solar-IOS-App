/**
 * service-visit-done — the crew's "Visit done" for a service visit, plus the
 * charge (2026-10-05, B2).
 *
 * POST { job_id } → { ok, charge, message }
 *   charge: 'paid'      — the annual plan started and year one was charged
 *           'covered'   — the customer already has an active plan
 *           'failed'    — the card was declined (visit still done; flagged)
 *           'no_card'   — no card on file (visit still done; flagged)
 *           'not_configured' — no plan price set (visit still done; flagged)
 *
 * 1. Marks the visit done by calling mark_service_visit_done() AS THE CALLER
 *    (their JWT), so its rules decide who may: staff, never sales.
 * 2. Then, with the service role, starts the customer's annual subscription
 *    on the card saved through `stripe-card-link` — Stripe charges year one
 *    immediately and renews yearly. Idempotent per visit (Stripe
 *    Idempotency-Key), so a double tap cannot double-charge.
 * 3. On success: jobs.service_paid_at (the Pipeline's Paid tag), the lead
 *    becomes 'won' — a customer — and any payment flag clears. `stripe-webhook`
 *    records the same thing from invoice.paid, so either arriving first is fine.
 *
 * The visit being done never depends on the charge: a declined card or a
 * missing one leaves it done, Not paid, with customers.payment_issue set for
 * an admin to chase in the Stripe dashboard.
 *
 * Secrets: STRIPE_SECRET_KEY. Auth: verify_jwt ON.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const STRIPE_VERSION = '2024-06-20';

function ok(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, ...payload }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

function fail(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ ok: false, code, error }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

async function stripe(
  key: string,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string> = {},
  idempotencyKey?: string,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; message: string }> {
  const body = new URLSearchParams(params).toString();
  const url = `https://api.stripe.com/v1/${path}${method === 'GET' && body ? `?${body}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Stripe-Version': STRIPE_VERSION,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: method === 'POST' ? body : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = data.error as { message?: string } | undefined;
    return { ok: false, message: err?.message ?? `Stripe returned ${res.status}` };
  }
  return { ok: true, data };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'POST only');

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!supabaseUrl || !serviceKey || !anonKey) return fail(500, 'not_configured', 'Server is missing its Supabase settings.');
    const admin = createClient(supabaseUrl, serviceKey);

    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!jwt) return fail(401, 'unauthorized', 'Missing Authorization header.');
    const body = (await req.json().catch(() => ({}))) as { job_id?: string };
    if (!body.job_id) return fail(400, 'bad_request', 'job_id is required.');
    const jobId = body.job_id;

    // --- 1. done, by the caller's own rights ---------------------------------
    const asCaller = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    });
    const { error: doneErr } = await asCaller.rpc('mark_service_visit_done', { p_job_id: jobId });
    if (doneErr) return fail(409, 'not_done', doneErr.message);

    // --- 2. the charge ------------------------------------------------------
    const { data: job } = await admin.from('jobs').select('id, company, customer_id').eq('id', jobId).maybeSingle();
    const { data: customer } = job?.customer_id
      ? await admin
          .from('customers')
          .select('id, stripe_customer_id, card_on_file_at, stripe_subscription_id, plan_status')
          .eq('id', job.customer_id)
          .maybeSingle()
      : { data: null };

    const flag = async (issue: string) => {
      if (customer) {
        await admin
          .from('customers')
          .update({ payment_issue: issue, payment_issue_at: new Date().toISOString() })
          .eq('id', customer.id);
      }
    };
    const markPaid = async (invoiceId: string | null) => {
      await admin
        .from('jobs')
        .update({ service_paid_at: new Date().toISOString(), stripe_invoice_id: invoiceId })
        .eq('id', jobId)
        .is('service_paid_at', null);
      await admin.from('leads').update({ status: 'won' }).eq('converted_job_id', jobId).in('status', ['scheduled', 'visit_done']);
    };

    if (!customer) {
      return ok({ charge: 'no_card', message: 'Visit done. There is no customer record to charge.' });
    }
    if (customer.stripe_subscription_id && customer.plan_status === 'active') {
      await markPaid(null);
      return ok({ charge: 'covered', message: 'Visit done — covered by their active annual plan.' });
    }
    if (!stripeKey) {
      await flag('Stripe is not connected, so the visit was not charged.');
      return ok({ charge: 'not_configured', message: 'Visit done, but Stripe is not connected — not charged.' });
    }
    if (!customer.stripe_customer_id || !customer.card_on_file_at) {
      await flag('No card on file when the visit was marked done.');
      return ok({ charge: 'no_card', message: 'Visit done, but there is no card on file — an admin will follow up.' });
    }
    const { data: settings } = await admin
      .from('company_settings')
      .select('stripe_annual_price_id')
      .eq('company', job!.company)
      .maybeSingle();
    const priceId = (settings as { stripe_annual_price_id?: string | null } | null)?.stripe_annual_price_id;
    if (!priceId) {
      await flag('No annual plan price is set, so the visit was not charged.');
      return ok({ charge: 'not_configured', message: 'Visit done, but no plan price is set — not charged.' });
    }

    const sub = await stripe(
      stripeKey,
      'POST',
      'subscriptions',
      {
        customer: customer.stripe_customer_id,
        'items[0][price]': priceId,
        payment_behavior: 'allow_incomplete',
        off_session: 'true',
        'expand[0]': 'latest_invoice.payment_intent',
        'metadata[dc_customer_id]': customer.id,
        'metadata[dc_job_id]': jobId,
      },
      `visit-done-${jobId}`,
    );
    if (!sub.ok) {
      await flag(`Could not start the plan: ${sub.message}`);
      return ok({ charge: 'failed', message: `Visit done, but the charge failed: ${sub.message}` });
    }

    const status = sub.data.status as string;
    const invoice = sub.data.latest_invoice as { id?: string; payment_intent?: { last_payment_error?: { message?: string } } } | null;
    await admin
      .from('customers')
      .update({ stripe_subscription_id: sub.data.id as string, plan_status: status })
      .eq('id', customer.id);

    if (status === 'active' || status === 'trialing') {
      await markPaid(invoice?.id ?? null);
      await admin.from('customers').update({ payment_issue: null, payment_issue_at: null }).eq('id', customer.id);
      return ok({ charge: 'paid', message: 'Visit done — the annual plan started and year one was charged.' });
    }
    const reason = invoice?.payment_intent?.last_payment_error?.message ?? 'The card was declined.';
    await flag(`Payment failed: ${reason}`);
    return ok({ charge: 'failed', message: `Visit done, but the charge failed: ${reason}` });
  } catch (e) {
    return fail(500, 'unexpected', e instanceof Error ? e.message : 'Unexpected error.');
  }
});
