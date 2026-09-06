/**
 * twilio-voice-outbound — the TwiML App's Voice webhook: what Twilio does
 * when the app (browser SDK today, native SDK in Phase 4) dials out.
 *
 * The client called `device.connect({ params: { To, customerId, contactId } })`.
 * Twilio POSTs those params here along with `From=client:<identity>` and the
 * parent `CallSid`, and expects TwiML back. We answer with ONE thing: dial
 * the number, showing the DC Solar number as caller ID. No bridge leg — the
 * caller's audio is already on the line.
 *
 * SAME TWO GATES AS twilio-inbound: `?k=<TWILIO_WEBHOOK_SECRET>` (401) and a
 * valid `X-Twilio-Signature` (403), both constant-time. Without the
 * signature anyone who saw the URL could forge call records; with a forged
 * TwiML request they could also make the account dial arbitrary numbers,
 * which is billed to DC Solar.
 *
 * LOGGING. One `messages` row per call, channel 'call', keyed on the PARENT
 * CallSid (the client leg). The <Number> gets a statusCallback so the far
 * leg's outcome and duration reach twilio-status, which resolves the row via
 * ParentCallSid when the child SID is unknown.
 *
 * Deployed with verify_jwt FALSE. Secrets: TWILIO_AUTH_TOKEN,
 * TWILIO_WEBHOOK_SECRET, TWILIO_PUBLIC_BASE, TWILIO_FROM_NUMBER.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-twilio-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const COMPANY = 'dc-solar';
const E164_RE = /^\+[1-9]\d{7,14}$/;

function xml(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/xml; charset=utf-8', ...CORS_HEADERS },
  });
}

function fail(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ ok: false, code, error }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

function esc(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Spoken to the caller, then the call ends. Never a 5xx — Twilio would retry. */
function sayAndHangUp(message: string): Response {
  return xml(`<Response><Say voice="alice">${esc(message)}</Say><Hangup/></Response>`);
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function twilioSignature(
  authToken: string,
  url: string,
  params: [string, string][],
): Promise<string> {
  const sorted = [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let payload = url;
  for (const [key, value] of sorted) payload += key + value;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (E164_RE.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'POST only');

  try {
    const webhookSecret = Deno.env.get('TWILIO_WEBHOOK_SECRET');
    const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    const publicBase = Deno.env.get('TWILIO_PUBLIC_BASE');
    const fromNumber = Deno.env.get('TWILIO_FROM_NUMBER');
    if (!webhookSecret || !authToken || !publicBase || !fromNumber) {
      return fail(503, 'not_configured', 'Twilio is not connected yet. See docs/TWILIO_SETUP.md.');
    }

    // --- gate 1: the shared secret in the URL -------------------------------
    const url = new URL(req.url);
    if (!constantTimeEqual(url.searchParams.get('k') ?? '', webhookSecret)) {
      return fail(401, 'unauthorized', 'Bad or missing webhook key.');
    }

    const raw = await req.text();
    const form = new URLSearchParams(raw);
    const params: [string, string][] = [...form.entries()];

    // --- gate 2: the Twilio signature ---------------------------------------
    const given = req.headers.get('X-Twilio-Signature') ?? '';
    if (!given) return fail(403, 'forbidden', 'Missing X-Twilio-Signature.');
    const base = publicBase.replace(/\/+$/, '');
    const candidates = [
      `${base}/twilio-voice-outbound${url.search}`,
      `${base}/twilio-voice-outbound?k=${webhookSecret}`,
      `${base}/twilio-voice-outbound?k=${encodeURIComponent(webhookSecret)}`,
    ];
    let signatureOk = false;
    for (const candidate of candidates) {
      if (constantTimeEqual(await twilioSignature(authToken, candidate, params), given)) {
        signatureOk = true;
        break;
      }
    }
    if (!signatureOk) return fail(403, 'forbidden', 'Bad Twilio signature.');

    // --- from here on the request is genuinely Twilio ------------------------
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) return sayAndHangUp('The calling service is not available.');
    const admin = createClient(supabaseUrl, serviceKey);

    const callSid = form.get('CallSid');
    const fromClient = form.get('From') ?? '';
    const identity = fromClient.startsWith('client:') ? fromClient.slice('client:'.length) : null;
    const to = toE164(form.get('To') ?? '');
    if (!to) return sayAndHangUp('That is not a number we can dial.');
    if (!identity) return sayAndHangUp('This call did not come from the DC Solar app.');

    // Who is calling — the identity was minted from staff_profiles by
    // twilio-voice-token, so it maps straight back to an email.
    const { data: profile } = await admin
      .from('staff_profiles')
      .select('email')
      .eq('company', COMPANY)
      .eq('voice_identity', identity)
      .maybeSingle();
    const sentBy = (profile as { email?: string } | null)?.email ?? `client:${identity}`;

    // Who they are calling — trust the ids the app passed only if the number
    // matches, else file by number like twilio-call does.
    const claimedCustomer = form.get('customerId');
    const claimedContact = form.get('contactId');
    let customerId: string | null = null;
    let contactId: string | null = null;
    let who = to;

    if (claimedCustomer && UUID_RE.test(claimedCustomer)) {
      const { data } = await admin
        .from('customers')
        .select('id, name, phone_e164')
        .eq('id', claimedCustomer)
        .maybeSingle();
      const c = data as { id: string; name: string | null; phone_e164: string | null } | null;
      if (c && c.phone_e164 === to) {
        customerId = c.id;
        who = c.name ?? who;
      }
    }
    if (!customerId && claimedContact && UUID_RE.test(claimedContact)) {
      const { data } = await admin
        .from('contacts')
        .select('id, name, phone_e164')
        .eq('id', claimedContact)
        .maybeSingle();
      const k = data as { id: string; name: string | null; phone_e164: string | null } | null;
      if (k && k.phone_e164 === to) {
        contactId = k.id;
        who = k.name ?? who;
      }
    }
    if (!customerId && !contactId) {
      const { data: rows } = await admin
        .from('customers')
        .select('id, name')
        .eq('company', COMPANY)
        .eq('phone_e164', to)
        .order('created_at', { ascending: true })
        .limit(1);
      const match = (rows as { id: string; name: string | null }[] | null)?.[0];
      if (match) {
        customerId = match.id;
        who = match.name ?? who;
      } else {
        const { data: krows } = await admin
          .from('contacts')
          .select('id, name')
          .eq('company', COMPANY)
          .eq('phone_e164', to)
          .is('archived_at', null)
          .order('created_at', { ascending: true })
          .limit(1);
        const kmatch = (krows as { id: string; name: string | null }[] | null)?.[0];
        if (kmatch) {
          contactId = kmatch.id;
          who = kmatch.name ?? who;
        }
      }
    }

    // --- log it, keyed on the parent (client) CallSid --------------------------
    if (callSid) {
      await admin.from('messages').insert({
        company: COMPANY,
        customer_id: customerId,
        contact_id: contactId,
        channel: 'call',
        direction: 'out',
        from_number: fromNumber,
        to_number: to,
        body: `In-app call to ${who}`,
        status: 'in-progress',
        twilio_sid: callSid,
        sent_by: sentBy,
      });
    }

    // --- the dial ---------------------------------------------------------------
    // No <Say> — the person can hear the ringback and does not need narration.
    // statusCallback on the far leg: its completed event carries the duration
    // and the outcome (busy / no-answer / failed); twilio-status files it on
    // this row via ParentCallSid.
    const statusUrl = `${base}/twilio-status?k=${encodeURIComponent(webhookSecret)}`;
    const twiml =
      `<Response>` +
      `<Dial callerId="${esc(fromNumber)}" answerOnBridge="true" timeout="30">` +
      `<Number statusCallback="${esc(statusUrl)}" statusCallbackEvent="completed" statusCallbackMethod="POST">${esc(to)}</Number>` +
      `</Dial>` +
      `</Response>`;
    return xml(twiml);
  } catch (e) {
    console.error('twilio-voice-outbound failed', e);
    return sayAndHangUp('Something went wrong placing the call.');
  }
});
