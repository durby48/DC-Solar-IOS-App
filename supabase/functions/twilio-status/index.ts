/**
 * twilio-status — the delivery-receipt webhook for texts and bridge calls.
 *
 * Twilio calls this every time a message or call changes state: queued →
 * sending → sent → delivered, or ringing → in-progress → completed. It finds
 * the row by `messages.twilio_sid` (unique) and updates it. Nothing else.
 *
 * SAME TWO GATES AS twilio-inbound: `?k=<TWILIO_WEBHOOK_SECRET>` (401) and a
 * valid `X-Twilio-Signature` (403), both compared in constant time. A forged
 * status callback could mark an undelivered text "delivered", which is exactly
 * the fact somebody would later rely on in a dispute.
 *
 * AFTER THE GATES IT ALWAYS ANSWERS 204 — including for a SID it has never
 * seen. Twilio retries non-2xx responses with backoff, and a retry storm over
 * a status update we do not care about is worse than silently dropping it.
 * That also makes the endpoint idempotent: the same callback delivered twice
 * writes the same row twice with the same values.
 *
 * Deployed with verify_jwt FALSE. Secrets: TWILIO_AUTH_TOKEN,
 * TWILIO_WEBHOOK_SECRET, TWILIO_PUBLIC_BASE. See docs/TWILIO_SETUP.md.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-twilio-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function noContent(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function fail(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ ok: false, code, error }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
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

    const url = new URL(req.url);
    if (!constantTimeEqual(url.searchParams.get('k') ?? '', webhookSecret)) {
      return fail(401, 'unauthorized', 'Bad or missing webhook key.');
    }

    const raw = await req.text();
    const form = new URLSearchParams(raw);
    const params: [string, string][] = [...form.entries()];

    const given = req.headers.get('X-Twilio-Signature') ?? '';
    if (!given) return fail(403, 'forbidden', 'Missing X-Twilio-Signature.');

    const base = publicBase.replace(/\/+$/, '');
    const candidates = [
      `${base}/twilio-status${url.search}`,
      `${base}/twilio-status?k=${webhookSecret}`,
      `${base}/twilio-status?k=${encodeURIComponent(webhookSecret)}`,
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

    // --- the update ---------------------------------------------------------
    const sid = form.get('MessageSid') ?? form.get('SmsSid') ?? form.get('CallSid');
    const status = form.get('MessageStatus') ?? form.get('SmsStatus') ?? form.get('CallStatus');
    if (!sid) return noContent();

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) return noContent();
    const admin = createClient(supabaseUrl, serviceKey);

    const patch: Record<string, unknown> = {};
    if (status) patch.status = status;

    const errorCode = form.get('ErrorCode');
    if (errorCode) {
      patch.error_code = errorCode;
      // Twilio sends ErrorMessage only sometimes; the code is the durable part
      // and https://www.twilio.com/docs/api/errors/<code> explains it.
      patch.error = form.get('ErrorMessage') ?? `Twilio error ${errorCode}`;
    }

    const duration = form.get('CallDuration') ?? form.get('RecordingDuration');
    if (duration && Number.isFinite(Number(duration))) patch.duration_seconds = Number(duration);

    const recordingUrl = form.get('RecordingUrl');
    if (recordingUrl) patch.recording_url = recordingUrl;
    const recordingSid = form.get('RecordingSid');
    if (recordingSid) patch.recording_sid = recordingSid;

    if (Object.keys(patch).length === 0) return noContent();

    // No .single() and no error check on purpose: a SID we have never seen
    // (a call placed from the Twilio console, a message from another app on
    // the same account) updates zero rows and that is a success.
    await admin.from('messages').update(patch).eq('twilio_sid', sid);

    return noContent();
  } catch (e) {
    // Never 5xx: Twilio would retry, and a retry cannot fix a bug in here.
    console.error('twilio-status failed', e);
    return noContent();
  }
});
