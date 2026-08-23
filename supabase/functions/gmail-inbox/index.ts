/**
 * gmail-inbox — read-only Gmail for the two DC Solar Workspace mailboxes.
 *
 * WHY THIS IS A FUNCTION AND NOT A CLIENT LIBRARY
 *
 * Reading devon@dcsolarkc.com needs a Google Workspace SERVICE ACCOUNT with
 * domain-wide delegation. Its private key can impersonate every mailbox in
 * dcsolarkc.com, so it can never be in the app bundle — `EXPO_PUBLIC_*` is
 * public, and an OTA update ships the JS to anyone who opens the web app. The
 * key lives in one place only: this function's `GMAIL_SA_JSON` secret.
 *
 * THE MAILBOX IS CHOSEN HERE, NOT BY THE CALLER. `MAILBOXES` below maps an
 * APP identity (the Supabase account someone signs in with) to the ONE
 * Workspace mailbox that account may read. The client never names a mailbox
 * and cannot; if it could, Isaiah's session could ask for Devon's mail and the
 * delegation would happily grant it. An app identity with no entry gets 403
 * `no_mailbox` — that is the default for every employee.
 *
 * THREE GATES, IN ORDER. `verify_jwt` is TRUE (so an anonymous request never
 * reaches this code), the caller is then re-checked against `employees.role`
 * with the service role — same pattern as `invite-customer` — and only then is
 * the mailbox looked up. verify_jwt alone is not authorization: every customer
 * portal account also holds a valid JWT.
 *
 * SCOPE IS gmail.readonly AND THAT IS LOAD-BEARING. Google will not let this
 * token send, delete, label or archive anything, so the worst a bug here can
 * do is show mail to someone who is already an owner/operator of the company.
 * Do not widen the scope to add "reply" — the reply buttons in the app are
 * deep links that open Gmail, which is why they need no scope at all.
 *
 * ACTIONS (JSON body, `{action, …}`):
 *   list       {q?, pageToken?, label?, maxResults?}  → thread summaries
 *   thread     {threadId}                             → messages with bodies
 *   attachment {messageId, attachmentId, …}           → base64 file data
 *
 * NOTHING IS STORED. There is no table behind this; every response is passed
 * straight through from Google and forgotten. The only cached thing is the
 * Google access token, in module memory, for the few minutes an isolate lives.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * APP identity → Workspace mailbox. The whole authorization model of this
 * function is this constant. Adding a line here is the ONLY way to give
 * somebody an inbox, and the Google side must be delegated for that mailbox
 * too (see docs/GMAIL_INBOX_SETUP.md).
 */
const MAILBOXES: Record<string, string> = {
  'devonsd311@gmail.com': 'devon@dcsolarkc.com',
  'inettleton18@gmail.com': 'isaiah@dcsolarkc.com',
};

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Threads fetched per page. Each one costs a `threads.get`, so keep it small. */
const MAX_THREADS = 25;
/** Refuse to pipe anything bigger than this through the function. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Body caps — a marketing email can carry half a megabyte of HTML. */
const MAX_TEXT = 200_000;
const MAX_HTML = 400_000;

// Browser callers (app.dcsolarkc.com) preflight with OPTIONS — answer it and
// echo CORS on every response or the browser blocks the call. Same block as
// invite-customer; without it the web app's first request fails 405.
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
// Google auth: sign a service-account JWT, swap it for an access token
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
 * PEM → the ArrayBuffer `importKey('pkcs8', …)` wants.
 *
 * The key in the secret is the JSON file's `private_key`, so `JSON.parse` has
 * already turned its `\n` escapes into real newlines. Stripping ALL whitespace
 * (not just newlines) is deliberate — a key that has been through a YAML
 * editor or a copy-paste can arrive with stray spaces or CRLFs.
 */
function pkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '')
    .replace(/-----END [A-Z ]*PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  return bytesFromB64(body).buffer as ArrayBuffer;
}

/**
 * Access tokens, per mailbox, for as long as this isolate lives.
 *
 * Signing an RS256 assertion and round-tripping to Google costs a few hundred
 * milliseconds; a thread list makes 26 Gmail calls and must not pay it 26
 * times. Tokens last an hour, and this is plain module memory, so an isolate
 * recycling simply mints a new one.
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
    // Workspace admin has not delegated this client id for gmail.readonly.
    // Say so, because "401 from Google" sends the next person down a rabbit
    // hole in the wrong console.
    if (body.error === 'unauthorized_client') {
      throw new Error(
        'Google refused the delegation (unauthorized_client). In Google Admin → Security → ' +
          'API controls → Domain-wide delegation, add client id ' +
          `${sa.client_id ?? '(see the key file)'} with scope ${SCOPE}.`,
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

async function gmail<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${GMAIL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    throw new Error(
      `Gmail ${response.status}: ${detail?.error?.message ?? 'request failed'}`,
    );
  }
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Gmail payload shapes (only the fields this function reads)
// ---------------------------------------------------------------------------

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
}

interface GmailThread {
  id: string;
  historyId?: string;
  snippet?: string;
  messages?: GmailMessage[];
}

function header(message: GmailMessage, name: string): string {
  const wanted = name.toLowerCase();
  const found = (message.payload?.headers ?? []).find((h) => h.name.toLowerCase() === wanted);
  return found?.value ?? '';
}

/** `"Devon Durbin" <devon@dcsolarkc.com>` → `Devon Durbin`, else the address. */
function displayName(from: string): string {
  const quoted = from.match(/^\s*"?([^"<]*?)"?\s*</);
  const name = quoted?.[1]?.trim();
  if (name) return name;
  const address = from.match(/<([^>]+)>/)?.[1] ?? from;
  return address.trim().split('@')[0] || address.trim();
}

/** The bare address out of a From/To header, for the Gmail compose deep link. */
function bareAddress(value: string): string {
  return (value.match(/<([^>]+)>/)?.[1] ?? value).trim();
}

function isoDate(message: GmailMessage): string {
  const ms = Number(message.internalDate);
  if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  const parsed = Date.parse(header(message, 'Date'));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

// ---------------------------------------------------------------------------
// Body decoding
// ---------------------------------------------------------------------------

/** Decode one part's base64url body using the charset its headers declare. */
function decodePart(part: GmailPart): string {
  const data = part.body?.data;
  if (!data) return '';
  try {
    const contentType = (part.headers ?? []).find(
      (h) => h.name.toLowerCase() === 'content-type',
    )?.value;
    const charset = contentType?.match(/charset="?([\w-]+)"?/i)?.[1] ?? 'utf-8';
    const bytes = bytesFromB64(data);
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // An exotic or misspelled charset must not lose the message.
      return new TextDecoder('utf-8').decode(bytes);
    }
  } catch {
    return '';
  }
}

/**
 * HTML → readable plain text.
 *
 * `<script>` and `<style>` go first, CONTENTS AND ALL — a naive tag strip
 * would leave a page of CSS and JavaScript sitting in the message body. Block
 * elements become newlines so paragraphs survive, and the handful of entities
 * that actually show up in mail are decoded. This is a reader, not a renderer:
 * the app displays text, so anything left behind is noise, not markup.
 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Make HTML safe to hand to ANY renderer, on the assumption a future screen
 * will eventually put it in a WebView.
 *
 * Scripts, styles, iframes, objects and every `on*=` handler come out, along
 * with `javascript:` hrefs. The app itself only renders `bodyText`, so this is
 * belt and braces — but returning raw remote HTML from a mail reader is how a
 * tracking pixel becomes a script tag.
 */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '')
    .slice(0, MAX_HTML);
}

interface AttachmentInfo {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

interface WalkResult {
  text: string;
  html: string;
  attachments: AttachmentInfo[];
}

/**
 * Depth-first walk of one message's MIME tree.
 *
 * Collects the FIRST text/plain and the FIRST text/html (a `multipart/
 * alternative` carries both saying the same thing, and later parts are usually
 * quoted trails), plus every part that has an `attachmentId` — that id is
 * Gmail's handle for fetching the bytes, and only real files have one.
 */
function walk(part: GmailPart | undefined, into: WalkResult): void {
  if (!part) return;
  const mime = (part.mimeType ?? '').toLowerCase();

  if (part.body?.attachmentId && (part.filename ?? '').length > 0) {
    into.attachments.push({
      filename: part.filename ?? 'attachment',
      mimeType: part.mimeType ?? 'application/octet-stream',
      size: part.body.size ?? 0,
      attachmentId: part.body.attachmentId,
    });
  }

  if (mime === 'text/plain' && !into.text && !part.filename) {
    into.text = decodePart(part);
  } else if (mime === 'text/html' && !into.html && !part.filename) {
    into.html = decodePart(part);
  }

  for (const child of part.parts ?? []) walk(child, into);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Label = 'INBOX' | 'UNREAD' | 'STARRED';

function labelIds(label: Label): string[] {
  // UNREAD means "unread IN THE INBOX" — an unread message sitting in a
  // filtered-away label is not something Devon is looking for here.
  if (label === 'UNREAD') return ['INBOX', 'UNREAD'];
  if (label === 'STARRED') return ['STARRED'];
  return ['INBOX'];
}

async function listThreads(
  token: string,
  options: { q?: string; pageToken?: string; label: Label; maxResults: number },
) {
  const params = new URLSearchParams();
  params.set('maxResults', String(options.maxResults));
  for (const id of labelIds(options.label)) params.append('labelIds', id);
  if (options.q) params.set('q', options.q);
  if (options.pageToken) params.set('pageToken', options.pageToken);

  const page = await gmail<{
    threads?: { id: string; historyId?: string; snippet?: string }[];
    nextPageToken?: string;
  }>(`/threads?${params.toString()}`, token);

  const stubs = (page.threads ?? []).slice(0, MAX_THREADS);

  // One `threads.get` each, all at once. 25 parallel requests is well inside
  // Gmail's per-user rate limit and turns a 25-round-trip wait into one.
  const settled = await Promise.all(
    stubs.map(async (stub) => {
      try {
        const detail = await gmail<GmailThread>(
          `/threads/${stub.id}?format=metadata` +
            '&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date',
          token,
        );
        const messages = detail.messages ?? [];
        const newest = messages[messages.length - 1];
        if (!newest) return null;
        const labels = new Set(messages.flatMap((m) => m.labelIds ?? []));
        const from = header(newest, 'From');
        return {
          id: stub.id,
          historyId: detail.historyId ?? null,
          snippet: newest.snippet ?? stub.snippet ?? '',
          subject: header(newest, 'Subject') || '(no subject)',
          from,
          fromName: displayName(from),
          fromAddress: bareAddress(from),
          date: isoDate(newest),
          unread: labels.has('UNREAD'),
          starred: labels.has('STARRED'),
          messageCount: messages.length,
          // BEST-EFFORT PAPERCLIP. `format=metadata` returns headers only —
          // no `payload.parts` — so the real attachment list is unavailable
          // without pulling every full message (megabytes, per page). The
          // top-level MIME type is the cheap signal: a message carrying files
          // is `multipart/mixed` by construction. Opening the thread shows
          // the truth; this only decides whether a paperclip is drawn.
          hasAttachments: (newest.payload?.mimeType ?? '').toLowerCase() === 'multipart/mixed',
        };
      } catch {
        // One unreadable thread must not empty the whole inbox.
        return null;
      }
    }),
  );

  return {
    threads: settled.filter((t): t is NonNullable<typeof t> => t !== null),
    nextPageToken: page.nextPageToken ?? null,
  };
}

async function getThread(token: string, threadId: string) {
  const thread = await gmail<GmailThread>(`/threads/${threadId}?format=full`, token);
  const messages = (thread.messages ?? []).map((message) => {
    const found: WalkResult = { text: '', html: '', attachments: [] };
    walk(message.payload, found);

    const html = found.html ? sanitizeHtml(found.html) : '';
    // text/plain wins when it exists; otherwise the HTML is flattened. Both
    // paths end in TEXT, because that is what a React Native <Text> renders.
    const text = (found.text || (found.html ? htmlToText(found.html) : '')).slice(0, MAX_TEXT);
    const from = header(message, 'From');

    return {
      id: message.id,
      from,
      fromName: displayName(from),
      fromAddress: bareAddress(from),
      to: header(message, 'To'),
      cc: header(message, 'Cc'),
      date: isoDate(message),
      subject: header(message, 'Subject'),
      snippet: message.snippet ?? '',
      unread: (message.labelIds ?? []).includes('UNREAD'),
      bodyText: text,
      bodyHtml: html || null,
      attachments: found.attachments,
    };
  });

  return {
    id: thread.id,
    historyId: thread.historyId ?? null,
    subject: messages[0]?.subject || '(no subject)',
    messages,
  };
}

async function getAttachment(
  token: string,
  input: { messageId: string; attachmentId: string; mimeType?: string; filename?: string },
) {
  const body = await gmail<{ size?: number; data?: string }>(
    `/messages/${input.messageId}/attachments/${input.attachmentId}`,
    token,
  );
  if (!body.data) throw new Error('Gmail returned no data for that attachment.');
  const size = body.size ?? 0;
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `That attachment is ${Math.round(size / 1024 / 1024)} MB. Open it in Gmail instead.`,
    );
  }

  let mimeType = input.mimeType ?? '';
  let filename = input.filename ?? '';
  if (!mimeType || !filename) {
    // The attachments endpoint returns bytes and nothing else, so when the
    // client did not carry the name/type over from `thread`, go find them.
    try {
      const message = await gmail<GmailMessage>(
        `/messages/${input.messageId}?format=full`,
        token,
      );
      const found: WalkResult = { text: '', html: '', attachments: [] };
      walk(message.payload, found);
      const match = found.attachments.find((a) => a.attachmentId === input.attachmentId);
      mimeType = mimeType || match?.mimeType || 'application/octet-stream';
      filename = filename || match?.filename || 'attachment';
    } catch {
      mimeType = mimeType || 'application/octet-stream';
      filename = filename || 'attachment';
    }
  }

  // Gmail hands back base64URL. Normalise to standard base64 so the client can
  // decode it with one plain `atob`-shaped helper and no dialect check.
  const base64 = body.data.replace(/-/g, '+').replace(/_/g, '/');

  return { filename, mimeType, size, data: base64 };
}

// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceKey);

  // --- caller must be a company admin -------------------------------------
  // Identical to invite-customer. verify_jwt already proved the token is real;
  // this proves the person behind it is staff, not a portal customer.
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Missing Authorization header' }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const email = userData?.user?.email?.toLowerCase();
  if (userErr || !email) return json({ error: 'Not signed in' }, 401);

  const { data: employee } = await admin
    .from('employees')
    .select('role')
    .eq('email', email)
    .maybeSingle();
  const role = (employee as { role?: string } | null)?.role;
  if (role !== 'owner' && role !== 'operator') return json({ error: 'Admins only' }, 403);

  // --- which mailbox is this person allowed to read? -----------------------
  const mailbox = MAILBOXES[email];
  if (!mailbox) {
    return json(
      {
        error: 'no_mailbox',
        detail: `No Workspace mailbox is mapped to ${email}.`,
      },
      403,
    );
  }

  const sa = serviceAccount();
  if (!sa) {
    return json(
      {
        error: 'not_configured',
        detail: 'GMAIL_SA_JSON is not set on this function. See docs/GMAIL_INBOX_SETUP.md.',
      },
      503,
    );
  }

  // --- input ---------------------------------------------------------------
  let body: {
    action?: string;
    q?: string;
    pageToken?: string;
    label?: string;
    maxResults?: number;
    threadId?: string;
    messageId?: string;
    attachmentId?: string;
    mimeType?: string;
    filename?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  try {
    const token = await googleToken(mailbox, sa);

    switch (body.action) {
      case 'list': {
        const label: Label =
          body.label === 'UNREAD' || body.label === 'STARRED' ? body.label : 'INBOX';
        const maxResults = Math.min(
          MAX_THREADS,
          Math.max(1, Math.round(Number(body.maxResults) || MAX_THREADS)),
        );
        const result = await listThreads(token, {
          q: typeof body.q === 'string' && body.q.trim() ? body.q.trim() : undefined,
          pageToken: body.pageToken || undefined,
          label,
          maxResults,
        });
        return json({ ok: true, mailbox, label, ...result });
      }

      case 'thread': {
        if (!body.threadId) return json({ error: 'threadId is required' }, 400);
        const thread = await getThread(token, body.threadId);
        return json({ ok: true, mailbox, thread });
      }

      case 'attachment': {
        if (!body.messageId || !body.attachmentId) {
          return json({ error: 'messageId and attachmentId are required' }, 400);
        }
        const file = await getAttachment(token, {
          messageId: body.messageId,
          attachmentId: body.attachmentId,
          mimeType: body.mimeType,
          filename: body.filename,
        });
        return json({ ok: true, mailbox, ...file });
      }

      default:
        return json({ error: 'Unknown action. Use list, thread or attachment.' }, 400);
    }
  } catch (e) {
    // Google's own message is far more useful than "something went wrong" —
    // it is what tells the next person whether delegation, the key or the
    // mailbox is the problem. Nothing here can contain mail contents.
    return json({ error: e instanceof Error ? e.message : 'Gmail request failed.' }, 502);
  }
});
