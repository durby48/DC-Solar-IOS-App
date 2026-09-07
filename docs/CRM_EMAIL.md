# CRM Email — audit and architecture (Phase 7, 2026-09-07)

The CRM's `SMS | Email` switch had an honest "not connected yet" behind Email.
This is what the code said when asked how email actually works here, and what
was built on top of it.

## 7A — the audit, answered from the code

Sources read: `supabase/functions/gmail-inbox/index.ts`, `app/src/lib/gmail.ts`,
`app/src/app/inbox.tsx`, `app/src/app/inbox/[threadId].tsx`,
`docs/GMAIL_INBOX_SETUP.md`, `docs/gmail-notify.gs`,
`supabase/migrations/2026-08-22_comms.sql`, `components/comms/Conversation.tsx`,
the live `customers` / `leads` / `contacts` columns and the project's secrets list.

| # | Question | Answer |
|---|---|---|
| 1 | Which employee mailboxes are accessible? | Exactly two, by a hard-coded map in the function: `devonsd311@gmail.com → devon@dcsolarkc.com`, `inettleton18@gmail.com → isaiah@dcsolarkc.com`. Every other account (including other owners) gets `403 no_mailbox`. |
| 2 | Still read-only? | Yes. One scope, `gmail.readonly`, and the function header says never to widen it. The app's Reply/Open buttons are Gmail deep links. |
| 3 | Delegation / scopes active | Domain-wide delegation of service-account client id `105976483744924526112` for `gmail.readonly` only. Secret `GMAIL_SA_JSON` is set on the project (verified). |
| 4 | Any send-capable path? | None. `docs/gmail-notify.gs` is an Apps Script on Devon's mailbox that POSTs bank-alert emails *into* the `notify` function (inbound to us, never outbound mail). |
| 5 | Is Gmail the only provider needed? | Yes — dcsolarkc.com is Google Workspace; both mailboxes are there. No Outlook anywhere in the code or the data. |
| 6 | Employee → mailbox mapping | The `MAILBOXES` constant in `gmail-inbox` (app sign-in email → Workspace address). Deliberately not derived: Devon signs in with a personal Gmail. |
| 7 | How are customer/lead emails stored? | One `email text` column each on `customers`, `leads`, `contacts`. No secondary-email field. Today: 14 customers have an email, 0 leads, 0 duplicates, 0 lead/customer overlaps. |
| 8 | Deterministic inbound matching? | Yes, by exact address: a thread belongs to a record iff the record's `email` appears in From/To/Cc. Gmail's own search (`{from:x to:x cc:x}`) does it. |
| 9 | Multiple records share an email? | Not representable today (no duplicates exist). If it happens, both records would show the same threads — visible, not silent; nothing is *attached* to either because nothing is stored. |
| 10 | One customer, several emails? | Not representable (single column). Flagged below as a product decision. |
| 11 | Threading today? | Gmail's `threadId` only; nothing in Supabase. `format=full` carries `Message-ID`/`In-Reply-To`/`References` and the function now returns them. |
| 12 | Sent messages in Gmail? | `users.messages.send` with `threadId` files the reply in the thread and in Sent, for both sides. Gmail is the record. |
| 13 | Drafts? | Not persisted anywhere. An unsent reply lives in the composer until the record changes. Building Gmail drafts would need `gmail.compose`; not justified. |
| 14 | Attachments? | Read: metadata comes with the thread, bytes on demand through the existing `attachment` action (≤10 MB), downloaded to the browser / share sheet. Never stored. Send: text only for now (see limitations). |
| 15 | HTML / text bodies? | The function already returns plain text (text/plain preferred, else HTML flattened with scripts/styles removed) plus sanitized HTML. The CRM renders text, like `/inbox` does. No WebView, no remote images, no tracking pixels. |
| 16 | Roles vs mailbox visibility? | Admin-only twice over (`employees.role` re-check in the function, `useRole().isAdmin` in the UI), and each admin sees **their own mailbox only**. Devon does not see Isaiah's email with a customer and vice versa. |

## The decision: no email table

"Unified UX does not require unified storage." The audit found something
stronger: the current Gmail integration's *defining property* is that
**nothing is stored** — `docs/GMAIL_INBOX_SETUP.md` calls it the feature, and
the function keeps no table so the database "never sees a subject line". Gmail
already is a store with threads, Message-IDs, Sent, search and history.

So Phase 7 does not add `email_threads` / `email_messages`. The CRM reads the
caller's own mailbox live for the selected record and projects it:

```
Customer / lead
  SMS, calls  → messages (Supabase)                ─┐
  Email       → Gmail, queried live per record      ├─ composeActivity() → one timeline
  Notes, jobs, money, history, tasks, appointments ─┘
```

What that buys: no sync engine, no duplicate copy to drift, no new RLS surface
carrying customer email bodies, no leak path (the function still maps one
caller to one mailbox), and the sent message appears because Gmail put it in
the thread. What it costs: a 1–3 s Gmail round trip when a record is selected
(loaded beside the record, not blocking it), a 25-thread cap per record, and
email visible only in the mailbox it lives in.

When a table WOULD be right: a shared team inbox (Devon seeing Isaiah's
threads), cross-mailbox search, offline, or automation triggered by inbound
mail (Phase 10). Each of those is a product decision, listed below, not a
refactor of what shipped.

## What shipped

- `gmail-inbox` (additive): `label: 'ALL'` = no label filter, so the CRM's
  query reaches Sent and archive; thread messages carry `sent`,
  `rfcMessageId`, `inReplyTo`, `references`. Scope unchanged: `gmail.readonly`.
- `gmail-send` (new function, `verify_jwt` true): same three gates, same
  `MAILBOXES` map, requests a token for **`gmail.send` only**. Builds an RFC
  5322 text/plain message From the mapped mailbox and calls
  `users.messages.send` with `threadId` + `In-Reply-To`/`References` for
  replies. Answers `503 scope_missing` with the Admin instruction until the
  delegation grant includes the scope.
- `lib/gmail.ts`: `sendEmail()`, the new fields, `SEND_NOT_ENABLED_MESSAGE`.
- `lib/crmEmail.ts`: `fetchRecordEmailThreads(email)` (exact-address Gmail
  search, `ALL`), `isOurAddress()`, `bareSubject()`.
- `components/crm/workspace/EmailPane.tsx`: threads → thread → reply /
  compose; attachments download; Open in Gmail; every non-working state says
  why (no address on record, no mailbox for this account, Gmail unavailable,
  sending not enabled).
- Activity: `Email received · subject` / `Email reply received · …` /
  `Email sent · …` rows (snippet as detail, never the body); tapping opens the
  thread in the Email pane.

## Google Workspace change required (Devon, ~2 min)

Google Admin → Security → Access and data control → API controls →
Domain-wide delegation → edit client id **`105976483744924526112`** → scopes:

```
https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.send
```

Nothing else: no `gmail.modify`, no `gmail.compose`. Until this is done,
reading works and Send shows the sentence above. No code change or redeploy
is needed afterwards — the function requests the scope per token.

## Product decisions flagged, not guessed

1. **Team visibility.** Should an owner see the other mailbox's threads with a
   customer? Today: no, each admin sees only their own. Supporting it means
   letting `gmail-inbox` query more than one mailbox per caller — a policy
   change, and a table (or a fan-out read) to merge.
2. **Several addresses per customer.** One column today. A `customer_emails`
   table (address, label, primary) would be additive; the CRM search would
   then OR them.
3. **Which mailbox sends.** Always the caller's own. There is no shared
   `info@` identity; adding one is a map line plus a Workspace decision.
4. **Attachments on send.** Not built: the send path is text-only. Adding
   files means base64 through the function (≤10 MB, matching the read cap).
5. **Bodies as HTML.** Still rendered as text on purpose. Rich rendering would
   need a sandboxed WebView/iframe and a remote-content policy.

## Known limitations

- 25 newest threads per record; the `/inbox` screen remains the place for
  Gmail-wide search.
- Direction is inferred from the From address (`@dcsolarkc.com` = ours) plus
  Gmail's `SENT` label on full messages.
- Plain-text send; no CC/BCC fields in the UI (the function accepts `cc`).
- No unread-count badge for email on the record list (it would cost a Gmail
  call per record).
