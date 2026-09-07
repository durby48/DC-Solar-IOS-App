/**
 * gmail-send — send one plain-text email from the caller's OWN Workspace
 * mailbox, for the CRM's Email pane (Phase 7C, 2026-09-07).
 *
 * A SEPARATE FUNCTION FROM gmail-inbox, ON PURPOSE. gmail-inbox is
 * `gmail.readonly` and its header says never to widen that. This function
 * asks Google for a token with exactly one other scope, `gmail.send` —
 * it can send as the mapped mailbox and do nothing else: not read, not
 * delete, not label. The read path keeps its guarantee; this one has its
 * own, smaller one.
 *
 * SAME THREE GATES AS gmail-inbox: verify_jwt TRUE, then the caller is
 * re-checked against `employees.role` with the service role (a customer
 * portal account also holds a valid JWT), then the caller's APP identity is
 * mapped to the ONE mailbox it may send from. The client never names a
 * From address and cannot. Keep `MAILBOXES` identical to gmail-inbox's.
 *
 * WHAT GOOGLE MUST ALLOW. The domain-wide delegation grant for client id
 * 105976483744924526112 lists scopes; `gmail.send` has to be on that list
 * (docs/GMAIL_INBOX_SETUP.md, "Sending"). Until Devon adds it, Google
 * answers `unauthorized_client` and this function returns 503
 * `scope_missing` with the exact instruction — the app shows that sentence
 * rather than pretending it sent.
 *
 * NOTHING IS STORED HERE. The sent message lives in Gmail (Sent, and in the
 * thread when `threadId` is given), which is where gmail-inbox reads it back
 * from. There is no second copy to drift.
 *
 * ACTION (JSON body): `{ action: 'send', to, cc?, subject, text, threadId?,
 * inReplyTo?, references? }` → `{ ok, mailbox, id, threadId }`.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

/** APP identity → Workspace mailbox. MUST match gmail-inbox/index.ts. */
const MAILBOXES: Record<string, string> = {
  'devonsd311@gmail.com': 'devon@dcsolarkc.com',
  'inettleton18@gmail.com': 'isaiah@dcsolarkc.com',
};

const SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

const MAX_TEXT = 100_000;
const MAX_RECIPIENTS = 10;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ---------------------------------------------------------------------------
// Google auth (same shape as gmail-inbox; different scope)
// ---------------------------------------------------------------------------

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

function bytesFromB64(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function pkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '')
    .replace(/-----END [A-Z ]*PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  return bytesFromB64(body).buffer as ArrayBuffer;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

class ScopeMissing extends Error {}

async function googleToken(mailbox: string, sa: ServiceAccount): Promise<string> {
  const cached = tokenCache.get(mailbox);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const header = b64urlFromString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlFromString(
    JSON.stringify({ iss: sa.client_email, sub: mailbox, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
  );
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const assertion = `${signingInput}.${b64urlFromBytes(new Uint8Array(signature))}`;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token) {
    if (body.error === 'unauthorized_client') {
      throw new ScopeMissing(
        'Sending is not enabled yet. In Google Admin → Security → API controls → Domain-wide ' +
          `delegation, edit client id ${sa.client_id ?? '(see the key file)'} and add the scope ${SCOPE}.`,
      );
    }
    throw new Error(`Google token request failed: ${body.error ?? response.status} ${body.error_description ?? ''}`.trim());
  }
  tokenCache.set(mailbox, { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 });
  return body.access_token;
}

// ---------------------------------------------------------------------------
// Building the message
// ---------------------------------------------------------------------------

const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** "a@x.com, Bob <b@y.com>" → ["a@x.com", "Bob <b@y.com>"], every address validated. */
function parseRecipients(raw: string | undefined): string[] | null {
  if (!raw || !raw.trim()) return [];
  const parts = raw
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const part of parts) {
    const address = (part.match(/<([^>]+)>/)?.[1] ?? part).trim();
    if (!ADDRESS.test(address)) return null;
  }
  return parts;
}

/** RFC 2047 encode a header value when it is not plain ASCII. */
function headerValue(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ').trim();
  // deno-lint-ignore no-control-regex
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${b64FromString(clean)}?=`;
}

function buildRaw(input: {
  from: string;
  fromName: string | null;
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const lines: string[] = [];
  lines.push(`From: ${input.fromName ? `${headerValue(input.fromName)} <${input.from}>` : input.from}`);
  lines.push(`To: ${input.to.join(', ')}`);
  if (input.cc.length) lines.push(`Cc: ${input.cc.join(', ')}`);
  lines.push(`Subject: ${headerValue(input.subject)}`);
  if (input.inReplyTo) lines.push(`In-Reply-To: ${input.inReplyTo.replace(/[\r\n]+/g, ' ').trim()}`);
  if (input.references) lines.push(`References: ${input.references.replace(/[\r\n]+/g, ' ').trim()}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  // 76-column base64 body, the way every mail client wraps it.
  lines.push(b64FromString(input.text).replace(/(.{76})/g, '$1\r\n'));
  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Missing Authorization header' }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const email = userData?.user?.email?.toLowerCase();
  if (userErr || !email) return json({ error: 'Not signed in' }, 401);

  const { data: employee } = await admin
    .from('employees')
    .select('role, display_name')
    .eq('email', email)
    .maybeSingle();
  const row = employee as { role?: string; display_name?: string | null } | null;
  if (row?.role !== 'owner' && row?.role !== 'operator') return json({ error: 'Admins only' }, 403);

  const mailbox = MAILBOXES[email];
  if (!mailbox) return json({ error: 'no_mailbox', detail: `No Workspace mailbox is mapped to ${email}.` }, 403);

  const sa = serviceAccount();
  if (!sa) return json({ error: 'not_configured', detail: 'GMAIL_SA_JSON is not set on this function.' }, 503);

  let body: {
    action?: string;
    to?: string;
    cc?: string;
    subject?: string;
    text?: string;
    threadId?: string;
    inReplyTo?: string;
    references?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (body.action !== 'send') return json({ error: 'Unknown action. Use send.' }, 400);

  const to = parseRecipients(body.to);
  const cc = parseRecipients(body.cc);
  if (!to || to.length === 0) return json({ error: 'A valid To address is required.' }, 400);
  if (!cc) return json({ error: 'One of the Cc addresses is not valid.' }, 400);
  if (to.length + cc.length > MAX_RECIPIENTS) return json({ error: `At most ${MAX_RECIPIENTS} recipients.` }, 400);
  const subject = (body.subject ?? '').trim();
  const text = (body.text ?? '').replace(/\r\n/g, '\n').trim();
  if (!subject && !text) return json({ error: 'Write a subject or a message.' }, 400);
  if (text.length > MAX_TEXT) return json({ error: 'That message is too long.' }, 400);

  try {
    const token = await googleToken(mailbox, sa);
    const raw = b64urlFromBytes(
      new TextEncoder().encode(
        buildRaw({
          from: mailbox,
          fromName: row?.display_name?.trim() || null,
          to,
          cc,
          subject: subject || '(no subject)',
          text,
          inReplyTo: body.inReplyTo,
          references: body.references,
        }),
      ),
    );
    const response = await fetch(`${GMAIL}/messages/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body.threadId ? { raw, threadId: body.threadId } : { raw }),
    });
    const result = (await response.json().catch(() => null)) as
      | { id?: string; threadId?: string; error?: { message?: string } }
      | null;
    if (!response.ok || !result?.id) {
      return json({ error: `Gmail ${response.status}: ${result?.error?.message ?? 'send failed'}` }, 502);
    }
    return json({ ok: true, mailbox, id: result.id, threadId: result.threadId ?? body.threadId ?? null });
  } catch (e) {
    if (e instanceof ScopeMissing) return json({ error: 'scope_missing', detail: e.message }, 503);
    return json({ error: e instanceof Error ? e.message : 'Send failed.' }, 502);
  }
});
