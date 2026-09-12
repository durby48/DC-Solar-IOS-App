/**
 * Gmail for the DC Solar Workspace mailboxes — read, search, star, archive,
 * trash, label, draft and send.
 *
 * Everything here goes through the `gmail-inbox` edge function, and that is
 * the point: touching devon@dcsolarkc.com needs a service-account key with
 * domain-wide delegation over the whole domain, which can never be in the app
 * bundle. The client sends an action and its own JWT; the FUNCTION decides
 * which mailbox that identity is allowed to use. There is deliberately no way
 * to name a mailbox from here.
 *
 * v10 (2026-09-12): the function's scope is `gmail.modify`, so this client
 * can now change the mailbox — the list of actions is the function's header.
 * GMAIL STAYS THE STORE. No table, no cache, no AsyncStorage — every screen
 * shows what Google returned this minute and forgets it when it unmounts;
 * drafts autosave into Gmail's own Drafts folder, not into our database.
 *
 * NOTHING THROWS. Every call returns a result object with a message a person
 * can read. The inbox is a convenience; a Gmail outage must show a sentence,
 * not a red screen.
 *
 * THREE ERRORS GET TRANSLATED. `no_mailbox` (403) means this app account has
 * no Workspace mailbox mapped to it — the normal answer for everyone but
 * Devon and Isaiah; `not_configured` (503) means the function has no key
 * yet; `scope_missing` (503) means the Google Admin delegation does not list
 * `gmail.modify` yet. All three are expected states with a setup doc behind
 * them, not failures.
 */

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Linking, Platform } from 'react-native';

import { readFunctionError } from '@/lib/artwork';
import { supabase } from '@/lib/supabase';

const FUNCTION = 'gmail-inbox';

export const NO_MAILBOX_MESSAGE = 'No mailbox is linked to your account';
export const NOT_CONFIGURED_MESSAGE =
  "Email isn't set up yet — see docs/GMAIL_INBOX_SETUP.md";
export const SCOPE_MISSING_MESSAGE =
  'Email is not fully switched on yet: in Google Admin → Security → API controls → Domain-wide delegation, client id 105976483744924526112 needs the scope https://www.googleapis.com/auth/gmail.modify (docs/GMAIL_INBOX_SETUP.md).';
/** Kept for callers that import the old name. Same sentence. */
export const SEND_NOT_ENABLED_MESSAGE = SCOPE_MISSING_MESSAGE;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Legacy label filter, still accepted by `fetchInboxThreads`. `ALL` = no filter. */
export type InboxLabel = 'INBOX' | 'UNREAD' | 'STARRED' | 'ALL';

/**
 * A Gmail-shaped folder. `archive` is everything not in the inbox (Gmail's
 * "All mail" minus Inbox); `label:<id>` is a custom label.
 */
export type MailFolder =
  | 'inbox'
  | 'unread'
  | 'starred'
  | 'sent'
  | 'drafts'
  | 'archive'
  | 'trash'
  | 'spam'
  | 'all'
  | `label:${string}`;

export interface InboxThread {
  id: string;
  historyId: string | null;
  snippet: string;
  subject: string;
  /** The raw From header, e.g. `"Devon Durbin" <devon@dcsolarkc.com>`. */
  from: string;
  fromName: string;
  fromAddress: string;
  /** The raw To header of the newest message. */
  to: string;
  /** "Ann, Bob" — for Sent and Drafts rows, where From is always us. */
  toNames: string;
  /** ISO 8601, from Gmail's `internalDate`. Empty when Gmail sent neither. */
  date: string;
  unread: boolean;
  starred: boolean;
  inInbox: boolean;
  inTrash: boolean;
  isDraft: boolean;
  /** Set on rows from the Drafts folder — what the composer edits by. */
  draftId: string | null;
  messageCount: number;
  /** Best-effort paperclip hint — the thread view has the real list. */
  hasAttachments: boolean;
  /** Union of every message's labels, sorted. */
  labelIds: string[];
}

export interface MailLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
  threadsUnread: number | null;
  threadsTotal: number | null;
  color: string | null;
  textColor: string | null;
}

export interface MailAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

export interface MailMessage {
  id: string;
  from: string;
  fromName: string;
  fromAddress: string;
  to: string;
  cc: string;
  bcc: string;
  date: string;
  subject: string;
  snippet: string;
  unread: boolean;
  starred: boolean;
  /** Gmail's SENT label — this mailbox sent it. */
  sent: boolean;
  draft: boolean;
  labelIds: string[];
  /** RFC 5322 threading headers, verbatim (may be empty on old messages). */
  rfcMessageId: string;
  inReplyTo: string;
  references: string;
  /** Always plain text — from text/plain when there is one, else flattened HTML. */
  bodyText: string;
  /** Sanitized HTML, only when `fetchThread` was asked for it. The app renders `bodyText`. */
  bodyHtml: string | null;
  attachments: MailAttachment[];
}

export interface MailThread {
  id: string;
  historyId: string | null;
  subject: string;
  unread: boolean;
  starred: boolean;
  inInbox: boolean;
  inTrash: boolean;
  labelIds: string[];
  messages: MailMessage[];
}

export interface MailDraft {
  draftId: string;
  messageId: string;
  threadId: string | null;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
  inReplyTo: string;
  references: string;
  date: string;
  /** The draft carries files the app cannot edit; saving from here would drop them. */
  hasAttachments: boolean;
}

export type Failure = { ok: false; message: string };

export type ThreadsResult =
  | {
      ok: true;
      mailbox: string;
      folder: MailFolder;
      /** Legacy echo for pre-v10 callers. */
      label: InboxLabel;
      threads: InboxThread[];
      nextPageToken: string | null;
    }
  | Failure;

export type LabelsResult = { ok: true; mailbox: string; labels: MailLabel[] } | Failure;
export type ThreadResult = { ok: true; mailbox: string; thread: MailThread } | Failure;
export type AttachmentResult =
  | { ok: true; filename: string; mimeType: string; size: number; data: string }
  | Failure;
export type ModifyResult =
  | { ok: true; modified: number; failed: { id: string; error: string }[] }
  | Failure;
export type DraftRef = { ok: true; draftId: string; messageId: string | null; threadId: string | null } | Failure;
export type DraftResult = { ok: true; mailbox: string; draft: MailDraft } | Failure;
export type SendResult =
  | { ok: true; id: string; threadId: string | null; mailbox: string }
  | Failure;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * One place that knows how to call the function and how to read its failures.
 *
 * `functions.invoke` collapses every non-2xx into the string "Edge Function
 * returned a non-2xx status code" and hides the real body on `error.context`,
 * which is what `readFunctionError` digs out — without it a missing key, a
 * missing mailbox and a Google outage are indistinguishable.
 */
async function call<T>(
  body: Record<string, unknown>,
): Promise<{ ok: true; data: T } | Failure> {
  try {
    const { data, error } = await supabase.functions.invoke(FUNCTION, { body });
    if (error) {
      const detail = await readFunctionError(error);
      return { ok: false, message: translate(detail ?? error.message) };
    }
    const result = data as ({ ok?: boolean; error?: string } & T) | null;
    if (!result?.ok) {
      return { ok: false, message: translate(result?.error ?? 'Gmail request failed.') };
    }
    return { ok: true, data: result as T };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? translate(e.message) : 'Gmail request failed.',
    };
  }
}

/** Function error codes → a sentence. Anything else passes through as-is. */
function translate(code: string): string {
  if (code === 'no_mailbox') return NO_MAILBOX_MESSAGE;
  if (code === 'not_configured') return NOT_CONFIGURED_MESSAGE;
  if (code === 'scope_missing') return SCOPE_MISSING_MESSAGE;
  if (/Failed to fetch|Network request failed|Load failed/i.test(code)) {
    return 'You appear to be offline. Mail needs a connection.';
  }
  return code;
}

/** True when a failure message is the "no mailbox for you" state, not an outage. */
export function isNoMailbox(message: string): boolean {
  return message === NO_MAILBOX_MESSAGE;
}

/** True when the Google Admin delegation is missing the scope. */
export function isScopeMissing(message: string): boolean {
  return message === SCOPE_MISSING_MESSAGE;
}

/** True when the failure looks like no network rather than a Gmail refusal. */
export function isOffline(message: string): boolean {
  return message.startsWith('You appear to be offline');
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * One page of thread summaries, newest first. `folder` is the Gmail-shaped
 * filter; `label` is the pre-v10 name and still works (`'ALL'` = the whole
 * mailbox, which the CRM uses). `q` is real Gmail search syntax.
 */
export async function fetchInboxThreads(
  options: {
    folder?: MailFolder;
    q?: string;
    pageToken?: string;
    label?: InboxLabel;
    maxResults?: number;
  } = {},
): Promise<ThreadsResult> {
  const result = await call<{
    mailbox: string;
    folder: MailFolder;
    label: InboxLabel;
    threads: InboxThread[];
    nextPageToken: string | null;
  }>({
    action: 'list',
    folder: options.folder,
    label: options.folder ? undefined : (options.label ?? 'INBOX'),
    q: options.q?.trim() || undefined,
    pageToken: options.pageToken || undefined,
    maxResults: options.maxResults,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    mailbox: result.data.mailbox,
    folder: result.data.folder ?? options.folder ?? 'inbox',
    label: result.data.label ?? 'INBOX',
    threads: result.data.threads ?? [],
    nextPageToken: result.data.nextPageToken ?? null,
  };
}

/** The mailbox's folders and custom labels, with unread counts. */
export async function fetchLabels(): Promise<LabelsResult> {
  const result = await call<{ mailbox: string; labels: MailLabel[] }>({ action: 'labels' });
  if (!result.ok) return result;
  return { ok: true, mailbox: result.data.mailbox, labels: result.data.labels ?? [] };
}

/** Every message in one thread, oldest first, with decoded text bodies. */
export async function fetchThread(
  threadId: string,
  options: { html?: boolean } = {},
): Promise<ThreadResult> {
  if (!threadId) return { ok: false, message: 'No conversation was selected.' };
  const result = await call<{ mailbox: string; thread: MailThread }>({
    action: 'thread',
    threadId,
    html: options.html === true ? true : undefined,
  });
  if (!result.ok) return result;
  return { ok: true, mailbox: result.data.mailbox, thread: result.data.thread };
}

/**
 * One attachment's bytes, as standard base64. `mimeType` and `filename` are
 * passed back in from the thread view so the function does not have to
 * re-download the whole message just to learn what the file is called.
 */
export async function fetchAttachment(input: {
  messageId: string;
  attachmentId: string;
  mimeType?: string;
  filename?: string;
}): Promise<AttachmentResult> {
  if (!input.messageId || !input.attachmentId) {
    return { ok: false, message: 'That attachment is missing its id.' };
  }
  const result = await call<{ filename: string; mimeType: string; size: number; data: string }>({
    action: 'attachment',
    messageId: input.messageId,
    attachmentId: input.attachmentId,
    mimeType: input.mimeType,
    filename: input.filename,
  });
  if (!result.ok) return result;
  return { ok: true, ...result.data };
}

// ---------------------------------------------------------------------------
// Organising
// ---------------------------------------------------------------------------

/**
 * Add / remove labels on one or more threads. The named helpers below are
 * the whole vocabulary of the inbox screen; use them rather than label ids.
 */
export async function modifyThreads(input: {
  threadIds: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
}): Promise<ModifyResult> {
  const threadIds = input.threadIds.filter(Boolean);
  if (threadIds.length === 0) return { ok: false, message: 'Pick at least one conversation.' };
  const result = await call<{ modified: number; failed: { id: string; error: string }[] }>({
    action: 'modify',
    threadIds,
    addLabelIds: input.addLabelIds?.length ? input.addLabelIds : undefined,
    removeLabelIds: input.removeLabelIds?.length ? input.removeLabelIds : undefined,
  });
  if (!result.ok) return result;
  return { ok: true, modified: result.data.modified ?? 0, failed: result.data.failed ?? [] };
}

export const archiveThreads = (ids: string[]) => modifyThreads({ threadIds: ids, removeLabelIds: ['INBOX'] });
export const unarchiveThreads = (ids: string[]) => modifyThreads({ threadIds: ids, addLabelIds: ['INBOX'] });
export const trashThreads = (ids: string[]) => modifyThreads({ threadIds: ids, addLabelIds: ['TRASH'] });
export const untrashThreads = (ids: string[]) => modifyThreads({ threadIds: ids, removeLabelIds: ['TRASH'], addLabelIds: ['INBOX'] });
export const markRead = (ids: string[]) => modifyThreads({ threadIds: ids, removeLabelIds: ['UNREAD'] });
export const markUnread = (ids: string[]) => modifyThreads({ threadIds: ids, addLabelIds: ['UNREAD'] });
export const starThreads = (ids: string[]) => modifyThreads({ threadIds: ids, addLabelIds: ['STARRED'] });
export const unstarThreads = (ids: string[]) => modifyThreads({ threadIds: ids, removeLabelIds: ['STARRED'] });
export const notSpam = (ids: string[]) => modifyThreads({ threadIds: ids, removeLabelIds: ['SPAM'], addLabelIds: ['INBOX'] });
/** Apply a custom label. Pass `archive` to also take it out of the inbox (Gmail's "Move to"). */
export const applyLabel = (ids: string[], labelId: string, archive = false) =>
  modifyThreads({ threadIds: ids, addLabelIds: [labelId], removeLabelIds: archive ? ['INBOX'] : undefined });
export const removeLabel = (ids: string[], labelId: string) =>
  modifyThreads({ threadIds: ids, removeLabelIds: [labelId] });

export async function createLabel(name: string): Promise<{ ok: true; label: MailLabel } | Failure> {
  if (!name.trim()) return { ok: false, message: 'Give the label a name.' };
  const result = await call<{ label: MailLabel }>({ action: 'label.create', name: name.trim() });
  if (!result.ok) return result;
  return { ok: true, label: result.data.label };
}

// ---------------------------------------------------------------------------
// Composing: drafts and sending
// ---------------------------------------------------------------------------

export interface OutboundEmail {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  /** Reply INTO this thread: Gmail files it there for both sides. */
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
}

function outboundBody(input: OutboundEmail): Record<string, unknown> {
  return {
    to: input.to.trim() || undefined,
    cc: input.cc?.trim() || undefined,
    bcc: input.bcc?.trim() || undefined,
    subject: input.subject.trim(),
    text: input.text,
    threadId: input.threadId || undefined,
    inReplyTo: input.inReplyTo || undefined,
    references: input.references || undefined,
  };
}

/**
 * Send a plain-text email from the caller's own mapped mailbox, directly.
 * The function picks the From address; the client cannot. Nothing is stored
 * in Supabase — Sent (and the thread) in Gmail is the record.
 */
export async function sendEmail(input: OutboundEmail): Promise<SendResult> {
  const invalid = firstInvalidAddress([input.to, input.cc ?? '', input.bcc ?? '']);
  if (!input.to.trim()) return { ok: false, message: 'Add a To address.' };
  if (invalid) return { ok: false, message: `"${invalid}" is not an email address.` };
  if (!input.subject.trim() && !input.text.trim()) return { ok: false, message: 'Write a subject or a message.' };
  const result = await call<{ mailbox: string; id: string; threadId: string | null }>({
    action: 'send',
    ...outboundBody(input),
  });
  if (!result.ok) return result;
  return { ok: true, id: result.data.id, threadId: result.data.threadId ?? null, mailbox: result.data.mailbox };
}

/** Create a Gmail draft (may be empty and unaddressed — Gmail allows it too). */
export async function createDraft(input: OutboundEmail): Promise<DraftRef> {
  const invalid = firstInvalidAddress([input.to, input.cc ?? '', input.bcc ?? '']);
  if (invalid) return { ok: false, message: `"${invalid}" is not an email address.` };
  const result = await call<{ draftId: string; messageId: string | null; threadId: string | null }>({
    action: 'draft.create',
    ...outboundBody(input),
  });
  if (!result.ok) return result;
  return { ok: true, draftId: result.data.draftId, messageId: result.data.messageId ?? null, threadId: result.data.threadId ?? null };
}

/** Replace a draft's contents. Gmail keeps the same draftId. */
export async function updateDraft(draftId: string, input: OutboundEmail): Promise<DraftRef> {
  if (!draftId) return { ok: false, message: 'That draft has no id.' };
  const invalid = firstInvalidAddress([input.to, input.cc ?? '', input.bcc ?? '']);
  if (invalid) return { ok: false, message: `"${invalid}" is not an email address.` };
  const result = await call<{ draftId: string; messageId: string | null; threadId: string | null }>({
    action: 'draft.update',
    draftId,
    ...outboundBody(input),
  });
  if (!result.ok) return result;
  return { ok: true, draftId: result.data.draftId, messageId: result.data.messageId ?? null, threadId: result.data.threadId ?? null };
}

export async function deleteDraft(draftId: string): Promise<{ ok: true } | Failure> {
  if (!draftId) return { ok: false, message: 'That draft has no id.' };
  const result = await call<{ deleted: boolean }>({ action: 'draft.delete', draftId });
  if (!result.ok) return result;
  return { ok: true };
}

/** Send an existing draft. Gmail files it in Sent and removes it from Drafts. */
export async function sendDraft(draftId: string): Promise<SendResult> {
  if (!draftId) return { ok: false, message: 'That draft has no id.' };
  const result = await call<{ mailbox: string; id: string; threadId: string | null }>({
    action: 'draft.send',
    draftId,
  });
  if (!result.ok) return result;
  return { ok: true, id: result.data.id, threadId: result.data.threadId ?? null, mailbox: result.data.mailbox };
}

/** A draft's fields, for the composer to reopen. */
export async function fetchDraft(draftId: string): Promise<DraftResult> {
  if (!draftId) return { ok: false, message: 'That draft has no id.' };
  const result = await call<{ mailbox: string; draft: MailDraft }>({ action: 'draft.get', draftId });
  if (!result.ok) return result;
  return { ok: true, mailbox: result.data.mailbox, draft: result.data.draft };
}

/** One page of drafts, newest first (same shape as a thread list, with `draftId`). */
export async function fetchDrafts(
  options: { pageToken?: string; maxResults?: number } = {},
): Promise<{ ok: true; mailbox: string; drafts: InboxThread[]; nextPageToken: string | null } | Failure> {
  const result = await call<{ mailbox: string; drafts: InboxThread[]; nextPageToken: string | null }>({
    action: 'draft.list',
    pageToken: options.pageToken || undefined,
    maxResults: options.maxResults,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    mailbox: result.data.mailbox,
    drafts: result.data.drafts ?? [],
    nextPageToken: result.data.nextPageToken ?? null,
  };
}

// ---------------------------------------------------------------------------
// Address helpers (client-side validation; the function validates again)
// ---------------------------------------------------------------------------

const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** "Ann <a@x.com>, b@y.com" → ["Ann <a@x.com>", "b@y.com"]. */
export function splitAddresses(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** The bare address out of "Name <addr>" or "addr". */
export function bareAddress(value: string): string {
  return (value.match(/<([^>]+)>/)?.[1] ?? value).trim();
}

/** The first entry across the given fields that is not an email address, or null. */
export function firstInvalidAddress(fields: string[]): string | null {
  for (const field of fields) {
    for (const part of splitAddresses(field)) {
      if (!ADDRESS.test(bareAddress(part))) return part;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reply / forward prefills
// ---------------------------------------------------------------------------

export type ComposeMode = 'new' | 'reply' | 'replyAll' | 'forward';

/** Query params the `/inbox/compose` route understands. All strings, all optional. */
export interface ComposeParams {
  mode?: ComposeMode;
  draftId?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  text?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

function withPrefix(subject: string, prefix: 'Re' | 'Fwd'): string {
  const bare = subject.trim();
  const re = prefix === 'Re' ? /^(re)\s*:/i : /^(fwd?|fw)\s*:/i;
  return re.test(bare) ? bare : `${prefix}: ${bare}`;
}

function quoteBody(message: MailMessage): string {
  const when = new Date(message.date);
  const stamp = Number.isFinite(when.getTime())
    ? when.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';
  const who = message.fromName && message.fromName !== message.fromAddress
    ? `${message.fromName} <${message.fromAddress}>`
    : message.fromAddress;
  const quoted = (message.bodyText || message.snippet || '')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  return `\n\nOn ${stamp}, ${who} wrote:\n${quoted}\n`;
}

/**
 * The compose prefill for Reply / Reply all / Forward on `message`, in
 * `thread`. `mailbox` is our own address, so Reply all never CCs ourselves.
 * The original is quoted as text under a blank line for the reply to go in.
 */
export function composeParamsFor(
  mode: Exclude<ComposeMode, 'new'>,
  thread: MailThread,
  message: MailMessage,
  mailbox: string | null,
): ComposeParams {
  const ours = new Set([mailbox?.toLowerCase() ?? ''].filter(Boolean));
  const notUs = (list: string) =>
    splitAddresses(list).filter((p) => !ours.has(bareAddress(p).toLowerCase()));
  const references = [message.references, message.rfcMessageId].filter(Boolean).join(' ');

  if (mode === 'forward') {
    const head = [
      `---------- Forwarded message ---------`,
      `From: ${message.from}`,
      `Date: ${message.date ? new Date(message.date).toLocaleString('en-US') : ''}`,
      `Subject: ${message.subject || thread.subject}`,
      `To: ${message.to}`,
      message.cc ? `Cc: ${message.cc}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    return {
      mode,
      subject: withPrefix(message.subject || thread.subject, 'Fwd'),
      text: `\n\n${head}\n\n${message.bodyText || message.snippet || ''}\n`,
    };
  }

  // Reply goes to whoever wrote the message — unless WE wrote it, in which
  // case it goes back to the people we wrote to (Gmail does the same).
  const fromIsUs = ours.has(message.fromAddress.toLowerCase());
  const to = fromIsUs ? notUs(message.to) : [message.from];
  const cc =
    mode === 'replyAll'
      ? [...(fromIsUs ? [] : notUs(message.to)), ...notUs(message.cc)].filter(
          (p) => !to.some((t) => bareAddress(t).toLowerCase() === bareAddress(p).toLowerCase()),
        )
      : [];
  return {
    mode,
    to: to.join(', '),
    cc: cc.length ? cc.join(', ') : undefined,
    subject: withPrefix(message.subject || thread.subject, 'Re'),
    text: quoteBody(message),
    threadId: thread.id,
    inReplyTo: message.rfcMessageId || undefined,
    references: references || undefined,
  };
}

// ---------------------------------------------------------------------------
// Attachments → disk / share sheet
// ---------------------------------------------------------------------------

/** Keep the extension, drop anything the filesystem might dislike. */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'attachment';
}

/**
 * Download an attachment and hand it to the share sheet (native) or the
 * browser's download (web). On native the bytes are written to cache and
 * shared as a real file; on web a blob URL and a synthetic click is the
 * download.
 */
export async function saveAttachment(input: {
  messageId: string;
  attachment: MailAttachment;
}): Promise<{ ok: true } | Failure> {
  const fetched = await fetchAttachment({
    messageId: input.messageId,
    attachmentId: input.attachment.attachmentId,
    mimeType: input.attachment.mimeType,
    filename: input.attachment.filename,
  });
  if (!fetched.ok) return fetched;

  const name = safeFileName(fetched.filename || input.attachment.filename);

  try {
    if (Platform.OS === 'web') {
      if (typeof document === 'undefined') {
        return { ok: false, message: 'Downloads are not available here.' };
      }
      const binary = atob(fetched.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(
        new Blob([bytes], { type: fetched.mimeType || 'application/octet-stream' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      // Revoke on the next tick: revoking synchronously cancels the download
      // in Safari before it has read the blob.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return { ok: true };
    }

    if (!(await Sharing.isAvailableAsync())) {
      return { ok: false, message: 'Sharing is not available on this device.' };
    }
    const file = new File(Paths.cache, name);
    if (file.exists) file.delete();
    file.create();
    file.write(fetched.data, { encoding: 'base64' });
    await Sharing.shareAsync(file.uri, {
      mimeType: fetched.mimeType || undefined,
      dialogTitle: name,
    });
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not open that attachment.',
    };
  }
}

// ---------------------------------------------------------------------------
// Gmail deep links — the escape hatch for anything the app can't do
// ---------------------------------------------------------------------------

export function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

/** A Gmail compose window, pre-addressed as a reply. Kept for older callers. */
export function gmailReplyUrl(to: string, subject: string): string {
  return (
    'https://mail.google.com/mail/?view=cm' +
    `&to=${encodeURIComponent(to)}` +
    `&su=${encodeURIComponent(withPrefix(subject, 'Re'))}`
  );
}

/** Open a Gmail URL, swallowing the failure — a dead link must not crash. */
export async function openInGmail(url: string): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch {
    // No browser, or a blocked popup. Nothing useful to say.
  }
}
