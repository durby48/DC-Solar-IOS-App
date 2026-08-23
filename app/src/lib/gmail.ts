/**
 * Read-only Gmail for the DC Solar Workspace mailboxes.
 *
 * Everything here goes through the `gmail-inbox` edge function, and that is
 * the point: reading devon@dcsolarkc.com needs a service-account key with
 * domain-wide delegation over the whole domain, which can never be in the app
 * bundle. The client sends an action and its own JWT; the FUNCTION decides
 * which mailbox that identity is allowed to read. There is deliberately no way
 * to name a mailbox from here.
 *
 * NOTHING IS STORED. No table, no cache, no AsyncStorage — every screen shows
 * what Google returned this minute and forgets it when it unmounts. The app's
 * database never sees a subject line.
 *
 * NOTHING THROWS. Every call returns a result object with a message a person
 * can read. The inbox is a convenience; a Gmail outage must show a sentence,
 * not a red screen.
 *
 * TWO ERRORS GET TRANSLATED. `no_mailbox` (403) means this app account has no
 * Workspace mailbox mapped to it — the normal answer for everyone but Devon
 * and Isaiah — and `not_configured` (503) means the function has no key yet.
 * Both are expected states with a setup doc behind them, not failures.
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

export type InboxLabel = 'INBOX' | 'UNREAD' | 'STARRED';

export interface InboxThread {
  id: string;
  historyId: string | null;
  snippet: string;
  subject: string;
  /** The raw From header, e.g. `"Devon Durbin" <devon@dcsolarkc.com>`. */
  from: string;
  fromName: string;
  fromAddress: string;
  /** ISO 8601, from Gmail's `internalDate`. Empty when Gmail sent neither. */
  date: string;
  unread: boolean;
  starred: boolean;
  messageCount: number;
  /** Best-effort paperclip hint — the thread view has the real list. */
  hasAttachments: boolean;
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
  date: string;
  subject: string;
  snippet: string;
  unread: boolean;
  /** Always plain text — from text/plain when there is one, else flattened HTML. */
  bodyText: string;
  /** Sanitized HTML, when the message had any. The app renders `bodyText`. */
  bodyHtml: string | null;
  attachments: MailAttachment[];
}

export interface MailThread {
  id: string;
  historyId: string | null;
  subject: string;
  messages: MailMessage[];
}

export type ThreadsResult =
  | {
      ok: true;
      mailbox: string;
      label: InboxLabel;
      threads: InboxThread[];
      nextPageToken: string | null;
    }
  | { ok: false; message: string };

export type ThreadResult =
  | { ok: true; mailbox: string; thread: MailThread }
  | { ok: false; message: string };

export type AttachmentResult =
  | { ok: true; filename: string; mimeType: string; size: number; data: string }
  | { ok: false; message: string };

/**
 * One place that knows how to call the function and how to read its failures.
 *
 * `functions.invoke` collapses every non-2xx into the string "Edge Function
 * returned a non-2xx status code" and hides the real body on `error.context`,
 * which is what `readFunctionError` digs out — without it a missing key, a
 * missing mailbox and a Google outage are indistinguishable.
 */
async function call<T>(body: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
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
  return code;
}

/** One page of thread summaries, newest first. */
export async function fetchInboxThreads(
  options: { q?: string; pageToken?: string; label?: InboxLabel; maxResults?: number } = {},
): Promise<ThreadsResult> {
  const result = await call<{
    mailbox: string;
    label: InboxLabel;
    threads: InboxThread[];
    nextPageToken: string | null;
  }>({
    action: 'list',
    q: options.q?.trim() || undefined,
    pageToken: options.pageToken || undefined,
    label: options.label ?? 'INBOX',
    maxResults: options.maxResults,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    mailbox: result.data.mailbox,
    label: result.data.label ?? 'INBOX',
    threads: result.data.threads ?? [],
    nextPageToken: result.data.nextPageToken ?? null,
  };
}

/** Every message in one thread, oldest first, with decoded bodies. */
export async function fetchThread(threadId: string): Promise<ThreadResult> {
  if (!threadId) return { ok: false, message: 'No conversation was selected.' };
  const result = await call<{ mailbox: string; thread: MailThread }>({
    action: 'thread',
    threadId,
  });
  if (!result.ok) return result;
  return { ok: true, mailbox: result.data.mailbox, thread: result.data.thread };
}

/**
 * One attachment's bytes, as standard base64.
 *
 * `mimeType` and `filename` are passed back in from the thread view so the
 * function does not have to re-download the whole message just to learn what
 * the file is called.
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
  const result = await call<{
    filename: string;
    mimeType: string;
    size: number;
    data: string;
  }>({
    action: 'attachment',
    messageId: input.messageId,
    attachmentId: input.attachmentId,
    mimeType: input.mimeType,
    filename: input.filename,
  });
  if (!result.ok) return result;
  return { ok: true, ...result.data };
}

/** Keep the extension, drop anything the filesystem might dislike. */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'attachment';
}

/**
 * Download an attachment and hand it to the share sheet (native) or the
 * browser's download (web).
 *
 * On native the bytes are written to cache and shared as a real file, exactly
 * like `lib/pdf.ts` does for generated PDFs — `expo-file-system` decodes the
 * base64 itself via `{ encoding: 'base64' }`, so nothing large is ever turned
 * into a JS string of bytes. On web there is no share sheet, so a blob URL and
 * a synthetic click is the download.
 */
export async function saveAttachment(input: {
  messageId: string;
  attachment: MailAttachment;
}): Promise<{ ok: true } | { ok: false; message: string }> {
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

/** Gmail's own view of a thread — the escape hatch for anything the app can't do. */
export function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(threadId)}`;
}

/**
 * A Gmail compose window, pre-addressed as a reply.
 *
 * REPLYING HAPPENS IN GMAIL, ON PURPOSE. Sending would need `gmail.send`, and
 * widening the service account's scope from readonly means the key in the
 * function could send mail as anybody in the domain. A deep link needs no
 * scope at all and lands in the same place Devon already reads his mail.
 */
export function gmailReplyUrl(to: string, subject: string): string {
  const re = /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
  return (
    'https://mail.google.com/mail/?view=cm' +
    `&to=${encodeURIComponent(to)}` +
    `&su=${encodeURIComponent(re)}`
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
