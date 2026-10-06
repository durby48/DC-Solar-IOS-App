/**
 * voice-test-call — "Send me a test call" on rep Settings → Calling check
 * (2026-10-06).
 *
 * POST (no body) → { ok, number, away }
 *
 * Twilio places a real call TO the caller's own DC Solar number (their
 * voice_routes row) FROM another DC Solar number. That call arrives exactly
 * like a customer's would — through twilio-voice-inbound, ringing their app
 * and then their cell — so answering it proves the whole incoming path. When
 * they answer, a short message plays and the call ends. It is logged like any
 * incoming call.
 *
 * If Do not disturb is on and it is outside their hours, nothing will ring;
 * `away: true` says so (the call is still placed, so the path is exercised).
 *
 * Auth: verify_jwt ON; the caller must be an employee with a DC Solar number.
 * Secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const COMPANY = 'dc-solar';

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS_HEADERS } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return reply(405, { ok: false, code: 'method_not_allowed', error: 'POST only' });
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    const mainNumber = Deno.env.get('TWILIO_FROM_NUMBER');
    if (!supabaseUrl || !serviceKey || !accountSid || !authToken) {
      return reply(503, { ok: false, code: 'not_configured', error: 'Calling is not set up on the server.' });
    }
    const admin = createClient(supabaseUrl, serviceKey);

    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: userData } = await admin.auth.getUser(jwt);
    const email = userData?.user?.email?.toLowerCase();
    if (!email) return reply(401, { ok: false, code: 'unauthorized', error: 'Sign in first.' });
    const { data: employee } = await admin.from('employees').select('role').ilike('email', email).maybeSingle();
    if (!employee) return reply(403, { ok: false, code: 'forbidden', error: 'Staff only.' });

    const { data: routes } = await admin.from('voice_routes').select('number_e164, assigned_to').eq('company', COMPANY);
    const all = (routes ?? []) as { number_e164: string; assigned_to: string }[];
    const mine = all.find((r) => r.assigned_to.toLowerCase() === email)?.number_e164;
    if (!mine) {
      return reply(409, { ok: false, code: 'no_number', error: 'You do not have a DC Solar number yet — ask an admin.' });
    }
    // Calling a number from itself is refused by carriers; use another of ours.
    const from = [mainNumber, ...all.map((r) => r.number_e164)].find((n) => n && n !== mine);
    if (!from) return reply(409, { ok: false, code: 'no_from', error: 'DC Solar needs a second number to place a test call.' });

    const { data: profile } = await admin
      .from('staff_profiles')
      .select('dnd_enabled, work_start, work_end')
      .eq('company', COMPANY)
      .eq('email', email)
      .maybeSingle();
    const p = profile as { dnd_enabled?: boolean; work_start?: string; work_end?: string } | null;
    const nowHm = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false });
    const away = Boolean(p?.dnd_enabled) && (nowHm < (p?.work_start ?? '08:00').slice(0, 5) || nowHm >= (p?.work_end ?? '19:00').slice(0, 5));

    const twiml =
      '<Response><Pause length="1"/><Say voice="alice">This is your DC Solar test call. ' +
      'Your phone is set up to receive calls. Goodbye.</Say></Response>';
    const form = new URLSearchParams({ To: mine, From: from, Twiml: twiml, Timeout: '60' });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { message?: string };
      return reply(502, { ok: false, code: 'twilio_error', error: `Twilio: ${err.message ?? res.status}` });
    }
    return reply(200, { ok: true, number: mine, away });
  } catch (e) {
    return reply(500, { ok: false, code: 'unexpected', error: e instanceof Error ? e.message : 'Unexpected error.' });
  }
});
