/**
 * stripe-webhook — Stripe tells DC Solar what happened (2026-10-05, B2).
 *
 * Registered in the Stripe dashboard (Developers → Webhooks) for:
 *   checkout.session.completed      a customer saved a card on the
 *                                   `stripe-card-link` page → "card on file"
 *                                   (brand + last 4) and that card becomes
 *                                   their default for the annual plan
 *   invoice.paid                    a plan payment went through → the
 *                                   customer's done-but-unpaid visit is Paid,
 *                                   its lead 'won', any flag cleared
 *   invoice.payment_failed          a plan payment failed (first charge or a
 *                                   renewal) → customers.payment_issue
 *   customer.subscription.created / .updated / .deleted
 *                                   → customers.plan_status
 *
 * VERIFIED, NOT TRUSTED. verify_jwt is OFF (Stripe has no Supabase JWT); every
 * request must carry a valid Stripe-Signature for STRIPE_WEBHOOK_SECRET, within
 * five minutes, or it is refused before anything is read.
 *
 * VERSION-PROOF. Records are found by the Stripe customer id
 * (customers.stripe_customer_id), never by where a given Stripe API version
 * happens to put the subscription on an invoice. Every write is idempotent:
 * Stripe retries, and `service-visit-done` may already have recorded the same
 * payment from its own response.
 *
 * Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const STRIPE_VERSION = '2024-06-20';
const TOLERANCE_SECONDS = 300;
const SERVICE_TYPES = ['Cleaning', 'Inspection'];

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time string compare (equal-length hex digests). */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Stripe's scheme: HMAC-SHA256 of `${t}.${raw body}`, compared to every v1. */
async function verify(raw: string, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const v1s = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || v1s.length === 0) return false;
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(age) || age > TOLERANCE_SECONDS) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${raw}`)));
  return v1s.some((v) => same(v, expected));
}

async function stripe(
  key: string,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown> | null> {
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
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });

  const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!secret || !stripeKey || !supabaseUrl || !serviceKey) return reply(500, { error: 'not configured' });

  const raw = await req.text();
  if (!(await verify(raw, req.headers.get('Stripe-Signature'), secret))) {
    return reply(400, { error: 'bad signature' });
  }

  const event = JSON.parse(raw) as { type: string; data: { object: Record<string, unknown> } };
  const obj = event.data.object;
  const admin = createClient(supabaseUrl, serviceKey);
  const stripeCustomer = typeof obj.customer === 'string' ? obj.customer : null;
  const now = new Date().toISOString();

  const findCustomer = async (): Promise<{ id: string } | null> => {
    if (!stripeCustomer) return null;
    const { data } = await admin.from('customers').select('id').eq('stripe_customer_id', stripeCustomer).maybeSingle();
    return (data as { id: string } | null) ?? null;
  };

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        if (obj.mode !== 'setup' || typeof obj.setup_intent !== 'string') break;
        const intent = await stripe(stripeKey, 'GET', `setup_intents/${obj.setup_intent}`, { 'expand[0]': 'payment_method' });
        const pm = intent?.payment_method as { id?: string; card?: { brand?: string; last4?: string } } | undefined;
        const customer = await findCustomer();
        if (!pm?.id || !customer || !stripeCustomer) break;
        // The saved card is the one the annual plan charges.
        await stripe(stripeKey, 'POST', `customers/${stripeCustomer}`, {
          'invoice_settings[default_payment_method]': pm.id,
        });
        await admin
          .from('customers')
          .update({
            card_on_file_at: now,
            card_brand: pm.card?.brand ?? null,
            card_last4: pm.card?.last4 ?? null,
            payment_issue: null,
            payment_issue_at: null,
          })
          .eq('id', customer.id);
        break;
      }

      case 'invoice.paid': {
        const customer = await findCustomer();
        if (!customer) break;
        await admin
          .from('customers')
          .update({ plan_status: 'active', payment_issue: null, payment_issue_at: null })
          .eq('id', customer.id);
        // The visit this payment is for: their most recent done, unpaid one.
        const { data: jobs } = await admin
          .from('jobs')
          .select('id')
          .eq('customer_id', customer.id)
          .in('job_type', SERVICE_TYPES)
          .eq('stage', 'Complete')
          .is('service_paid_at', null)
          .order('completed_on', { ascending: false })
          .limit(1);
        const job = (jobs as { id: string }[] | null)?.[0];
        if (job) {
          await admin
            .from('jobs')
            .update({ service_paid_at: now, stripe_invoice_id: typeof obj.id === 'string' ? obj.id : null })
            .eq('id', job.id)
            .is('service_paid_at', null);
          await admin.from('leads').update({ status: 'won' }).eq('converted_job_id', job.id).in('status', ['scheduled', 'visit_done']);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const customer = await findCustomer();
        if (!customer) break;
        const attempt = typeof obj.attempt_count === 'number' ? ` (attempt ${obj.attempt_count})` : '';
        await admin
          .from('customers')
          .update({ payment_issue: `Annual plan payment failed${attempt}. Update the card in Stripe.`, payment_issue_at: now })
          .eq('id', customer.id);
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const customer = await findCustomer();
        if (!customer) break;
        await admin
          .from('customers')
          .update({
            stripe_subscription_id: typeof obj.id === 'string' ? obj.id : null,
            plan_status: event.type === 'customer.subscription.deleted' ? 'canceled' : String(obj.status ?? ''),
          })
          .eq('id', customer.id);
        break;
      }

      default:
        break;
    }
  } catch (e) {
    // A 500 makes Stripe retry, which is what we want for a transient failure.
    return reply(500, { error: e instanceof Error ? e.message : 'unexpected' });
  }

  return reply(200, { received: true });
});
