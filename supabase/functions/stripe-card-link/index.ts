/**
 * stripe-card-link — a Stripe-hosted page where a booked customer saves the
 * card their annual service plan will be charged to (2026-10-05, B2).
 *
 * POST { job_id } → { ok, url, expires_at }
 *
 * Who: an admin, or the rep who booked the visit (jobs.sales_rep_email).
 * Only for an open service visit (job_type Cleaning/Inspection, stage
 * 'Service Call').
 *
 * What: makes (once) a Stripe Customer for the DC Solar customer record the
 * booking created, saves its id on customers.stripe_customer_id, and opens a
 * Checkout Session in SETUP mode — Stripe collects and keeps the card; DC
 * Solar never sees it. When the customer finishes, Stripe sends
 * checkout.session.completed to `stripe-webhook`, which records "card on file"
 * (brand + last 4) and makes the card the customer's default for the plan.
 *
 * The link lasts 24 hours (Stripe's Checkout default); the rep can make a new
 * one any time.
 *
 * Secrets: STRIPE_SECRET_KEY (sk_test_… / sk_live_…). Optional
 * APP_PUBLIC_BASE (default https://app.dcsolarkc.com) for the thank-you page.
 * Auth: verify_jwt ON plus the role / ownership check below.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SERVICE_TYPES = ['Cleaning', 'Inspection'];
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

/** Stripe's REST API takes form-encoded bodies; `a[b]` keys spell nesting. */
async function stripe(
  key: string,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string> = {},
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; message: string }> {
  const body = new URLSearchParams(params).toString();
  const url = `https://api.stripe.com/v1/${path}${method === 'GET' && body ? `?${body}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Stripe-Version': STRIPE_VERSION,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
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
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    const appBase = (Deno.env.get('APP_PUBLIC_BASE') ?? 'https://app.dcsolarkc.com').replace(/\/+$/, '');
    if (!supabaseUrl || !serviceKey) return fail(500, 'not_configured', 'Server is missing its Supabase settings.');
    if (!stripeKey) return fail(500, 'not_configured', 'Stripe is not connected yet (STRIPE_SECRET_KEY).');
    const admin = createClient(supabaseUrl, serviceKey);

    // --- who is asking ------------------------------------------------------
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!jwt) return fail(401, 'unauthorized', 'Missing Authorization header.');
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    const callerEmail = userData?.user?.email?.toLowerCase();
    if (userErr || !callerEmail) return fail(401, 'unauthorized', 'Not signed in.');
    const { data: employee } = await admin.from('employees').select('is_developer, role, company').eq('email', callerEmail).maybeSingle();
    // A developer (2026-10-08, employees.is_developer) may do anything an owner may.
    const role = (employee as { is_developer?: boolean } | null)?.is_developer
      ? 'owner'
      : (employee as { role?: string } | null)?.role;
    if (!role) return fail(403, 'forbidden', 'Staff only.');

    // --- which visit --------------------------------------------------------
    const body = (await req.json().catch(() => ({}))) as { job_id?: string };
    if (!body.job_id) return fail(400, 'bad_request', 'job_id is required.');
    const { data: job } = await admin
      .from('jobs')
      .select('id, company, job_number, job_type, stage, sales_rep_email, customer_id, plan_tier, plan_price_cents')
      .eq('id', body.job_id)
      .maybeSingle();
    if (!job) return fail(404, 'not_found', 'Visit not found.');
    const isAdmin = role === 'owner' || role === 'operator';
    const isTheRep = (job.sales_rep_email ?? '').toLowerCase() === callerEmail;
    const isManager = role === 'sales_manager'; // runs the sales team (2026-10-07)
    if (!isAdmin && !isTheRep && !isManager) {
      return fail(403, 'forbidden', 'Only the rep who booked this visit, a sales manager or an admin can send its card link.');
    }
    if (!SERVICE_TYPES.includes(job.job_type ?? '') || job.stage !== 'Service Call') {
      return fail(409, 'not_open', 'Card links are for an open service visit.');
    }
    if (!job.customer_id) return fail(409, 'no_customer', 'This visit has no customer record.');

    const { data: customer } = await admin
      .from('customers')
      .select('id, name, email, phone, stripe_customer_id')
      .eq('id', job.customer_id)
      .maybeSingle();
    if (!customer) return fail(404, 'not_found', 'Customer record not found.');

    // --- Stripe customer (once) ---------------------------------------------
    let stripeCustomerId = customer.stripe_customer_id as string | null;
    if (!stripeCustomerId) {
      const params: Record<string, string> = {
        name: customer.name,
        'metadata[dc_customer_id]': customer.id,
        'metadata[company]': job.company,
      };
      if (customer.email) params.email = customer.email;
      if (customer.phone) params.phone = customer.phone;
      const created = await stripe(stripeKey, 'POST', 'customers', params);
      if (!created.ok) return fail(502, 'stripe_error', `Stripe: ${created.message}`);
      stripeCustomerId = created.data.id as string;
      const { error: saveErr } = await admin
        .from('customers')
        .update({ stripe_customer_id: stripeCustomerId })
        .eq('id', customer.id);
      if (saveErr) return fail(500, 'save_failed', `Could not save the Stripe customer: ${saveErr.message}`);
    }

    // --- what they are agreeing to (2026-10-06, plans) -----------------------
    // Shown above the Save button on Stripe's page: the plan, its yearly
    // price, the 2-year agreement, and that nothing is charged yet.
    const TIER_LABEL: Record<string, string> = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', custom: 'Custom' };
    const cents = job.plan_price_cents as number | null;
    const dollars = cents ? `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0 })}` : null;
    const terms = [
      job.plan_tier && dollars ? `DC Solar ${TIER_LABEL[job.plan_tier as string] ?? ''} service plan: ${dollars} per year, 2-year agreement.` : null,
      'Nothing is charged until after your first service visit.',
    ]
      .filter(Boolean)
      .join(' ');

    // --- the card page ------------------------------------------------------
    const session = await stripe(stripeKey, 'POST', 'checkout/sessions', {
      'custom_text[submit][message]': terms,
      mode: 'setup',
      customer: stripeCustomerId,
      'payment_method_types[0]': 'card',
      success_url: `${appBase}/card-saved?status=saved`,
      cancel_url: `${appBase}/card-saved?status=cancelled`,
      'metadata[dc_customer_id]': customer.id,
      'metadata[dc_job_id]': job.id,
      'setup_intent_data[metadata][dc_customer_id]': customer.id,
      'setup_intent_data[metadata][dc_job_id]': job.id,
    });
    if (!session.ok) return fail(502, 'stripe_error', `Stripe: ${session.message}`);

    return ok({ url: session.data.url, expires_at: session.data.expires_at });
  } catch (e) {
    return fail(500, 'unexpected', e instanceof Error ? e.message : 'Unexpected error.');
  }
});
