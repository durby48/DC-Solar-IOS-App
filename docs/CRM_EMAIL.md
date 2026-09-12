# CRM Email — architecture, the v10 Gmail surface, and the audit behind it

Two dates matter in this file. **2026-09-07 (Phase 7)** is when the CRM's
`SMS | Email` switch stopped saying "not connected yet": the app read the
caller's Gmail live and sent plain-text replies through a second, send-only
function. **2026-09-12 (v10)** is when the owner asked for "a full ported view
of Gmail — not just read emails but write, compose, edit, draft, sort and
organize", and the whole surface was rebuilt on one function and one scope.

The one thing that did not change: **Gmail is the store.** There is still no
email table, no cache, no copy of a subject line anywhere in Supabase.

## v10 (2026-09-12) — what changed

| | Before | Now |
|---|---|---|
| Functions | `gmail-inbox` (read, `gmail.readonly`) + `gmail-send` (send, `gmail.send`) | **`gmail-inbox` does everything** under **`gmail.modify`**. `gmail-send` stays deployed for older JS bundles, asks for the same scope, and is otherwise frozen. |
| Google Admin delegation | `gmail.readonly,gmail.send` | **`https://www.googleapis.com/auth/gmail.modify`** — changed by the owner on 2026-09-12. |
| `/inbox` | Inbox / Unread / Starred chips, read-only rows, deep links to Gmail | **Gmail-shaped.** Wide (≥ 900 px): folder rail · thread list with search and multi-select · reading pane. Phone: folder strip, list, long-press menu, purple compose button. |
| Folders | Inbox, Unread, Starred | Inbox (unread count), Starred, Sent, Drafts, All mail (archive), Trash, Spam, every custom label. |
| Organising | none | Archive / move to Inbox, star, mark read/unread, trash / restore, not spam, move to label (with "also remove from Inbox"), create label — one thread or a selection. |
| Reading | one screen | `components/email/ThreadView` shared by the phone screen and the wide reading pane; messages expand/collapse; opening marks read like Gmail. |
| Writing | inline reply box in the CRM pane only | **`/inbox/compose`**: To/Cc/Bcc, subject, body; Reply / Reply all / Forward prefilled with the quoted original; **autosaves to a Gmail draft** every 3 s; Send sends that draft (`drafts.send`), Discard deletes it; opening a row in Drafts edits it. |
| CRM pane | list → thread → inline reply/compose | Same list/thread, inline quick reply kept, plus **New / Full reply / Forward** open the composer with the address prefilled, and star / archive on the thread bar. |

Text-only sending is still the rule (attachments: read yes, send no — see
"Not done").

## The function's action table (`supabase/functions/gmail-inbox/index.ts`)

Every request is `POST { action, … }` with the caller's JWT. Three gates run
before any action: `verify_jwt`, the `employees.role` re-check (owner or
operator), and the `MAILBOXES` map from the JWT's email to the one Workspace
mailbox that account may touch. Anything not in this table is refused with
400.

| Action | Input | Returns | Notes |
|---|---|---|---|
| `list` | `folder` (`inbox`·`unread`·`starred`·`sent`·`drafts`·`archive`·`trash`·`spam`·`all`·`label:<id>`), `q`, `pageToken`, `maxResults` (≤ 50) | thread summaries: subject, from/to names, snippet, date, unread, starred, inInbox, inTrash, isDraft, draftId, hasAttachments, labelIds; `nextPageToken` | `label` (`INBOX`/`UNREAD`/`STARRED`/`ALL`) still accepted for pre-v10 callers. `drafts` is served from `drafts.list` so rows carry a `draftId`. `archive` = `-in:inbox -in:drafts`. |
| `labels` | — | system folders + custom labels with `threadsUnread` / `threadsTotal` | Counts cost one `labels.get` each, capped at 40. |
| `thread` | `threadId`, `html?` | messages oldest-first with text bodies, threading headers, attachments meta, per-message labels | `bodyHtml` (sanitized, remote images neutralised) only when `html: true`; text is the default. |
| `attachment` | `messageId`, `attachmentId`, `mimeType?`, `filename?` | base64 bytes | ≤ 10 MB. |
| `modify` | `threadIds[]` (≤ 50), `addLabelIds[]`, `removeLabelIds[]` | `modified`, `failed[]` | `SENT` and `DRAFT` cannot be added or removed by hand. Archive = remove `INBOX`; trash = add `TRASH`. |
| `draft.list` | `pageToken`, `maxResults` | draft summaries with `draftId` | |
| `draft.get` | `draftId` | to/cc/bcc/subject/text/threadId/inReplyTo/references/hasAttachments | What the composer reopens. |
| `draft.create` | `to?`, `cc?`, `bcc?`, `subject?`, `text?`, `threadId?`, `inReplyTo?`, `references?` | `draftId`, `messageId`, `threadId` | May be empty and unaddressed, like Gmail. |
| `draft.update` | `draftId` + the same fields | same | Replaces the draft's content; the id stays. |
| `draft.delete` | `draftId` | `deleted` | |
| `draft.send` | `draftId` | `id`, `threadId` | How the composer sends: Gmail files it in Sent and the thread. |
| `send` | `to`, `cc?`, `bcc?`, `subject`, `text`, `threadId?`, `inReplyTo?`, `references?` | `id`, `threadId` | Direct send; the CRM pane's quick reply uses it. |
| `label.create` | `name` | the label | |

Every outbound message is RFC 5322 `text/plain` built server-side: each
recipient validated, every display name rebuilt and quoted, CRLF stripped from
every header value, `In-Reply-To`/`References` reduced to `<…>` tokens. The
function never logs a body; lists carry snippets only.

Errors the app translates: `403 no_mailbox` (this account has no mapped
mailbox), `503 not_configured` (no `GMAIL_SA_JSON`), `503 scope_missing`
(Google answered `unauthorized_client` — the delegation does not list
`gmail.modify`; the app prints the exact Admin instruction). Everything else
is Google's own message with a 502.

## Client (`app/src/lib/gmail.ts`)

One typed function per action, none of which throw. The pre-v10 exports keep
their names and shapes — `fetchInboxThreads` (now also takes `folder`),
`fetchThread`, `fetchAttachment`, `saveAttachment`, `sendEmail`,
`gmailThreadUrl`, `gmailReplyUrl`, `openInGmail`, `isNoMailbox`,
`SEND_NOT_ENABLED_MESSAGE` — so `crmEmail.ts`, `crmWorkspace.ts` and the
Activity timeline did not have to change. New: `fetchLabels`,
`modifyThreads` and the named helpers (`archiveThreads`, `trashThreads`,
`markRead`, `starThreads`, `applyLabel`, …), `createLabel`, `createDraft` /
`updateDraft` / `deleteDraft` / `sendDraft` / `fetchDraft` / `fetchDrafts`,
`composeParamsFor(mode, thread, message, mailbox)` (Reply / Reply all /
Forward prefills, original quoted as text), `firstInvalidAddress` for
client-side validation, `isScopeMissing`, `isOffline`.

Shared UI lives in `app/src/components/email/`: `FolderRail` / `FolderStrip`,
`ThreadRow`, `ThreadView`, `LabelPicker`, and `composeStash` (hands a quoted
body to `/inbox/compose` without putting it in the URL).

## The decision: still no email table

"Unified UX does not require unified storage." The 7A audit (below) found
that the Gmail integration's *defining property* is that **nothing is
stored** — and v10 leans on that harder, not less: drafts autosave into
Gmail's Drafts, labels are Gmail's labels, Archive is Gmail's archive. The
app is a second window onto the same mailbox, so there is nothing to sync and
nothing to drift.

```
Customer / lead
  SMS, calls  → messages (Supabase)                ─┐
  Email       → Gmail, queried live per record      ├─ composeActivity() → one timeline
  Notes, jobs, money, history, tasks, appointments ─┘
```

When a table WOULD be right: a shared team inbox (Devon seeing Isaiah's
threads), cross-mailbox search, offline, or automation triggered by inbound
mail. Each of those is a product decision, listed below, not a refactor.

## Product decisions still open

1. **Team visibility.** Each admin sees only their own mailbox. Supporting a
   shared view means letting `gmail-inbox` query more than one mailbox per
   caller — a policy change — and something to merge the results.
2. **Several addresses per customer.** One `email` column today.
3. **Which mailbox sends.** Always the caller's own; no shared `info@`.
4. **Attachments on send.** Not built (below).
5. **Bodies as HTML.** The function can return sanitized HTML on request; the
   app still renders text on purpose. Rich rendering needs a sandboxed
   WebView/iframe and a remote-content policy.

## Not done in v10

- **Attachments on outbound mail.** The composer says so in its caption. A
  draft that already carries files (made in Gmail) opens with a warning:
  autosave is off and Send sends it unchanged, because rewriting it from the
  app would drop the files.
- **Swipe actions on phone rows.** Long-press menu instead (archive, star,
  read/unread, move to label, trash, select).
- **Undo.** Trash is Gmail's Trash (30 days); Archive has "Move to Inbox".
- **Permanent delete, settings, filters, signatures.** Outside `gmail.modify`
  and outside the ask.
- **Per-record unread badge on the CRM list.** Would cost a Gmail call per
  record.

## 7A — the audit, answered from the code (2026-09-07; rows marked † changed in v10)

| # | Question | Answer |
|---|---|---|
| 1 | Which employee mailboxes are accessible? | Exactly two, by a hard-coded map in the function: `devonsd311@gmail.com → devon@dcsolarkc.com`, `inettleton18@gmail.com → isaiah@dcsolarkc.com`. Every other account (including other owners) gets `403 no_mailbox`. |
| 2† | Still read-only? | No, since v10. One scope, `gmail.modify`; the app can read, send, draft, star, archive, label and trash — never permanently delete. |
| 3† | Delegation / scopes active | Domain-wide delegation of client id `105976483744924526112` for `gmail.modify` (changed 2026-09-12). Secret `GMAIL_SA_JSON` is set on the project. |
| 4† | Any send-capable path? | `gmail-inbox` `send` / `draft.send` (and the frozen `gmail-send`). `docs/gmail-notify.gs` is an Apps Script that POSTs bank-alert emails *into* the `notify` function — inbound to us. |
| 5 | Is Gmail the only provider needed? | Yes — dcsolarkc.com is Google Workspace; both mailboxes are there. |
| 6 | Employee → mailbox mapping | The `MAILBOXES` constant (app sign-in email → Workspace address). Deliberately not derived: Devon signs in with a personal Gmail. |
| 7 | How are customer/lead emails stored? | One `email text` column each on `customers`, `leads`, `contacts`. |
| 8 | Deterministic inbound matching? | Yes, by exact address: `{from:x to:x cc:x}` across the whole mailbox (`folder: 'all'`). |
| 9 | Multiple records share an email? | Both would show the same threads — visible, not silent. |
| 10 | One customer, several emails? | Not representable (single column). |
| 11 | Threading? | Gmail's `threadId` plus `Message-ID`/`In-Reply-To`/`References`, which the function returns and the composer sends back. |
| 12 | Sent messages in Gmail? | `messages.send` / `drafts.send` with `threadId` files the reply in the thread and in Sent, for both sides. |
| 13† | Drafts? | Gmail drafts, created and updated by the composer's autosave. Nothing in Supabase. |
| 14 | Attachments? | Read: metadata with the thread, bytes on demand (≤ 10 MB), never stored. Send: not yet. |
| 15 | HTML / text bodies? | Plain text always; sanitized HTML available from the function on request, unused by the app. |
| 16 | Roles vs mailbox visibility? | Admin-only twice over (`employees.role` in the function, `useRole().isAdmin` in the UI), and each admin sees **their own mailbox only**. |
