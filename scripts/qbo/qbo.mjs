// QuickBooks Online helper for admin scripts run from a workstation (2026-10-14).
//
// Uses the SAME connection the app made (public.qbo_connections, written by the
// `qbo-oauth` edge function): reads it through the Supabase Management API with
// the personal access token, refreshes the access token when it is under five
// minutes from expiry, and writes the (possibly rotated) refresh token back so
// the app's connection keeps working.
//
// Secrets come from files outside the repo, never from git:
//   SUPABASE_PAT_FILE  (default C:\Durbin Enterprises\config\secrets\supabase-access-token.txt)
//   QBO_KEYS_FILE      (default C:\Durbin Enterprises\config\secrets\quickbooks.txt — QBO_PROD_CLIENT_ID / _SECRET)
//
// CLI:  node scripts/qbo/qbo.mjs get "companyinfo/<realm>"
//       node scripts/qbo/qbo.mjs query "select * from Account"
//       node scripts/qbo/qbo.mjs sql "select ..."          (Supabase SQL)

import { readFileSync } from 'node:fs';

const PROJECT = 'kjamxfezsathrsbztiln';
const COMPANY = 'dc-solar';
const MINOR = '75';
const PAT_FILE = process.env.SUPABASE_PAT_FILE ?? 'C:\\Durbin Enterprises\\config\\secrets\\supabase-access-token.txt';
const KEYS_FILE = process.env.QBO_KEYS_FILE ?? 'C:\\Durbin Enterprises\\config\\secrets\\quickbooks.txt';

const pat = readFileSync(PAT_FILE, 'utf8').match(/sbp_[A-Za-z0-9]+/)?.[0];
if (!pat) throw new Error(`No sbp_ token in ${PAT_FILE}`);
const keys = Object.fromEntries(
  readFileSync(KEYS_FILE, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.match(/^(QBO_[A-Z_]+)=(.+)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);

/** Run SQL as the database owner through the Management API. */
export async function sql(query) {
  // The Management API rate-limits (429); back off and retry rather than fail mid-sync.
  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const body = await res.json().catch(() => null);
    if (res.status === 429 && attempt < 8) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    if (!res.ok) throw new Error(`SQL ${res.status}: ${JSON.stringify(body)}`);
    return body;
  }
}

let conn = null;

async function connection() {
  if (!conn) {
    const rows = await sql(`select * from public.qbo_connections where company = ${lit(COMPANY)}`);
    if (!rows.length) throw new Error('QuickBooks is not connected (no qbo_connections row). Connect in the app first.');
    conn = rows[0];
  }
  if (new Date(conn.access_expires_at).getTime() - Date.now() > 5 * 60 * 1000) return conn;
  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${keys.QBO_PROD_CLIENT_ID}:${keys.QBO_PROD_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: conn.refresh_token }).toString(),
  });
  const t = await res.json();
  if (!res.ok) throw new Error(`Token refresh failed ${res.status}: ${JSON.stringify(t)}`);
  const now = Date.now();
  const access = new Date(now + t.expires_in * 1000).toISOString();
  const refreshExp = t.x_refresh_token_expires_in ? new Date(now + t.x_refresh_token_expires_in * 1000).toISOString() : null;
  await sql(`update public.qbo_connections set access_token = ${lit(t.access_token)}, refresh_token = ${lit(t.refresh_token)},
    access_expires_at = ${lit(access)}, refresh_expires_at = ${lit(refreshExp)}, updated_at = now() where company = ${lit(COMPANY)}`);
  conn = { ...conn, access_token: t.access_token, refresh_token: t.refresh_token, access_expires_at: access };
  return conn;
}

export async function realm() {
  return (await connection()).realm_id;
}

/** Call the QuickBooks Accounting API. `path` is relative to /v3/company/<realm>/. */
export async function qbo(method, path, body) {
  const c = await connection();
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`https://quickbooks.api.intuit.com/v3/company/${c.realm_id}/${path}${sep}minorversion=${MINOR}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.access_token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = data?.Fault?.Error?.[0];
    throw new Error(`QBO ${method} ${path} → ${res.status}: ${e ? `${e.Message} — ${e.Detail}` : JSON.stringify(data)}`);
  }
  return data;
}

/** Run a QBO query, following pagination. Returns the entity array. */
export async function query(q, entity) {
  const name = entity ?? q.match(/from\s+(\w+)/i)?.[1];
  const out = [];
  for (let start = 1; ; start += 1000) {
    const page = await qbo('GET', `query?query=${encodeURIComponent(`${q} startposition ${start} maxresults 1000`)}`);
    const rows = page.QueryResponse?.[name] ?? [];
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const [cmd, arg] = process.argv.slice(2);
  const run = {
    get: () => qbo('GET', arg.replace('<realm>', conn?.realm_id ?? '')),
    query: () => query(arg),
    sql: () => sql(arg),
  }[cmd];
  if (!run) {
    console.error('usage: node scripts/qbo/qbo.mjs get|query|sql "<arg>"');
    process.exit(1);
  }
  if (cmd === 'get' && arg.includes('<realm>')) {
    const r = await realm();
    console.log(JSON.stringify(await qbo('GET', arg.replace('<realm>', r)), null, 1));
  } else {
    console.log(JSON.stringify(await run(), null, 1));
  }
}
