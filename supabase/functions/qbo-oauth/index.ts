/**
 * qbo-oauth — connects the company's QuickBooks Online books (2026-10-14).
 *
 * Two kinds of caller:
 *
 *   An admin in the app (POST, signed in):
 *     { action: 'start' }      → { ok, url }  Intuit's consent page. The admin
 *                                 approves there; nothing is connected until then.
 *     { action: 'status' }     → { ok, connected, company_name, offering_sku,
 *                                 realm_id, environment, connected_by, connected_at }
 *                                 Makes one live call (CompanyInfo), so "connected"
 *                                 means QuickBooks answered, not just that a row exists.
 *     { action: 'disconnect' } → { ok }  Revokes the tokens at Intuit and forgets them.
 *
 *   Intuit's redirect (GET ?code&state&realmId, or ?error) after the consent
 *   page: checks `state` against qbo_oauth_states, swaps the code for tokens,
 *   reads the company's name and plan, saves qbo_connections, and sends the
 *   browser to app.dcsolarkc.com/quickbooks?connected=1 (or ?error=…).
 *
 * The redirect carries no Supabase login, so verify_jwt is OFF and the POST
 * actions check the caller themselves (owner / operator / developer).
 *
 * Tokens live only in qbo_connections, which no app role can read (RLS, no
 * policies). Access tokens last an hour and are refreshed here when needed;
 * Intuit may hand back a new refresh token on every refresh, so it is saved
 * each time.
 *
 * Secrets: QBO_CLIENT_ID, QBO_CLIENT_SECRET (the Intuit app's keys),
 * QBO_ENV ('production' | 'sandbox', default production), optional
 * QBO_REDIRECT_URI (default this function's URL) and APP_PUBLIC_BASE
 * (default https://app.dcsolarkc.com).
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const SCOPE = 'com.intuit.quickbooks.accounting';
const MINOR_VERSION = '75';
/** How long a Connect press stays valid before Intuit must redirect back. */
const STATE_TTL_MS = 30 * 60 * 1000;

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

type Env = {
  supabaseUrl: string;
  serviceKey: string;
  clientId: string;
  clientSecret: string;
  environment: 'production' | 'sandbox';
  apiBase: string;
  redirectUri: string;
  appBase: string;
};

function readEnv(): Env | string {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const clientId = Deno.env.get('QBO_CLIENT_ID');
  const clientSecret = Deno.env.get('QBO_CLIENT_SECRET');
  if (!supabaseUrl || !serviceKey) return 'Server is missing its Supabase settings.';
  if (!clientId || !clientSecret) return 'QuickBooks keys are not set (QBO_CLIENT_ID / QBO_CLIENT_SECRET).';
  const environment = Deno.env.get('QBO_ENV') === 'sandbox' ? 'sandbox' : 'production';
  return {
    supabaseUrl,
    serviceKey,
    clientId,
    clientSecret,
    environment,
    apiBase: environment === 'sandbox'
      ? 'https://sandbox-quickbooks.api.intuit.com'
      : 'https://quickbooks.api.intuit.com',
    redirectUri: Deno.env.get('QBO_REDIRECT_URI') ?? `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/qbo-oauth`,
    appBase: (Deno.env.get('APP_PUBLIC_BASE') ?? 'https://app.dcsolarkc.com').replace(/\/+$/, ''),
  };
}

type TokenSet = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
};

/** Intuit's token endpoint: form body, Basic auth with the app's keys. */
async function tokenCall(
  env: Env,
  params: Record<string, string>,
): Promise<{ ok: true; tokens: TokenSet } | { ok: false; status: number; error: string }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.clientId}:${env.clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(params).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== 'string') {
    return { ok: false, status: res.status, error: String(data.error_description ?? data.error ?? `Intuit returned ${res.status}`) };
  }
  return { ok: true, tokens: data as unknown as TokenSet };
}

function expiryRow(tokens: TokenSet) {
  const now = Date.now();
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    access_expires_at: new Date(now + tokens.expires_in * 1000).toISOString(),
    refresh_expires_at: tokens.x_refresh_token_expires_in
      ? new Date(now + tokens.x_refresh_token_expires_in * 1000).toISOString()
      : null,
    updated_at: new Date(now).toISOString(),
  };
}

type Connection = {
  company: string;
  realm_id: string;
  environment: string;
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
  company_name: string | null;
  offering_sku: string | null;
  connected_by: string | null;
  connected_at: string;
};

/**
 * A usable access token for this company, refreshing it when it has under five
 * minutes left. `null` with a reason when there is no connection, or Intuit
 * refused the refresh (the owner disconnected the app in QuickBooks, or the
 * refresh token expired) — then the dead row is removed so the app shows
 * "not connected" instead of failing forever.
 */
async function liveConnection(
  env: Env,
  admin: SupabaseClient,
  company: string,
): Promise<{ conn: Connection } | { conn: null; reason: string }> {
  const { data } = await admin.from('qbo_connections').select('*').eq('company', company).maybeSingle();
  const conn = data as Connection | null;
  if (!conn) return { conn: null, reason: 'not_connected' };
  if (new Date(conn.access_expires_at).getTime() - Date.now() > 5 * 60 * 1000) return { conn };

  const refreshed = await tokenCall(env, { grant_type: 'refresh_token', refresh_token: conn.refresh_token });
  if (!refreshed.ok) {
    if (refreshed.status === 400 || refreshed.status === 401) {
      await admin.from('qbo_connections').delete().eq('company', company);
      return { conn: null, reason: `QuickBooks refused the saved login (${refreshed.error}). Connect again.` };
    }
    return { conn: null, reason: `Could not refresh the QuickBooks login: ${refreshed.error}` };
  }
  const patch = expiryRow(refreshed.tokens);
  await admin.from('qbo_connections').update(patch).eq('company', company);
  return { conn: { ...conn, ...patch } };
}

/** GET one QuickBooks resource. */
async function qboGet(
  env: Env,
  conn: Pick<Connection, 'realm_id' | 'access_token'>,
  path: string,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${env.apiBase}/v3/company/${conn.realm_id}/${path}${sep}minorversion=${MINOR_VERSION}`, {
    headers: { Authorization: `Bearer ${conn.access_token}`, Accept: 'application/json' },
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const fault = (data.Fault as { Error?: { Message?: string; Detail?: string }[] } | undefined)?.Error?.[0];
    return { ok: false, status: res.status, error: fault?.Detail ?? fault?.Message ?? `QuickBooks returned ${res.status}` };
  }
  return { ok: true, data };
}

/** Company name + plan ("QuickBooks Online Plus") from CompanyInfo. */
async function companyInfo(
  env: Env,
  conn: Pick<Connection, 'realm_id' | 'access_token'>,
): Promise<{ ok: true; name: string | null; sku: string | null } | { ok: false; error: string }> {
  const res = await qboGet(env, conn, `companyinfo/${conn.realm_id}`);
  if (!res.ok) return { ok: false, error: res.error };
  const info = res.data.CompanyInfo as
    | { CompanyName?: string; NameValue?: { Name?: string; Value?: string }[] }
    | undefined;
  const sku = info?.NameValue?.find((nv) => nv.Name === 'OfferingSku')?.Value ?? null;
  return { ok: true, name: info?.CompanyName ?? null, sku };
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

// ---------------------------------------------------------------------------
// Intuit's redirect back after the consent page
// ---------------------------------------------------------------------------
async function handleCallback(env: Env, url: URL): Promise<Response> {
  // %20, not URLSearchParams' "+": the app's router decodes with
  // decodeURIComponent, which would leave the plus signs in the message.
  const back = (params: Record<string, string>) =>
    redirect(
      `${env.appBase}/quickbooks?${Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&')}`,
    );

  const admin = createClient(env.supabaseUrl, env.serviceKey);
  const state = url.searchParams.get('state') ?? '';
  const { data: stateRow } = state
    ? await admin.from('qbo_oauth_states').select('*').eq('state', state).maybeSingle()
    : { data: null };
  if (state) await admin.from('qbo_oauth_states').delete().eq('state', state);

  const intuitError = url.searchParams.get('error');
  if (intuitError) {
    return back({ error: intuitError === 'access_denied' ? 'You cancelled on the QuickBooks page.' : `QuickBooks said: ${intuitError}` });
  }
  if (!stateRow) return back({ error: 'That connect link was not started from the app. Press Connect again.' });
  if (Date.now() - new Date(stateRow.created_at as string).getTime() > STATE_TTL_MS) {
    return back({ error: 'That connect link expired. Press Connect again.' });
  }

  const code = url.searchParams.get('code');
  const realmId = url.searchParams.get('realmId');
  if (!code || !realmId) return back({ error: 'QuickBooks did not send back a company. Press Connect again.' });

  const exchanged = await tokenCall(env, { grant_type: 'authorization_code', code, redirect_uri: env.redirectUri });
  if (!exchanged.ok) return back({ error: `QuickBooks refused the login: ${exchanged.error}` });

  const info = await companyInfo(env, { realm_id: realmId, access_token: exchanged.tokens.access_token });

  const { error: saveErr } = await admin.from('qbo_connections').upsert({
    company: stateRow.company as string,
    realm_id: realmId,
    environment: env.environment,
    ...expiryRow(exchanged.tokens),
    company_name: info.ok ? info.name : null,
    offering_sku: info.ok ? info.sku : null,
    connected_by: stateRow.email as string,
    connected_at: new Date().toISOString(),
  });
  if (saveErr) return back({ error: `Connected, but the app could not save it: ${saveErr.message}` });

  return back({ connected: '1' });
}

// ---------------------------------------------------------------------------
// The app's admin actions
// ---------------------------------------------------------------------------
async function handleAction(env: Env, req: Request): Promise<Response> {
  const admin = createClient(env.supabaseUrl, env.serviceKey);

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return fail(401, 'unauthorized', 'Missing Authorization header.');
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const callerEmail = userData?.user?.email?.toLowerCase();
  if (userErr || !callerEmail) return fail(401, 'unauthorized', 'Not signed in.');
  const { data: employee } = await admin
    .from('employees')
    .select('is_developer, role, company')
    .eq('email', callerEmail)
    .maybeSingle();
  const emp = employee as { is_developer?: boolean; role?: string; company?: string } | null;
  // A developer (employees.is_developer) may do anything an owner may.
  const role = emp?.is_developer ? 'owner' : emp?.role;
  if (role !== 'owner' && role !== 'operator') return fail(403, 'forbidden', 'Only an administrator can manage QuickBooks.');
  const company = emp?.company ?? 'dc-solar';

  const body = (await req.json().catch(() => ({}))) as { action?: string };

  if (body.action === 'start') {
    const state = crypto.randomUUID();
    // Forget presses that never came back.
    await admin.from('qbo_oauth_states').delete().lt('created_at', new Date(Date.now() - STATE_TTL_MS).toISOString());
    const { error } = await admin.from('qbo_oauth_states').insert({ state, company, email: callerEmail });
    if (error) return fail(500, 'save_failed', `Could not start: ${error.message}`);
    const url = `${AUTHORIZE_URL}?${new URLSearchParams({
      client_id: env.clientId,
      response_type: 'code',
      scope: SCOPE,
      redirect_uri: env.redirectUri,
      state,
    }).toString()}`;
    return ok({ url });
  }

  if (body.action === 'status') {
    const live = await liveConnection(env, admin, company);
    if (!live.conn) {
      return ok({ connected: false, reason: live.reason === 'not_connected' ? null : live.reason, environment: env.environment });
    }
    const info = await companyInfo(env, live.conn);
    if (!info.ok) {
      return ok({
        connected: false,
        reason: `Saved, but QuickBooks did not answer: ${info.error}`,
        company_name: live.conn.company_name,
        environment: live.conn.environment,
      });
    }
    // Keep the name and plan current (an upgrade to Plus shows up here).
    if (info.name !== live.conn.company_name || info.sku !== live.conn.offering_sku) {
      await admin.from('qbo_connections').update({ company_name: info.name, offering_sku: info.sku }).eq('company', company);
    }
    return ok({
      connected: true,
      company_name: info.name,
      offering_sku: info.sku,
      realm_id: live.conn.realm_id,
      environment: live.conn.environment,
      connected_by: live.conn.connected_by,
      connected_at: live.conn.connected_at,
    });
  }

  if (body.action === 'disconnect') {
    const { data } = await admin.from('qbo_connections').select('refresh_token').eq('company', company).maybeSingle();
    const refreshToken = (data as { refresh_token?: string } | null)?.refresh_token;
    if (refreshToken) {
      // Best effort: even if Intuit is unreachable, the app forgets the tokens.
      await fetch(REVOKE_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${env.clientId}:${env.clientSecret}`)}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ token: refreshToken }),
      }).catch(() => null);
    }
    await admin.from('qbo_connections').delete().eq('company', company);
    return ok({});
  }

  return fail(400, 'bad_request', "action must be 'start', 'status' or 'disconnect'.");
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  const env = readEnv();
  if (typeof env === 'string') return fail(500, 'not_configured', env);
  try {
    if (req.method === 'GET') return await handleCallback(env, new URL(req.url));
    if (req.method === 'POST') return await handleAction(env, req);
    return fail(405, 'method_not_allowed', 'GET or POST only');
  } catch (e) {
    return fail(500, 'unexpected', e instanceof Error ? e.message : 'Unexpected error.');
  }
});
