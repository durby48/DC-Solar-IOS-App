/**
 * crm-email-watch (2026-11-08) — a push when a CUSTOMER or LEAD emails one
 * of the two DC Solar mailboxes.
 *
 * gmail-inbox stores nothing (it reads Gmail live), so nothing could notice
 * a reply arriving. This runs from cron (`crm-email-watch`, every 5 min, via
 * public.crm_email_watch_call()) with the NOTIFY_SECRET header, lists inbox
 * mail newer than the last run per mailbox, keeps only messages FROM an
 * email address on a lead or customer, and hands each one to `notify`
 * (recipient = the app identity that owns the mailbox; target = the Gmail
 * thread; deduped by Gmail message id). Bodies are never read or logged —
 * From and Subject headers and Gmail's snippet only.
 *
 * The first run per mailbox only records "now" (no flood of old mail).
 * State: public.crm_email_watch (service role only).
 *
 * Deploy with verify_jwt OFF (cron has no user); the shared secret gates it.
 * Shares GMAIL_SA_JSON and the delegation with gmail-inbox.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

/** MUST match gmail-inbox's MAILBOXES: app identity → Workspace mailbox. */
const MAILBOXES: Record<string, string> = {
  'devonsd311@gmail.com': 'devon@dcsolarkc.com',
  'inettleton18@gmail.com': 'isaiah@dcsolarkc.com',
};

const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const COMPANY = 'dc-solar';
const MAX_PER_RUN = 25;

class ScopeMissing extends Error {}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
  client_id?: string;
}

function serviceAccount(): ServiceAccount | null {
  const raw = Deno.env.get('GMAIL_SA_JSON');
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ServiceAccount;
    if (!parsed?.client_email || !parsed?.private_key) return null;
    return parsed;
  } catch {
    // A truncated or shell-mangled secret is "not configured", not a 500 —
    // the setup doc is the fix, and the app says so.
    return null;
  }
}

function b64urlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlFromString(text: string): string {
  return b64urlFromBytes(new TextEncoder().encode(text));
}

function b64FromString(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** base64 / base64url → bytes. Gmail hands back base64url; `atob` wants neither. */
function bytesFromB64(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * PEM → the ArrayBuffer `importKey('pkcs8', …)` wants. Stripping ALL
 * whitespace is deliberate — a key that has been through a YAML editor or a
 * copy-paste can arrive with stray spaces or CRLFs.
 */
function pkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '')
    .replace(/-----END [A-Z ]*PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  return bytesFromB64(body).buffer as ArrayBuffer;
}

/**
 * Access tokens, per mailbox, for as long as this isolate lives. Signing an
 * RS256 assertion and round-tripping to Google costs a few hundred
 * milliseconds; a thread list makes 26 Gmail calls and must not pay it 26
 * times. Tokens last an hour; an isolate recycling simply mints a new one.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function googleToken(mailbox: string, sa: ServiceAccount): Promise<string> {
  const cached = tokenCache.get(mailbox);
  // 60s of slack so a token never expires mid-`Promise.all`.
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const header = b64urlFromString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlFromString(
    JSON.stringify({
      iss: sa.client_email,
      // `sub` is the impersonation: this is what domain-wide delegation grants
      // and what makes `users/me` mean the employee's mailbox.
      sub: mailbox,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );
  const assertion = `${signingInput}.${b64urlFromBytes(new Uint8Array(signature))}`;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !body.access_token) {
    // `unauthorized_client` here means one thing and only one thing: the
    // Workspace admin has not delegated this client id for gmail.modify.
    if (body.error === 'unauthorized_client') {
      throw new ScopeMissing(
        'Email is not fully switched on yet. In Google Admin → Security → API controls → ' +
          `Domain-wide delegation, edit client id ${sa.client_id ?? '(see the key file)'} and set ` +
          `its scope to ${SCOPE}.`,
      );
    }
    throw new Error(
      `Google token request failed: ${body.error ?? response.status} ${body.error_description ?? ''}`.trim(),
    );
  }

  tokenCache.set(mailbox, {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  });
  return body.access_token;
}

/** One Gmail REST call. `init.body` is JSON-encoded when it is an object. */
async function gmail<T>(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${GMAIL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(`Gmail ${response.status}: ${detail?.error?.message ?? 'request failed'}`);
  }
  // DELETE answers 204 with an empty body.
  if (response.status === 204) return {} as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}


interface GmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] };
}

function headerOf(m: GmailMessage, name: string): string {
  return m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function bareAddress(value: string): string {
  const m = value.match(/<([^>]+)>/);
  return (m ? m[1] : value).trim().toLowerCase();
}

function displayName(value: string): string {
  const m = value.match(/^\s*"?([^"<]+?)"?\s*</);
  return (m ? m[1] : bareAddress(value)).trim();
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const secret = Deno.env.get('NOTIFY_SECRET');
  if (!secret || req.headers.get('x-notify-secret') !== secret) return json({ error: 'bad secret' }, 401);

  const sa = serviceAccount();
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!sa || !url || !key) return json({ error: 'not configured' }, 503);
  const admin = createClient(url, key);

  const report: Record<string, unknown>[] = [];
  for (const [identity, mailbox] of Object.entries(MAILBOXES)) {
    try {
      const { data: state } = await admin.from('crm_email_watch').select('last_seen_ms').eq('mailbox', mailbox).maybeSingle();
      const now = Date.now();
      const lastSeen = Number((state as { last_seen_ms?: number } | null)?.last_seen_ms ?? 0);
      if (!lastSeen) {
        await admin.from('crm_email_watch').upsert({ mailbox, last_seen_ms: now, updated_at: new Date().toISOString() });
        report.push({ mailbox, baseline: true });
        continue;
      }

      const token = await googleToken(mailbox, sa);
      // Gmail's `after:` is whole seconds; re-checking the boundary second is
      // harmless — notify dedupes by message id.
      const q = `in:inbox -from:me after:${Math.floor(lastSeen / 1000) - 1}`;
      const list = await gmail<{ messages?: { id: string }[] }>(
        `/messages?maxResults=${MAX_PER_RUN}&q=${encodeURIComponent(q)}`,
        token,
      );
      let newest = lastSeen;
      let pushed = 0;
      for (const { id } of list.messages ?? []) {
        const m = await gmail<GmailMessage>(
          `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
          token,
        );
        const at = Number(m.internalDate ?? 0);
        if (!at || at <= lastSeen) continue;
        newest = Math.max(newest, at);
        const from = headerOf(m, 'From');
        const address = bareAddress(from);
        if (!address.includes('@')) continue;

        // Only people in the CRM: a lead or a customer with this address.
        const [{ data: customer }, { data: lead }] = await Promise.all([
          admin.from('customers').select('id, name').eq('company', COMPANY).ilike('email', address).limit(1).maybeSingle(),
          admin.from('leads').select('id, name').eq('company', COMPANY).is('removed_at', null).ilike('email', address).limit(1).maybeSingle(),
        ]);
        const person = (customer ?? lead) as { id: string; name?: string | null } | null;
        if (!person) continue;

        const subject = headerOf(m, 'Subject') || '(no subject)';
        const name = person.name?.trim() || displayName(from);
        await fetch(`${url}/functions/v1/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-notify-secret': secret },
          body: JSON.stringify({
            title: `✉️ ${truncate(name, 60)}`,
            body: truncate(`${subject} — ${m.snippet ?? ''}`, 200),
            emails: [identity],
            target: m.threadId ? { type: 'email_thread', threadId: m.threadId } : { type: 'inbox' },
            dedupe: `email:${m.id}`,
            source: 'crm-email-watch',
          }),
        }).catch(() => {});
        pushed += 1;
      }
      await admin
        .from('crm_email_watch')
        .upsert({ mailbox, last_seen_ms: Math.max(newest, lastSeen), updated_at: new Date().toISOString() });
      report.push({ mailbox, checked: list.messages?.length ?? 0, pushed });
    } catch (e) {
      // Never leak details: the mailbox name and the error class only.
      console.error('crm-email-watch', mailbox, e instanceof Error ? e.message : String(e));
      report.push({ mailbox, error: e instanceof ScopeMissing ? 'scope_missing' : 'failed' });
    }
  }
  console.log(JSON.stringify({ crmEmailWatch: report }));
  return json({ report });
});
