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
 * Auth: verify_jwt ON plus a server-side role re-check — calling out on the
 * company number is an owner/operator thing, same as the bridge, and (since
 * 2026-10-05) a sales-rep thing: they call their prospects from the CRM.
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
  /** Twilio Push Credential (CR…) for the iOS VoIP certificate; enables incoming. */
  pushCredentialSid?: string;
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
        // Incoming calls (2026-09-08): allowed only when a Twilio Push
        // Credential exists for the iOS app's VoIP certificate — without
        // it a phone cannot be reached while the app is closed, and Twilio
        // refuses the registration anyway. `twilio-voice-inbound` rings the
        // registered identities and falls back to the owner's cell.
        incoming: { allow: Boolean(input.pushCredentialSid) },
        ...(input.pushCredentialSid ? { push_credential_sid: input.pushCredentialSid } : {}),
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

    // --- caller must be a company admin, or a sales rep (2026-10-05) -------
    // Sales reps call their prospects from the CRM. They dial out on the
    // company number until each rep has their own (voice_routes); nothing
    // else this function does is wider than placing a call.
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!jwt) return fail(401, 'unauthorized', 'Missing Authorization header.');
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    const realEmail = userData?.user?.email?.toLowerCase();
    if (userErr || !realEmail) return fail(401, 'unauthorized', 'Not signed in.');

    // Developer "view as" (2026-10-08): `{ devViewAs }` asks "could THIS
    // person make calls?" — the same checks, run as them, and an answer
    // instead of a token. Only a developer may ask.
    const body = (await req.json().catch(() => ({}))) as { devViewAs?: string };
    let callerEmail = realEmail;
    const { data: realRow } = await admin
      .from('employees')
      .select('is_developer')
      .eq('email', realEmail)
      .maybeSingle();
    const isDeveloper = Boolean((realRow as { is_developer?: boolean } | null)?.is_developer);
    if (body.devViewAs) {
      if (!isDeveloper) return fail(403, 'forbidden', 'Developers only.');
      callerEmail = body.devViewAs.toLowerCase();
    }
    const { data: employee } = await admin
      .from('employees')
      .select('role, display_name')
      .eq('email', callerEmail)
      .maybeSingle();
    const role = (employee as { role?: string } | null)?.role;
    const dryRunName = body.devViewAs
      ? ((employee as { display_name?: string | null } | null)?.display_name ?? callerEmail)
      : null;
    // A developer calling as themselves may call like an admin, whatever their role.
    if (
      role !== 'owner' && role !== 'operator' && role !== 'sales' && role !== 'sales_manager' &&
      !(isDeveloper && !body.devViewAs)
    ) {
      return fail(403, 'forbidden', 'Admins and sales only.');
    }

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

    if (dryRunName) {
      const { data: route } = await admin
        .from('voice_routes')
        .select('number_e164')
        .eq('company', COMPANY)
        .ilike('assigned_to', callerEmail)
        .limit(1);
      const line = ((route ?? []) as { number_e164: string }[])[0]?.number_e164 ?? null;
      return ok({
        dryRun: true,
        message: line
          ? `${dryRunName} can make calls, from their own line ${line}.`
          : `${dryRunName} can make calls, from the main DC Solar number (no line of their own yet).`,
      });
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

    const pushCredentialSid = Deno.env.get('TWILIO_PUSH_CREDENTIAL_SID') || undefined;
    const token = await mintToken({ accountSid, apiKeySid, apiKeySecret, appSid, identity, pushCredentialSid });
    return ok({ token, identity, ttl: TTL_SECONDS, incoming: Boolean(pushCredentialSid) });
  } catch (e) {
    return fail(500, 'server_error', e instanceof Error ? e.message : 'Token failed.');
  }
});
