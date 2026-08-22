/**
 * twilio-inbound — the webhook Twilio calls when someone texts the DC Solar
 * business number.
 *
 * WHY THIS EXISTS
 *
 * An inbound text is the only part of the comms platform nobody in the app can
 * trigger, so it is the only part that has to be reachable without a session.
 * That makes it the most exposed endpoint in the project and it is defended
 * twice over:
 *
 *   1. `?k=<TWILIO_WEBHOOK_SECRET>` — a shared secret in the URL Twilio was
 *      configured with. Wrong or missing → 401 before anything else happens.
 *   2. `X-Twilio-Signature` — HMAC-SHA1 over the exact request URL plus every
 *      POST parameter sorted by name and concatenated as key+value, keyed with
 *      the Twilio auth token, base64. Wrong → 403. This is the one that
 *      actually proves Twilio sent the request; the secret alone would let
 *      anyone who ever saw the URL forge a text from a customer.
 *
 * Both are compared in constant time. Neither is optional.
 *
 * WHAT IT DOES, IN ORDER
 *   • normalise From to E.164 and match it against customers.phone_e164, then
 *     leads.phone_e164 (unknown numbers still get a row — the inbox offers
 *     "Add as customer");
 *   • STOP / STOPALL / UNSUBSCRIBE / CANCEL / END / QUIT → stamp
 *     customers.sms_opt_out_at. START / UNSTOP / YES → clear it. Twilio's
 *     Advanced Opt-Out already answers those words for us, so we never reply
 *     to one ourselves;
 *   • insert the inbound `messages` row, including any MMS media URLs;
 *   • push the admins through the existing `notify` function;
 *   • outside business hours (America/Chicago) reply with the configured
 *     after-hours text as TwiML and log that reply as its own outbound row.
 *
 * Deployed with verify_jwt FALSE — Twilio does not carry a Supabase JWT.
 * Always answers Content-Type: text/xml, because anything else makes Twilio
 * log an error on the number.
 *
 * Secrets: TWILIO_AUTH_TOKEN, TWILIO_WEBHOOK_SECRET, TWILIO_PUBLIC_BASE,
 * NOTIFY_SECRET. See docs/TWILIO_SETUP.md.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-twilio-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const COMPANY = 'dc-solar';
const OPT_OUT_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke']);
const OPT_IN_WORDS = new Set(['start', 'unstop', 'yes']);
const TIME_ZONE = 'America/Chicago';

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

/** XML text escape — a customer name with an ampersand must not break TwiML. */
function esc(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Length-independent comparison so a wrong secret leaks no timing signal. */
function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * Twilio's request signature: HMAC-SHA1( authToken, url + Σ sorted(key + value) ),
 * base64. https://www.twilio.com/docs/usage/security#validating-requests
 */
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
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** "+18162742415" → "(816) 274-2415" for the push title. */
function prettyNumber(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** Minutes since midnight in Kansas City, whatever the server thinks the time is. */
function chicagoMinutes(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (hour % 24) * 60 + minute;
}

/** '07:00' / '07:00:00' → 420. Null when unparseable. */
function timeToMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = value.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'POST only');

  try {
    const webhookSecret = Deno.env.get('TWILIO_WEBHOOK_SECRET');
    const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    const publicBase = Deno.env.get('TWILIO_PUBLIC_BASE');
    if (!webhookSecret || !authToken || !publicBase) {
      return fail(
        503,
        'not_configured',
        'Twilio is not connected yet: this webhook needs TWILIO_WEBHOOK_SECRET, ' +
          'TWILIO_AUTH_TOKEN and TWILIO_PUBLIC_BASE. Steps are in docs/TWILIO_SETUP.md.',
      );
    }

    // --- gate 1: the shared secret in the URL -------------------------------
    const url = new URL(req.url);
    const k = url.searchParams.get('k') ?? '';
    if (!constantTimeEqual(k, webhookSecret)) {
      return fail(401, 'unauthorized', 'Bad or missing webhook key.');
    }

    // --- body ---------------------------------------------------------------
    const raw = await req.text();
    const form = new URLSearchParams(raw);
    const params: [string, string][] = [...form.entries()];

    // --- gate 2: the Twilio signature ---------------------------------------
    const given = req.headers.get('X-Twilio-Signature') ?? '';
    if (!given) return fail(403, 'forbidden', 'Missing X-Twilio-Signature.');

    const base = publicBase.replace(/\/+$/, '');
    // The signature is computed over the URL Twilio was configured with, which
    // is the public function URL — never req.url, whose host is the internal
    // gateway. url.search is used verbatim so the secret's own encoding cannot
    // shift the bytes; the encoded variant is tried as a fallback because
    // Twilio's console stores whatever was pasted into it.
    const candidates = [
      `${base}/twilio-inbound${url.search}`,
      `${base}/twilio-inbound?k=${webhookSecret}`,
      `${base}/twilio-inbound?k=${encodeURIComponent(webhookSecret)}`,
    ];
    let signatureOk = false;
    for (const candidate of candidates) {
      const expected = await twilioSignature(authToken, candidate, params);
      if (constantTimeEqual(expected, given)) {
        signatureOk = true;
        break;
      }
    }
    if (!signatureOk) return fail(403, 'forbidden', 'Bad Twilio signature.');

    // --- from here on the request is genuinely Twilio ------------------------
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      return fail(500, 'server_error', 'The function is missing its Supabase environment.');
    }
    const admin = createClient(supabaseUrl, serviceKey);

    const fromRaw = form.get('From') ?? '';
    const toRaw = form.get('To') ?? '';
    const bodyText = (form.get('Body') ?? '').trim();
    const messageSid = form.get('MessageSid') ?? form.get('SmsSid') ?? null;
    const from = toE164(fromRaw) ?? fromRaw;
    const to = toE164(toRaw) ?? toRaw;

    // MMS attachments arrive as MediaUrl0 … MediaUrlN.
    const mediaCount = Number(form.get('NumMedia') ?? '0');
    const mediaUrls: string[] = [];
    for (let i = 0; i < (Number.isFinite(mediaCount) ? mediaCount : 0); i++) {
      const mediaUrl = form.get(`MediaUrl${i}`);
      if (mediaUrl) mediaUrls.push(mediaUrl);
    }

    // --- who is this? --------------------------------------------------------
    let customerId: string | null = null;
    let leadId: string | null = null;
    let who = prettyNumber(from);

    const { data: custRow } = await admin
      .from('customers')
      .select('id, name')
      .eq('company', COMPANY)
      .eq('phone_e164', from)
      .limit(1)
      .maybeSingle();
    const customer = custRow as { id: string; name: string | null } | null;
    if (customer) {
      customerId = customer.id;
      who = customer.name ?? who;
    } else {
      const { data: leadRow } = await admin
        .from('leads')
        .select('id, name')
        .eq('company', COMPANY)
        .eq('phone_e164', from)
        .limit(1)
        .maybeSingle();
      const lead = leadRow as { id: string; name: string | null } | null;
      if (lead) {
        leadId = lead.id;
        who = lead.name ?? who;
      }
    }

    // --- consent -------------------------------------------------------------
    // The first word is what carriers look at, and it is what we look at too.
    const keyword = bodyText.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
    const isOptOut = OPT_OUT_WORDS.has(keyword);
    const isOptIn = OPT_IN_WORDS.has(keyword);

    if (customerId && isOptOut) {
      await admin
        .from('customers')
        .update({ sms_opt_out_at: new Date().toISOString() })
        .eq('id', customerId);
    } else if (customerId && isOptIn) {
      await admin
        .from('customers')
        .update({ sms_opt_out_at: null, sms_opt_in_source: 'sms-start-reply' })
        .eq('id', customerId);
    }

    // --- log it --------------------------------------------------------------
    await admin.from('messages').insert({
      company: COMPANY,
      customer_id: customerId,
      lead_id: leadId,
      channel: 'sms',
      direction: 'in',
      from_number: from,
      to_number: to,
      body: bodyText || (mediaUrls.length > 0 ? '(photo)' : ''),
      status: 'received',
      twilio_sid: messageSid,
      media_urls: mediaUrls.length > 0 ? mediaUrls : null,
    });

    // --- tell the admins -----------------------------------------------------
    // Reuses the existing notify function rather than re-implementing Expo
    // push fan-out; it already knows who the admins are and which devices
    // they carry.
    const notifySecret = Deno.env.get('NOTIFY_SECRET');
    if (notifySecret) {
      const preview = bodyText.length > 140 ? `${bodyText.slice(0, 139)}…` : bodyText;
      try {
        await fetch(`${supabaseUrl}/functions/v1/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-notify-secret': notifySecret },
          body: JSON.stringify({
            title: `💬 ${who}`,
            body: preview || (mediaUrls.length > 0 ? 'Sent a photo' : 'New text message'),
            audience: 'admins',
          }),
        });
      } catch {
        // A push that does not go out must never cost us the message row or
        // make Twilio retry the webhook.
      }
    }

    // --- after-hours auto-reply ---------------------------------------------
    // Never auto-reply to STOP/START: Twilio's Advanced Opt-Out already sends
    // the compliance confirmation, and a second text would be one too many.
    if (isOptOut || isOptIn) return xml('<Response/>');

    const { data: settingsRow } = await admin
      .from('comms_settings')
      .select('business_hours_start, business_hours_end, after_hours_autoreply, sms_enabled')
      .eq('company', COMPANY)
      .maybeSingle();
    const settings = settingsRow as {
      business_hours_start: string | null;
      business_hours_end: string | null;
      after_hours_autoreply: string | null;
      sms_enabled: boolean | null;
    } | null;

    const autoreply = settings?.after_hours_autoreply?.trim();
    const start = timeToMinutes(settings?.business_hours_start);
    const end = timeToMinutes(settings?.business_hours_end);
    if (!autoreply || start === null || end === null || !settings?.sms_enabled) {
      return xml('<Response/>');
    }

    const nowMinutes = chicagoMinutes(new Date());
    // Normal windows are start < end; a window that wraps midnight is handled
    // rather than assumed impossible.
    const openNow = start <= end
      ? nowMinutes >= start && nowMinutes < end
      : nowMinutes >= start || nowMinutes < end;
    if (openNow) return xml('<Response/>');

    // Log our own reply so the thread reads correctly in the app.
    await admin.from('messages').insert({
      company: COMPANY,
      customer_id: customerId,
      lead_id: leadId,
      channel: 'sms',
      direction: 'out',
      from_number: to,
      to_number: from,
      body: autoreply,
      status: 'sent',
      sent_by: 'after-hours-autoreply',
    });

    return xml(`<Response><Message>${esc(autoreply)}</Message></Response>`);
  } catch (e) {
    // Twilio retries on 5xx and would double-log the message. An empty TwiML
    // 200 loses the auto-reply on a bad day; a retry storm loses the thread.
    console.error('twilio-inbound failed', e);
    return xml('<Response/>');
  }
});
