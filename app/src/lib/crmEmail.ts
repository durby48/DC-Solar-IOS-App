/**
 * Email for one CRM record (Phase 7, 2026-09-07).
 *
 * THERE IS NO EMAIL TABLE, AND THAT IS THE DECISION. The audit
 * (docs/CRM_EMAIL.md) found that the app's Gmail integration stores nothing
 * by design — "the database never sees a subject line" — and that Gmail
 * itself already is the store: it has threads, Message-IDs, Sent, and a
 * search index. So the CRM asks the caller's OWN mailbox, live, for every
 * thread that has the record's address in From/To/Cc, and shows that.
 * Nothing is persisted, nothing can go stale, and nothing can leak: the
 * `gmail-inbox` function maps the caller to exactly one mailbox and refuses
 * everyone else with `no_mailbox`.
 *
 * Matching is by address, exactly — the customer's or lead's single `email`
 * column. If that address is empty there is nothing to search and the pane
 * says so; it does not guess from a name.
 *
 * Sending, drafts, archive and star all go through `gmail-inbox` too (see
 * lib/gmail.ts); a sent message shows up here on the next fetch because Gmail
 * put it in the thread. Since v10 (2026-09-12) the function's scope is
 * `gmail.modify`, so the pane can archive / star a thread and hand a reply
 * to the full composer at `/inbox/compose`.
 */

import { fetchInboxThreads, isNoMailbox, type InboxThread } from '@/lib/gmail';

export type RecordEmailResult =
  | { status: 'ok'; mailbox: string; threads: InboxThread[] }
  /** The record has no email address on file. */
  | { status: 'no_email' }
  /** This app account is not mapped to a Workspace mailbox. */
  | { status: 'no_mailbox'; message: string }
  | { status: 'unavailable'; message: string };

const COMPANY_DOMAIN = '@dcsolarkc.com';

/** Our side of a conversation: the mapped mailbox, or any address at the company domain. */
export function isOurAddress(address: string, mailbox: string | null): boolean {
  const a = address.trim().toLowerCase();
  if (!a) return false;
  if (mailbox && a === mailbox.toLowerCase()) return true;
  return a.endsWith(COMPANY_DOMAIN);
}

/**
 * Every thread in the caller's mailbox that involves `email`, newest first.
 * Gmail's search does the matching (`{from:x to:x cc:x}` is Gmail's OR
 * group), across Inbox, Sent and archive.
 */
export async function fetchRecordEmailThreads(email: string | null | undefined): Promise<RecordEmailResult> {
  const address = (email ?? '').trim().toLowerCase();
  if (!address || !address.includes('@')) return { status: 'no_email' };
  // "No mailbox for this account" is a property of the session, not the
  // record: remember it so an unmapped admin costs one 403, not one per click.
  if (noMailboxMessage) return { status: 'no_mailbox', message: noMailboxMessage };
  const result = await fetchInboxThreads({
    q: `{from:${address} to:${address} cc:${address}}`,
    folder: 'all',
    maxResults: 25,
  });
  if (!result.ok) {
    if (isNoMailbox(result.message)) {
      noMailboxMessage = result.message;
      return { status: 'no_mailbox', message: result.message };
    }
    return { status: 'unavailable', message: result.message };
  }
  return { status: 'ok', mailbox: result.mailbox, threads: result.threads };
}

let noMailboxMessage: string | null = null;

/** "Re: Re: Estimate" → "Estimate"; keeps the subject readable in a one-line row. */
export function bareSubject(subject: string): string {
  return subject.replace(/^(\s*(re|fwd?|fw)\s*:\s*)+/i, '').trim() || '(no subject)';
}
