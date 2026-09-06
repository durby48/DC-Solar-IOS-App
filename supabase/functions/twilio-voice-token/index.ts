/**
 * twilio-voice-token — mint a short-lived Twilio Access Token so the app can
 * place a call ITSELF (browser today via @twilio/voice-sdk; the native SDK is
 * Phase 4), from the DC Solar number, with no bridge leg.
 *
 * WHAT A VOICE ACCESS TOKEN IS. A JWT signed with a Twilio API KEY SECRET —
 * not the auth token, which never leaves the server for anything — carrying a
 * VoiceGrant that names the TwiML App Twilio should ask for instructions when
 * this client dials out. Twilio then POSTs to that app's Voice URL, which is
 * `twilio-voice-outbound` here, and that function returns the <Dial>.
 *
 * Auth: verify_jwt ON plus a server-side admin re-check — calling out on the
 * company number is an owner/operator thing, same as the bridge.
 *
 * IDENTITY comes from staff_profiles.voice_identity (set by trigger from the
 * email). The row is upserted here for a staff member who has never opened
 * Messages settings, so the first in-app call does not fail on a missing row.
 *
 * Secrets: TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID (SK…), TWILIO_API_KEY_SECRET,
 * TWILIO_TWIML_APP_SID (AP…). Until the last three exist this answers 503
 * `not_configured` and the app falls back to the bridge — that is the
 * expected state until Devon creates them (docs/TWILIO_SETUP.md § in-app).
 *
 * POST {} → { ok: true, token, identity, ttl }
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const COMPANY = 'dc-solar';
/** One hour. The SDK asks for a fresh one before it expires. */
const TTL_SECONDS = 3600;

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

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Twilio's access-token JWT, by hand: HS256, `cty: twilio-fpa;v=1`, `iss` the
 * API key SID, `sub` the account SID, grants keyed by product. No library —
 * Twilio's helper libraries pull in Node APIs Deno does not want.
 */
async function mintToken(input: {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  appSid: string;
  identity: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' };
  const payload = {
    jti: `${input.apiKeySid}-${now}`,
    iss: input.apiKeySid,
    sub: input.accountSid,
    nbf: now - 5,
    exp: now + TTL_SECONDS,
    grants: {
      identity: input.identity,
      voice: {
        // Outbound only. Incoming calls to the browser are Phase 4 work
        // (they need presence, ringing UI and a fallback to Devon's cell).
        incoming: { allow: false },
        outgoing: { application_sid: input.appSid },
      },
    },
  };
  const enc = new TextEncoder();
  const signingInput =
    base64url(enc.encode(JSON.stringify(header))) +
    '.' +
    base64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(input.apiKeySecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'POST only');

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      return fail(500, 'server_error', 'The function is missing its Supabase environment.');
    }
    const admin = createClient(supabaseUrl, serviceKey);

    // --- caller must be a company admin ------------------------------------
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!jwt) return fail(401, 'unauthorized', 'Missing Authorization header.');
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    const callerEmail = userData?.user?.email?.toLowerCase();
    if (userErr || !callerEmail) return fail(401, 'unauthorized', 'Not signed in.');
    const { data: employee } = await admin
      .from('employees')
      .select('role')
      .eq('email', callerEmail)
      .maybeSingle();
    const role = (employee as { role?: string } | null)?.role;
    if (role !== 'owner' && role !== 'operator') return fail(403, 'forbidden', 'Admins only.');

    // --- is calling on at all? ----------------------------------------------
    const { data: settingsRow } = await admin
      .from('comms_settings')
      .select('voice_enabled')
      .eq('company', COMPANY)
      .maybeSingle();
    if (!(settingsRow as { voice_enabled?: boolean } | null)?.voice_enabled) {
      return fail(
        503,
        'not_configured',
        'Calling from the DC Solar number is turned off. Switch "Calling" on in CRM settings.',
      );
    }

    const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const apiKeySid = Deno.env.get('TWILIO_API_KEY_SID');
    const apiKeySecret = Deno.env.get('TWILIO_API_KEY_SECRET');
    const appSid = Deno.env.get('TWILIO_TWIML_APP_SID');
    if (!accountSid || !apiKeySid || !apiKeySecret || !appSid) {
      return fail(
        503,
        'not_configured',
        'In-app calling is not set up yet: it needs TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET ' +
          'and TWILIO_TWIML_APP_SID on the edge functions. See docs/TWILIO_SETUP.md.',
      );
    }

    // --- identity: the staff_profiles slug, creating the row if needed ------
    const { data: profile } = await admin
      .from('staff_profiles')
      .select('voice_identity')
      .eq('company', COMPANY)
      .eq('email', callerEmail)
      .maybeSingle();
    let identity = (profile as { voice_identity?: string | null } | null)?.voice_identity ?? null;
    if (!identity) {
      // The trigger fills voice_identity on insert.
      const { data: inserted } = await admin
        .from('staff_profiles')
        .upsert({ company: COMPANY, email: callerEmail }, { onConflict: 'company,email' })
        .select('voice_identity')
        .maybeSingle();
      identity = (inserted as { voice_identity?: string | null } | null)?.voice_identity ?? null;
    }
    if (!identity) return fail(500, 'server_error', 'Could not assign a calling identity.');

    const token = await mintToken({ accountSid, apiKeySid, apiKeySecret, appSid, identity });
    return ok({ token, identity, ttl: TTL_SECONDS });
  } catch (e) {
    return fail(500, 'server_error', e instanceof Error ? e.message : 'Token failed.');
  }
});
