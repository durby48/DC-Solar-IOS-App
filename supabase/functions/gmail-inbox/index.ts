/**
 * gmail-inbox — the app's whole Gmail surface for the two DC Solar Workspace
 * mailboxes: read, search, star, archive, trash, label, draft and send.
 *
 * v10 (2026-09-12): ONE FUNCTION, ONE SCOPE. Until now reading lived here
 * under `gmail.readonly` and sending in `gmail-send` under `gmail.send`. The
 * owner asked for "a full ported view of Gmail" — write, compose, draft,
 * sort, organise — and every one of those is a *mutation* of the mailbox, so
 * this function now asks Google for `gmail.modify`, which covers all of it
 * (read, send, drafts, labels, archive, trash; NOT permanent delete and NOT
 * settings). `gmail-send` stays deployed for older JS bundles and asks for
 * the same scope; the app itself calls `send` here.
 *
 * WHY THIS IS A FUNCTION AND NOT A CLIENT LIBRARY
 *
 * Reaching devon@dcsolarkc.com needs a Google Workspace SERVICE ACCOUNT with
 * domain-wide delegation. Its private key can impersonate every mailbox in
 * dcsolarkc.com, so it can never be in the app bundle — `EXPO_PUBLIC_*` is
 * public, and an OTA update ships the JS to anyone who opens the web app. The
 * key lives in one place only: this function's `GMAIL_SA_JSON` secret.
 *
 * THE MAILBOX IS CHOSEN HERE, NOT BY THE CALLER. `MAILBOXES` below maps an
 * APP identity (the Supabase account someone signs in with) to the ONE
 * Workspace mailbox that account may touch. The client never names a mailbox
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
 * SCOPE IS gmail.modify, AND IT IS GRANTED IN GOOGLE ADMIN, NOT HERE. The
 * domain-wide delegation entry for client id 105976483744924526112 must list
 * `https://www.googleapis.com/auth/gmail.modify` (docs/GMAIL_INBOX_SETUP.md).
 * Until it does, Google answers `unauthorized_client` and this function
 * returns `503 scope_missing` with the exact instruction — the app prints that
 * sentence rather than pretending. No action here can permanently delete
 * mail: `trash` is Gmail's Trash, recoverable for 30 days.
 *
 * ACTIONS (JSON body, `{action, …}`). Anything not on this list is refused.
 *
 *   list          {folder?, label?, q?, pageToken?, maxResults?}   → thread summaries
 *                 folder: inbox | unread | starred | sent | drafts | archive | trash
 *                         | spam | all | label:<labelId>   (label: legacy INBOX/UNREAD/STARRED/ALL)
 *   labels        {}                                             → system + custom labels, unread counts
 *   thread        {threadId, html?}                              → messages with text bodies (+ sanitized HTML on request)
 *   attachment    {messageId, attachmentId, mimeType?, filename?} → base64 file data (≤10 MB)
 *   modify        {threadIds[], addLabelIds?[], removeLabelIds?[]} → star/unstar, read/unread,
 *                 archive (remove INBOX), unarchive (add INBOX), trash/untrash, apply/remove a label
 *   draft.list    {pageToken?, maxResults?}                      → draft summaries (with draftId)
 *   draft.get     {draftId}                                      → the draft's fields, for editing
 *   draft.create  {to?, cc?, bcc?, subject?, text?, threadId?, inReplyTo?, references?} → {draftId, messageId, threadId}
 *   draft.update  {draftId, …same fields…}                       → {draftId, messageId, threadId}
 *   draft.delete  {draftId}                                      → {deleted: true}
 *   draft.send    {draftId}                                      → {id, threadId}
 *   send          {to, cc?, bcc?, subject, text, threadId?, inReplyTo?, references?} → {id, threadId}
 *   label.create  {name}                                         → the new label
 *
 * Messages are built server-side as RFC 5322 text/plain. Every recipient is
 * validated and every display name REBUILT and quoted — never passed through
 * — and CRLF is stripped from every header value, so nothing a caller types
 * can smuggle a second header (the 2026-09-11 fix, kept).
 *
 * NOTHING IS STORED, NOTHING IS LOGGED. There is no table behind this; every
 * response is passed straight through from Google and forgotten. Bodies are
 * never written to the log. Lists carry snippets only; bodies come back from
 * `thread` and `draft.get` alone. The only cached thing is the Google access
 * token, in module memory, for the few minutes an isolate lives.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

/**
 * APP identity → Workspace mailbox. The whole authorization model of this
 * function is this constant. Adding a line here is the ONLY way to give
 * somebody a mailbox (see docs/GMAIL_INBOX_SETUP.md, "Adding a third
 * mailbox"). MUST stay identical to the copy in gmail-send/index.ts.
 */
const MAILBOXES: Record<string, string> = {
  'devonsd311@gmail.com': 'devon@dcsolarkc.com',
  'inettleton18@gmail.com': 'isaiah@dcsolarkc.com',
};

const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

/** Threads fetched per page by default. Each one costs a `threads.get`, so keep it small. */
const DEFAULT_THREADS = 25;
const MAX_THREADS = 50;
/** Threads one `modify` call may touch. */
const MAX_MODIFY = 50;
/** Labels whose unread counts are fetched (one `labels.get` each). */
const MAX_LABEL_COUNTS = 40;
/** Refuse to pipe anything bigger than this through the function. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Body caps — a marketing email can carry half a megabyte of HTML. */
const MAX_TEXT = 200_000;
const MAX_HTML = 400_000;
/** Outbound caps. */
const MAX_SEND_TEXT = 100_000;
const MAX_RECIPIENTS = 30;

// Browser callers (app.dcsolarkc.com) preflight with OPTIONS — answer it and
// echo CORS on every response or the browser blocks the call.
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

/** A 400 the client can print verbatim. */
class BadRequest extends Error {}
/** Google refused the delegation for SCOPE — the Workspace admin step is missing. */
class ScopeMissing extends Error {}

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

interface GmailDraft {
  id: string;
  message?: GmailMessage;
}

interface GmailLabel {
  id: string;
  name: string;
  type?: 'system' | 'user';
  messageListVisibility?: string;
  labelListVisibility?: string;
  messagesTotal?: number;
  messagesUnread?: number;
  threadsTotal?: number;
  threadsUnread?: number;
  color?: { textColor?: string; backgroundColor?: string };
}

function header(message: GmailMessage | undefined, name: string): string {
  if (!message) return '';
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

/** The bare address out of a From/To header. */
function bareAddress(value: string): string {
  return (value.match(/<([^>]+)>/)?.[1] ?? value).trim();
}

/** "A <a@x>, B <b@y>" → "A, B" for a Sent-folder row. */
function displayNames(list: string): string {
  return list
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map(displayName)
    .join(', ');
}

function isoDate(message: GmailMessage | undefined): string {
  if (!message) return '';
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
 * HTML → readable plain text. `<script>` and `<style>` go first, CONTENTS AND
 * ALL; block elements become newlines so paragraphs survive; the handful of
 * entities that actually show up in mail are decoded.
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
 * Make HTML safe to hand to a renderer. Scripts, styles, iframes, objects,
 * forms and every `on*=` handler come out, along with `javascript:` hrefs.
 * Remote images are neutralised too (`src` → `data-src`) so opening a message
 * in a future HTML view fires no tracking pixel. Only returned when the caller
 * asks (`html: true`); the default is text.
 */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '')
    .replace(/<base[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/(<img\b[^>]*?)\ssrc=/gi, '$1 data-src=')
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
 * Depth-first walk of one message's MIME tree. Collects the FIRST text/plain
 * and the FIRST text/html, plus every part that has an `attachmentId`.
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

/** Text body of one full-format message, decoded (text/plain first, else flattened HTML). */
function bodyOf(message: GmailMessage): { text: string; html: string; attachments: AttachmentInfo[] } {
  const found: WalkResult = { text: '', html: '', attachments: [] };
  walk(message.payload, found);
  const text = (found.text || (found.html ? htmlToText(found.html) : '')).slice(0, MAX_TEXT);
  return { text, html: found.html, attachments: found.attachments };
}

// ---------------------------------------------------------------------------
// Building an outbound message (shared by send and the draft actions)
// ---------------------------------------------------------------------------

const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const LABEL_ID = /^[A-Za-z0-9_\-]{1,100}$/;

/**
 * "a@x.com, Bob <b@y.com>" → ["a@x.com", "\"Bob\" <b@y.com>"], every address
 * validated and every display name REBUILT — never passed through. A display
 * name containing a CRLF could otherwise smuggle a Bcc: header. Returns null
 * when any part is not an address, so the caller can say which field.
 */
function parseRecipients(raw: unknown): string[] | null {
  if (raw == null || raw === '') return [];
  if (typeof raw !== 'string') return null;
  if (!raw.trim()) return [];
  const parts = raw
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const bracket = part.match(/^(.*?)<([^<>]+)>\s*$/);
    const address = (bracket ? bracket[2] : part).trim();
    if (!ADDRESS.test(address)) return null;
    const name = bracket
      ? bracket[1]
          .replace(/[\r\n"\\]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      : '';
    out.push(name ? `${headerValue(`"${name}"`)} <${address}>` : address);
  }
  return out;
}

/** RFC 2047 encode a header value when it is not plain ASCII; CRLF always stripped. */
function headerValue(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ').trim();
  // deno-lint-ignore no-control-regex
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${b64FromString(clean)}?=`;
}

/** Message-ID header values are `<…>` tokens; anything else is dropped. */
function messageIds(value: unknown): string {
  if (typeof value !== 'string') return '';
  const ids = value.match(/<[^<>\s]+>/g) ?? [];
  return ids.join(' ');
}

interface OutboundInput {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  threadId?: string;
  inReplyTo: string;
  references: string;
}

function buildRaw(input: OutboundInput & { from: string; fromName: string | null }): string {
  const lines: string[] = [];
  // The display name is quoted (a comma in "Durbin, Devon" would otherwise
  // split the mailbox) and any quote/backslash inside it dropped.
  const fromName = input.fromName?.replace(/["\\\r\n]/g, '').trim();
  lines.push(`From: ${fromName ? `${headerValue(`"${fromName}"`)} <${input.from}>` : input.from}`);
  if (input.to.length) lines.push(`To: ${input.to.join(', ')}`);
  if (input.cc.length) lines.push(`Cc: ${input.cc.join(', ')}`);
  // Gmail strips Bcc from the delivered copies itself; it only needs to see it here.
  if (input.bcc.length) lines.push(`Bcc: ${input.bcc.join(', ')}`);
  lines.push(`Subject: ${headerValue(input.subject)}`);
  if (input.inReplyTo) lines.push(`In-Reply-To: ${input.inReplyTo}`);
  if (input.references) lines.push(`References: ${input.references}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('Content-Transfer-Encoding: base64');
  lines.push('');
  // 76-column base64 body, the way every mail client wraps it.
  lines.push(b64FromString(input.text).replace(/(.{76})/g, '$1\r\n'));
  return lines.join('\r\n');
}

/**
 * Validate the fields of a send / draft body. Drafts may be empty and
 * unaddressed (Gmail keeps them that way too); a send must have a recipient
 * and either a subject or a body.
 */
function outboundInput(body: Record<string, unknown>, mode: 'send' | 'draft'): OutboundInput {
  const to = parseRecipients(body.to);
  const cc = parseRecipients(body.cc);
  const bcc = parseRecipients(body.bcc);
  if (!to) throw new BadRequest('One of the To addresses is not valid.');
  if (!cc) throw new BadRequest('One of the Cc addresses is not valid.');
  if (!bcc) throw new BadRequest('One of the Bcc addresses is not valid.');
  if (mode === 'send' && to.length === 0) throw new BadRequest('A valid To address is required.');
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
    throw new BadRequest(`At most ${MAX_RECIPIENTS} recipients.`);
  }
  const subject = typeof body.subject === 'string' ? body.subject.replace(/[\r\n]+/g, ' ').trim() : '';
  const text = typeof body.text === 'string' ? body.text.replace(/\r\n/g, '\n') : '';
  if (mode === 'send' && !subject && !text.trim()) throw new BadRequest('Write a subject or a message.');
  if (text.length > MAX_SEND_TEXT) throw new BadRequest('That message is too long.');
  const threadId = typeof body.threadId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.threadId) ? body.threadId : undefined;
  return {
    to,
    cc,
    bcc,
    subject: subject || (mode === 'send' ? '(no subject)' : ''),
    text: mode === 'send' ? text.trim() : text,
    threadId,
    inReplyTo: messageIds(body.inReplyTo),
    references: messageIds(body.references),
  };
}

// ---------------------------------------------------------------------------
// Actions: reading
// ---------------------------------------------------------------------------

type Folder =
  | { kind: 'inbox' }
  | { kind: 'unread' }
  | { kind: 'starred' }
  | { kind: 'sent' }
  | { kind: 'drafts' }
  | { kind: 'archive' }
  | { kind: 'trash' }
  | { kind: 'spam' }
  | { kind: 'all' }
  | { kind: 'label'; id: string };

/** `folder` (new) or `label` (legacy INBOX/UNREAD/STARRED/ALL) → one Folder. Unknown → inbox. */
function parseFolder(body: { folder?: unknown; label?: unknown }): Folder {
  const raw = typeof body.folder === 'string' ? body.folder.trim() : '';
  if (raw) {
    const lower = raw.toLowerCase();
    if (lower.startsWith('label:')) {
      const id = raw.slice('label:'.length).trim();
      if (LABEL_ID.test(id)) return { kind: 'label', id };
      throw new BadRequest('That label id is not valid.');
    }
    switch (lower) {
      case 'inbox':
      case 'unread':
      case 'starred':
      case 'sent':
      case 'drafts':
      case 'archive':
      case 'trash':
      case 'spam':
      case 'all':
        return { kind: lower };
      default:
        throw new BadRequest('Unknown folder.');
    }
  }
  const legacy = typeof body.label === 'string' ? body.label : '';
  if (legacy === 'UNREAD') return { kind: 'unread' };
  if (legacy === 'STARRED') return { kind: 'starred' };
  if (legacy === 'ALL') return { kind: 'all' };
  return { kind: 'inbox' };
}

function folderKey(folder: Folder): string {
  return folder.kind === 'label' ? `label:${folder.id}` : folder.kind;
}

/** Label filter + extra query + spam/trash flag for `threads.list`. */
function folderQuery(folder: Folder): { labelIds: string[]; q: string; includeSpamTrash: boolean } {
  switch (folder.kind) {
    case 'inbox':
      return { labelIds: ['INBOX'], q: '', includeSpamTrash: false };
    case 'unread':
      // "unread IN THE INBOX" — an unread message in a filtered-away label is
      // not what somebody opening Unread is looking for.
      return { labelIds: ['INBOX', 'UNREAD'], q: '', includeSpamTrash: false };
    case 'starred':
      return { labelIds: ['STARRED'], q: '', includeSpamTrash: false };
    case 'sent':
      return { labelIds: ['SENT'], q: '', includeSpamTrash: false };
    case 'drafts':
      return { labelIds: ['DRAFT'], q: '', includeSpamTrash: false };
    case 'archive':
      // Gmail's "All mail" minus what is still in the inbox, i.e. archived
      // conversations. Drafts are their own folder.
      return { labelIds: [], q: '-in:inbox -in:drafts', includeSpamTrash: false };
    case 'trash':
      return { labelIds: ['TRASH'], q: '', includeSpamTrash: true };
    case 'spam':
      return { labelIds: ['SPAM'], q: '', includeSpamTrash: true };
    case 'all':
      // No label filter — the CRM asks for "everything with this address",
      // and half of that is in Sent.
      return { labelIds: [], q: '', includeSpamTrash: false };
    case 'label':
      return { labelIds: [folder.id], q: '', includeSpamTrash: false };
  }
}

interface ThreadSummary {
  id: string;
  historyId: string | null;
  snippet: string;
  subject: string;
  from: string;
  fromName: string;
  fromAddress: string;
  to: string;
  toNames: string;
  date: string;
  unread: boolean;
  starred: boolean;
  inInbox: boolean;
  inTrash: boolean;
  isDraft: boolean;
  draftId: string | null;
  messageCount: number;
  hasAttachments: boolean;
  labelIds: string[];
}

function summarise(
  id: string,
  detail: GmailThread,
  stubSnippet: string | undefined,
): ThreadSummary | null {
  const messages = detail.messages ?? [];
  const newest = messages[messages.length - 1];
  if (!newest) return null;
  const labels = new Set(messages.flatMap((m) => m.labelIds ?? []));
  const from = header(newest, 'From');
  const to = header(newest, 'To');
  return {
    id,
    historyId: detail.historyId ?? null,
    snippet: newest.snippet ?? stubSnippet ?? '',
    subject: header(newest, 'Subject') || header(messages[0], 'Subject') || '(no subject)',
    from,
    fromName: displayName(from),
    fromAddress: bareAddress(from),
    to,
    toNames: displayNames(to),
    date: isoDate(newest),
    unread: labels.has('UNREAD'),
    starred: labels.has('STARRED'),
    inInbox: labels.has('INBOX'),
    inTrash: labels.has('TRASH'),
    isDraft: labels.has('DRAFT'),
    draftId: null,
    messageCount: messages.length,
    // BEST-EFFORT PAPERCLIP. `format=metadata` returns headers only — no
    // `payload.parts` — so the top-level MIME type is the cheap signal: a
    // message carrying files is `multipart/mixed` by construction.
    hasAttachments: messages.some(
      (m) => (m.payload?.mimeType ?? '').toLowerCase() === 'multipart/mixed',
    ),
    labelIds: [...labels].sort(),
  };
}

const METADATA_HEADERS =
  '&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date';

async function listThreads(
  token: string,
  options: { folder: Folder; q?: string; pageToken?: string; maxResults: number },
) {
  if (options.folder.kind === 'drafts') {
    // Drafts are their own resource: the list must carry the draftId the
    // composer edits by, and `threads.list` cannot give it.
    const drafts = await listDrafts(token, { pageToken: options.pageToken, maxResults: options.maxResults });
    return { threads: drafts.drafts, nextPageToken: drafts.nextPageToken };
  }

  const spec = folderQuery(options.folder);
  const params = new URLSearchParams();
  params.set('maxResults', String(options.maxResults));
  for (const id of spec.labelIds) params.append('labelIds', id);
  const q = [spec.q, options.q ?? ''].filter(Boolean).join(' ').trim();
  if (q) params.set('q', q);
  if (spec.includeSpamTrash) params.set('includeSpamTrash', 'true');
  if (options.pageToken) params.set('pageToken', options.pageToken);

  const page = await gmail<{
    threads?: { id: string; historyId?: string; snippet?: string }[];
    nextPageToken?: string;
    resultSizeEstimate?: number;
  }>(`/threads?${params.toString()}`, token);

  const stubs = (page.threads ?? []).slice(0, MAX_THREADS);

  // One `threads.get` each, all at once. 25 parallel requests is well inside
  // Gmail's per-user rate limit and turns a 25-round-trip wait into one.
  const settled = await Promise.all(
    stubs.map(async (stub) => {
      try {
        const detail = await gmail<GmailThread>(
          `/threads/${stub.id}?format=metadata${METADATA_HEADERS}`,
          token,
        );
        return summarise(stub.id, detail, stub.snippet);
      } catch {
        // One unreadable thread must not empty the whole inbox.
        return null;
      }
    }),
  );

  return {
    threads: settled.filter((t): t is ThreadSummary => t !== null),
    nextPageToken: page.nextPageToken ?? null,
    resultSizeEstimate: page.resultSizeEstimate ?? null,
  };
}

/** Every label, system and custom, with unread counts where Gmail keeps them. */
async function listLabels(token: string) {
  const page = await gmail<{ labels?: GmailLabel[] }>('/labels', token);
  const labels = page.labels ?? [];
  // `labels.list` returns names only; counts come from `labels.get`. Fetch
  // them for the folders the rail shows and every custom label, capped.
  const wanted = labels
    .filter((l) => l.type === 'user' || ['INBOX', 'STARRED', 'DRAFT', 'SPAM', 'TRASH', 'SENT'].includes(l.id))
    .slice(0, MAX_LABEL_COUNTS);
  const counts = new Map<string, GmailLabel>();
  await Promise.all(
    wanted.map(async (l) => {
      try {
        counts.set(l.id, await gmail<GmailLabel>(`/labels/${encodeURIComponent(l.id)}`, token));
      } catch {
        // A count is decoration; a missing one must not fail the rail.
      }
    }),
  );
  return labels
    .filter((l) => {
      // Hide the labels Gmail itself hides in its sidebar (CATEGORY_*, CHAT,
      // IMPORTANT, UNREAD…), keep the real folders and every custom label.
      if (l.type === 'user') return true;
      return ['INBOX', 'STARRED', 'SENT', 'DRAFT', 'SPAM', 'TRASH'].includes(l.id);
    })
    .map((l) => {
      const c = counts.get(l.id);
      return {
        id: l.id,
        name: l.name,
        type: l.type ?? 'user',
        threadsUnread: c?.threadsUnread ?? null,
        threadsTotal: c?.threadsTotal ?? null,
        color: l.color?.backgroundColor ?? null,
        textColor: l.color?.textColor ?? null,
      };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'system' ? -1 : 1));
}

async function getThread(token: string, threadId: string, wantHtml: boolean) {
  const thread = await gmail<GmailThread>(`/threads/${encodeURIComponent(threadId)}?format=full`, token);
  const messages = (thread.messages ?? []).map((message) => {
    const decoded = bodyOf(message);
    const from = header(message, 'From');
    const labels = message.labelIds ?? [];
    return {
      id: message.id,
      from,
      fromName: displayName(from),
      fromAddress: bareAddress(from),
      to: header(message, 'To'),
      cc: header(message, 'Cc'),
      bcc: header(message, 'Bcc'),
      date: isoDate(message),
      subject: header(message, 'Subject'),
      snippet: message.snippet ?? '',
      unread: labels.includes('UNREAD'),
      starred: labels.includes('STARRED'),
      // Gmail's own view of direction: the SENT label is on every message
      // this mailbox sent, whichever address it was sent from.
      sent: labels.includes('SENT'),
      draft: labels.includes('DRAFT'),
      labelIds: labels,
      // Threading headers, verbatim. A reply sets In-Reply-To to this
      // Message-ID and appends it to References; Gmail then files the reply
      // in this thread for everyone, not just for us.
      rfcMessageId: header(message, 'Message-ID'),
      inReplyTo: header(message, 'In-Reply-To'),
      references: header(message, 'References'),
      bodyText: decoded.text,
      // Text is the default; sanitized HTML only travels when asked for.
      bodyHtml: wantHtml && decoded.html ? sanitizeHtml(decoded.html) : null,
      attachments: decoded.attachments,
    };
  });

  const all = new Set(messages.flatMap((m) => m.labelIds));
  return {
    id: thread.id,
    historyId: thread.historyId ?? null,
    subject: messages[0]?.subject || messages.find((m) => m.subject)?.subject || '(no subject)',
    unread: all.has('UNREAD'),
    starred: all.has('STARRED'),
    inInbox: all.has('INBOX'),
    inTrash: all.has('TRASH'),
    labelIds: [...all].sort(),
    messages,
  };
}

async function getAttachment(
  token: string,
  input: { messageId: string; attachmentId: string; mimeType?: string; filename?: string },
) {
  const body = await gmail<{ size?: number; data?: string }>(
    `/messages/${encodeURIComponent(input.messageId)}/attachments/${encodeURIComponent(input.attachmentId)}`,
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
        `/messages/${encodeURIComponent(input.messageId)}?format=full`,
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
// Actions: organising
// ---------------------------------------------------------------------------

/** Labels a caller may add or remove. Everything else is Gmail's to manage. */
function labelList(raw: unknown, field: string): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new BadRequest(`${field} must be a list of label ids.`);
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !LABEL_ID.test(item)) throw new BadRequest(`${field} has an invalid label id.`);
    // SENT and DRAFT are Gmail's own bookkeeping; a caller flipping them would
    // only confuse the folders. Everything else — INBOX, UNREAD, STARRED,
    // TRASH, SPAM, IMPORTANT, custom ids — is a legitimate move.
    if (item === 'SENT' || item === 'DRAFT') throw new BadRequest(`${item} cannot be changed by hand.`);
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

async function modifyThreads(
  token: string,
  input: { threadIds: string[]; addLabelIds: string[]; removeLabelIds: string[] },
) {
  const results = await Promise.all(
    input.threadIds.map(async (id) => {
      try {
        await gmail(`/threads/${encodeURIComponent(id)}/modify`, token, {
          method: 'POST',
          body: { addLabelIds: input.addLabelIds, removeLabelIds: input.removeLabelIds },
        });
        return { id, ok: true as const };
      } catch (e) {
        return { id, ok: false as const, error: e instanceof Error ? e.message : 'failed' };
      }
    }),
  );
  const failed = results.filter((r) => !r.ok);
  return {
    modified: results.length - failed.length,
    failed: failed.map((r) => ({ id: r.id, error: r.error })),
  };
}

async function createLabel(token: string, name: string) {
  const label = await gmail<GmailLabel>('/labels', token, {
    method: 'POST',
    body: {
      name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    },
  });
  return { id: label.id, name: label.name, type: label.type ?? 'user', threadsUnread: 0, threadsTotal: 0, color: null, textColor: null };
}

// ---------------------------------------------------------------------------
// Actions: drafts and sending
// ---------------------------------------------------------------------------

interface DraftSummary extends ThreadSummary {
  draftId: string;
}

function draftSummary(draft: GmailDraft): DraftSummary | null {
  const message = draft.message;
  if (!message) return null;
  const to = header(message, 'To');
  const from = header(message, 'From');
  const labels = message.labelIds ?? [];
  return {
    id: message.threadId ?? message.id,
    historyId: null,
    snippet: message.snippet ?? '',
    subject: header(message, 'Subject') || '(no subject)',
    from,
    fromName: displayName(from),
    fromAddress: bareAddress(from),
    to,
    toNames: displayNames(to) || '(no recipient)',
    date: isoDate(message),
    unread: false,
    starred: labels.includes('STARRED'),
    inInbox: labels.includes('INBOX'),
    inTrash: labels.includes('TRASH'),
    isDraft: true,
    draftId: draft.id,
    messageCount: 1,
    hasAttachments: (message.payload?.mimeType ?? '').toLowerCase() === 'multipart/mixed',
    labelIds: [...labels].sort(),
  };
}

async function listDrafts(token: string, options: { pageToken?: string; maxResults: number }) {
  const params = new URLSearchParams();
  params.set('maxResults', String(options.maxResults));
  if (options.pageToken) params.set('pageToken', options.pageToken);
  const page = await gmail<{ drafts?: GmailDraft[]; nextPageToken?: string }>(
    `/drafts?${params.toString()}`,
    token,
  );
  const stubs = (page.drafts ?? []).slice(0, MAX_THREADS);
  const settled = await Promise.all(
    stubs.map(async (stub) => {
      try {
        const detail = await gmail<GmailDraft>(
          `/drafts/${encodeURIComponent(stub.id)}?format=metadata${METADATA_HEADERS}`,
          token,
        );
        return draftSummary(detail);
      } catch {
        return null;
      }
    }),
  );
  return {
    drafts: settled.filter((d): d is DraftSummary => d !== null),
    nextPageToken: page.nextPageToken ?? null,
  };
}

/** Everything the composer needs to reopen a draft. */
async function getDraft(token: string, draftId: string) {
  const draft = await gmail<GmailDraft>(`/drafts/${encodeURIComponent(draftId)}?format=full`, token);
  const message = draft.message;
  if (!message) throw new Error('Gmail returned an empty draft.');
  const decoded = bodyOf(message);
  return {
    draftId: draft.id,
    messageId: message.id,
    threadId: message.threadId ?? null,
    to: header(message, 'To'),
    cc: header(message, 'Cc'),
    bcc: header(message, 'Bcc'),
    subject: header(message, 'Subject'),
    text: decoded.text,
    inReplyTo: header(message, 'In-Reply-To'),
    references: header(message, 'References'),
    date: isoDate(message),
    hasAttachments: decoded.attachments.length > 0,
  };
}

function rawFor(input: OutboundInput, from: string, fromName: string | null): string {
  return b64urlFromBytes(new TextEncoder().encode(buildRaw({ ...input, from, fromName })));
}

async function createDraft(token: string, input: OutboundInput, from: string, fromName: string | null) {
  const raw = rawFor(input, from, fromName);
  const draft = await gmail<GmailDraft>('/drafts', token, {
    method: 'POST',
    body: { message: input.threadId ? { raw, threadId: input.threadId } : { raw } },
  });
  return { draftId: draft.id, messageId: draft.message?.id ?? null, threadId: draft.message?.threadId ?? input.threadId ?? null };
}

async function updateDraft(
  token: string,
  draftId: string,
  input: OutboundInput,
  from: string,
  fromName: string | null,
) {
  const raw = rawFor(input, from, fromName);
  const draft = await gmail<GmailDraft>(`/drafts/${encodeURIComponent(draftId)}`, token, {
    method: 'PUT',
    body: { id: draftId, message: input.threadId ? { raw, threadId: input.threadId } : { raw } },
  });
  return { draftId: draft.id, messageId: draft.message?.id ?? null, threadId: draft.message?.threadId ?? input.threadId ?? null };
}

async function deleteDraft(token: string, draftId: string) {
  await gmail(`/drafts/${encodeURIComponent(draftId)}`, token, { method: 'DELETE' });
  return { deleted: true };
}

async function sendDraft(token: string, draftId: string) {
  const sent = await gmail<{ id?: string; threadId?: string }>('/drafts/send', token, {
    method: 'POST',
    body: { id: draftId },
  });
  if (!sent.id) throw new Error('Gmail did not confirm the send.');
  return { id: sent.id, threadId: sent.threadId ?? null };
}

async function sendMessage(token: string, input: OutboundInput, from: string, fromName: string | null) {
  const raw = rawFor(input, from, fromName);
  const sent = await gmail<{ id?: string; threadId?: string }>('/messages/send', token, {
    method: 'POST',
    body: input.threadId ? { raw, threadId: input.threadId } : { raw },
  });
  if (!sent.id) throw new Error('Gmail did not confirm the send.');
  return { id: sent.id, threadId: sent.threadId ?? input.threadId ?? null };
}

// ---------------------------------------------------------------------------

const ID = /^[A-Za-z0-9_-]{1,128}$/;

function requireId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new BadRequest(`${name} is required.`);
  return value;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceKey);

  // --- caller must be a company admin -------------------------------------
  // verify_jwt already proved the token is real; this proves the person
  // behind it is staff, not a portal customer.
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

  // --- which mailbox is this person allowed to touch? ----------------------
  const mailbox = MAILBOXES[email];
  if (!mailbox) {
    return json({ error: 'no_mailbox', detail: `No Workspace mailbox is mapped to ${email}.` }, 403);
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
  let body: Record<string, unknown>;
  try {
    const parsed = (await req.json()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const fromName = row?.display_name?.trim() || null;

  try {
    const token = await googleToken(mailbox, sa);

    switch (body.action) {
      case 'list': {
        const folder = parseFolder(body);
        const maxResults = Math.min(
          MAX_THREADS,
          Math.max(1, Math.round(Number(body.maxResults) || DEFAULT_THREADS)),
        );
        const result = await listThreads(token, {
          folder,
          q: typeof body.q === 'string' && body.q.trim() ? body.q.trim().slice(0, 500) : undefined,
          pageToken: typeof body.pageToken === 'string' ? body.pageToken : undefined,
          maxResults,
        });
        // `label` is echoed for the pre-v10 client shape; `folder` is the new key.
        const legacyLabel =
          folder.kind === 'unread' ? 'UNREAD' : folder.kind === 'starred' ? 'STARRED' : folder.kind === 'all' ? 'ALL' : 'INBOX';
        return json({ ok: true, mailbox, folder: folderKey(folder), label: legacyLabel, ...result });
      }

      case 'labels': {
        const labels = await listLabels(token);
        return json({ ok: true, mailbox, labels });
      }

      case 'thread': {
        const threadId = requireId(body.threadId, 'threadId');
        const thread = await getThread(token, threadId, body.html === true);
        return json({ ok: true, mailbox, thread });
      }

      case 'attachment': {
        const messageId = requireId(body.messageId, 'messageId');
        if (typeof body.attachmentId !== 'string' || !body.attachmentId) {
          throw new BadRequest('attachmentId is required.');
        }
        const file = await getAttachment(token, {
          messageId,
          attachmentId: body.attachmentId,
          mimeType: typeof body.mimeType === 'string' ? body.mimeType : undefined,
          filename: typeof body.filename === 'string' ? body.filename : undefined,
        });
        return json({ ok: true, mailbox, ...file });
      }

      case 'modify': {
        const ids = Array.isArray(body.threadIds) ? body.threadIds : [];
        const threadIds: string[] = [];
        for (const id of ids) {
          if (typeof id !== 'string' || !ID.test(id)) throw new BadRequest('threadIds must be thread ids.');
          if (!threadIds.includes(id)) threadIds.push(id);
        }
        if (threadIds.length === 0) throw new BadRequest('Pick at least one conversation.');
        if (threadIds.length > MAX_MODIFY) throw new BadRequest(`At most ${MAX_MODIFY} conversations at a time.`);
        const addLabelIds = labelList(body.addLabelIds, 'addLabelIds');
        const removeLabelIds = labelList(body.removeLabelIds, 'removeLabelIds');
        if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
          throw new BadRequest('Nothing to change.');
        }
        const result = await modifyThreads(token, { threadIds, addLabelIds, removeLabelIds });
        return json({ ok: true, mailbox, ...result });
      }

      case 'draft.list': {
        const maxResults = Math.min(
          MAX_THREADS,
          Math.max(1, Math.round(Number(body.maxResults) || DEFAULT_THREADS)),
        );
        const result = await listDrafts(token, {
          pageToken: typeof body.pageToken === 'string' ? body.pageToken : undefined,
          maxResults,
        });
        return json({ ok: true, mailbox, ...result });
      }

      case 'draft.get': {
        const draftId = requireId(body.draftId, 'draftId');
        const draft = await getDraft(token, draftId);
        return json({ ok: true, mailbox, draft });
      }

      case 'draft.create': {
        const input = outboundInput(body, 'draft');
        const result = await createDraft(token, input, mailbox, fromName);
        return json({ ok: true, mailbox, ...result });
      }

      case 'draft.update': {
        const draftId = requireId(body.draftId, 'draftId');
        const input = outboundInput(body, 'draft');
        const result = await updateDraft(token, draftId, input, mailbox, fromName);
        return json({ ok: true, mailbox, ...result });
      }

      case 'draft.delete': {
        const draftId = requireId(body.draftId, 'draftId');
        const result = await deleteDraft(token, draftId);
        return json({ ok: true, mailbox, ...result });
      }

      case 'draft.send': {
        const draftId = requireId(body.draftId, 'draftId');
        const result = await sendDraft(token, draftId);
        return json({ ok: true, mailbox, ...result });
      }

      case 'send': {
        const input = outboundInput(body, 'send');
        const result = await sendMessage(token, input, mailbox, fromName);
        return json({ ok: true, mailbox, ...result });
      }

      case 'label.create': {
        const name = typeof body.name === 'string' ? body.name.replace(/[\r\n]+/g, ' ').trim().slice(0, 100) : '';
        if (!name) throw new BadRequest('Give the label a name.');
        const label = await createLabel(token, name);
        return json({ ok: true, mailbox, label });
      }

      default:
        return json(
          {
            error:
              'Unknown action. Use list, labels, thread, attachment, modify, draft.list, draft.get, ' +
              'draft.create, draft.update, draft.delete, draft.send, send or label.create.',
          },
          400,
        );
    }
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    if (e instanceof ScopeMissing) return json({ error: 'scope_missing', detail: e.message }, 503);
    // Google's own message is far more useful than "something went wrong" —
    // it is what tells the next person whether delegation, the key or the
    // mailbox is the problem. Nothing here can contain mail contents.
    return json({ error: e instanceof Error ? e.message : 'Gmail request failed.' }, 502);
  }
});
