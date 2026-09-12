# Gmail in the app — setup and operating notes

Goal: Devon opens **Work → Email** in the app and has `devon@dcsolarkc.com` —
read, search, star, archive, label, draft, reply, send — without leaving for
the Gmail app, on a phone or on app.dcsolarkc.com.

**Gmail is the store, and that is the feature.** There is no table, no cache
and no offline copy. The app never writes a subject line, a body or an
attachment to Supabase or to the device. Drafts you write in the app are
Gmail drafts; labels are Gmail labels; Archive is Gmail's archive. Close the
screen and it is gone; the only thing kept anywhere is the Google access
token, in the edge function's memory, for the few minutes an isolate lives.

Status as of **2026-09-12: live, on `gmail.modify`.** The service account,
the domain-wide delegation, the `GMAIL_SA_JSON` secret and the `gmail-inbox`
function are in place. On 2026-09-12 the owner changed the delegation's scope
list from `gmail.readonly,gmail.send` to `gmail.modify` (one scope) to match
function v10. Nothing below needs doing again unless a key is rotated or a
third mailbox is added.

History: read-only (`gmail.readonly`) from 2026-08-22; `gmail-send` with
`gmail.send` added 2026-09-07 for the CRM's reply box; both folded into
`gmail-inbox` v10 under `gmail.modify` on 2026-09-12. `gmail-send` is still
deployed (frozen, same scope) so an older iOS bundle keeps sending.

---

## Who can do what

Three gates, all server-side, all in `supabase/functions/gmail-inbox/index.ts`:

1. `verify_jwt` is TRUE — an anonymous request never reaches the code.
2. The caller must be an **owner or operator** in `employees`. The function
   re-checks this with the service role; `verify_jwt` alone is not
   authorization, because every customer-portal account also holds a valid JWT.
3. The caller's **app identity** must appear in the function's `MAILBOXES`
   constant, which maps it to exactly one Workspace mailbox.

| App account (how they sign in) | Mailbox they use |
|---|---|
| `devonsd311@gmail.com` | `devon@dcsolarkc.com` |
| `inettleton18@gmail.com` | `isaiah@dcsolarkc.com` |

**Only these two mailboxes exist in the app.** Anyone else — including another
owner — gets `403 no_mailbox` and the app says *"No mailbox is linked to your
account."* That is deliberate: the client never names a mailbox and cannot, so
a session belonging to one person can never touch another person's mail.

What `gmail.modify` lets the function do for that one mailbox: read, search,
send, create/update/delete drafts, add and remove labels (which is what star,
archive, mark read and trash are). What it cannot do: permanently delete
(`gmail.modify` excludes it — Trash is recoverable for 30 days), change
settings, filters or signatures.

## Where the credentials live

| Thing | Where it lives | Notes |
|---|---|---|
| Service-account key JSON | `C:\Durbin Enterprises\config\secrets\gmail-sa-dcsolarkc.json` | Canonical local backup. Not in any git repo. |
| The same JSON | Supabase function secret `GMAIL_SA_JSON` (project `kjamxfezsathrsbztiln`) | What the function actually reads. |
| The same JSON | Vercel env `GOOGLE_SA_KEY` on the `dcsolarkc` project | Pre-existing, for the website. Unrelated to this app. |

The key **never** goes in the app bundle. `EXPO_PUBLIC_*` variables are public
by definition and an OTA update ships the JavaScript to anyone who opens the
web app; this key can now act as every mailbox in the domain, so it only ever
exists server-side.

Service account: `gmail-inbox-reader-dcsolar@sharp-bivouac-500823-g3.iam.gserviceaccount.com`
Client id (the number Google Admin asks for): **`105976483744924526112`**

---

## 1. Domain-wide delegation (Devon, Google Admin, ~2 min) — done 2026-09-12

Here for a rebuild, a key rotation, or if the scope is ever reverted.

1. https://admin.google.com → **Security → Access and data control → API
   controls → Manage Domain Wide Delegation**.
2. Find (or **Add new**) client id `105976483744924526112`.
3. OAuth scopes — exactly this, one scope:

   ```
   https://www.googleapis.com/auth/gmail.modify
   ```

   It covers read, send, drafts and labels. Do not add `https://mail.google.com/`
   (full access, includes permanent delete) — the app has no code path that
   needs it.
4. **Authorise.** Takes effect within a few minutes; no redeploy is needed
   because the function requests the scope per token.

If this step is missing or the scope is wrong, Google answers
`unauthorized_client`, the function returns **`503 scope_missing`**, and the
app prints the instruction back:

> Email is not fully switched on yet. In Google Admin → Security → API
> controls → Domain-wide delegation, edit client id 105976483744924526112 and
> set its scope to https://www.googleapis.com/auth/gmail.modify.

That message means step 1, every time. It is never a Supabase problem.

## 2. Enable the Gmail API on the Cloud project (Devon, ~1 min)

Google Cloud console → project `sharp-bivouac-500823-g3` → **APIs & Services →
Library → Gmail API → Enable**. Already enabled.

## 3. Set the function secret (a Claude session can do this)

```
POST https://api.supabase.com/v1/projects/kjamxfezsathrsbztiln/secrets
Authorization: Bearer <PAT from config/secrets/supabase-access-token.txt>
Content-Type: application/json

[{ "name": "GMAIL_SA_JSON", "value": "<the entire contents of gmail-sa-dcsolarkc.json>" }]
```

Send it from a script that reads the file — never paste the key onto a command
line and never echo it. Until the secret exists the function answers
`503 not_configured` and the app says *"Email isn't set up yet — see
docs/GMAIL_INBOX_SETUP.md."* That is the designed behaviour, not a bug.

## 4. Deploy the function

Same multipart Management API call as every other function in this repo:

```
POST https://api.supabase.com/v1/projects/kjamxfezsathrsbztiln/functions/deploy?slug=gmail-inbox
metadata = {"entrypoint_path":"index.ts","name":"gmail-inbox","verify_jwt":true}
file     = supabase/functions/gmail-inbox/index.ts
```

Redeploy `gmail-send` the same way (slug `gmail-send`) so its scope matches;
it is otherwise frozen.

**`verify_jwt` must be TRUE.** It is not the authorization — the admin re-check
inside the function is — but it keeps anonymous traffic off the Google quota.

Smoke it: `OPTIONS` should answer `200` with the CORS headers, a `POST` with
no `Authorization` header should answer `401`, and a signed-in admin's
`{ "action": "labels" }` should list Inbox, Sent, Drafts… with counts.

---

## Adding a third mailbox

1. Google Admin: nothing to do. Domain-wide delegation is per *client id*, not
   per mailbox — the existing grant already covers every address in
   dcsolarkc.com.
2. Add one line to `MAILBOXES` in `supabase/functions/gmail-inbox/index.ts`
   **and the identical line in `supabase/functions/gmail-send/index.ts`**,
   mapping the person's **app sign-in address** (the one on their `employees`
   row) to their **Workspace address**.
3. Make sure that person is `owner` or `operator` in `employees` — a viewer is
   refused before the mailbox lookup even runs.
4. Redeploy both functions (step 4).

The app sign-in address and the mailbox are usually different — Devon signs in
with a personal Gmail and uses a company address — which is exactly why the
map is explicit rather than derived.

## Rotating the key

IAM → Service Accounts → `gmail-inbox-reader-dcsolar` → Keys → add a new JSON
key, delete the old one. Then replace
`config/secrets/gmail-sa-dcsolarkc.json`, re-run step 3, and update the Vercel
`GOOGLE_SA_KEY` on the `dcsolarkc` project (the website uses the same key). No
code change and no redeploy are needed — the function reads the secret at
request time and caches only the short-lived access token.

---

## What the app actually does

| Screen | File | What it shows |
|---|---|---|
| `/inbox` | `app/src/app/inbox.tsx` | **Wide (≥ 900 px):** folder rail (Inbox with unread count, Starred, Sent, Drafts, All mail, Trash, Spam, then every custom label) · thread list with search box (real Gmail syntax — `from:`, `has:attachment`, `after:`), checkboxes and a bulk bar (Archive / Read / Star / Label / Trash) · reading pane. **Phone:** folder strip, list, tap to open, long-press menu, purple compose button. Pull to refresh, Load more. |
| `/inbox/[threadId]` | `app/src/app/inbox/[threadId].tsx` | One conversation, oldest first, expand/collapse per message, attachments to download or share, Reply / Reply all / Forward, and Archive · Star · Mark unread · Move to label · Trash · Open in Gmail in the toolbar. Opening marks the thread read, like Gmail. |
| `/inbox/compose` | `app/src/app/inbox/compose.tsx` | To / Cc / Bcc (comma-separated, validated), subject, body. Autosaves to a Gmail draft 3 s after you stop typing; Send sends that draft; Discard deletes it. Opening a row in Drafts edits it. Text only — the caption says so. |
| CRM → record → Email | `app/src/components/crm/workspace/EmailPane.tsx` | The record's threads, one thread with a quick reply box, star / archive, and New / Full reply / Forward into the composer with the address prefilled. |

Client wrapper: `app/src/lib/gmail.ts`. It never throws — every failure comes
back as a sentence for the screen to print. Shared UI: `app/src/components/email/`.

Details worth knowing:

- **Bodies are always plain text.** The function prefers `text/plain`, and
  flattens HTML to text when a sender only supplied HTML — scripts, styles and
  comments removed contents-and-all before anything else. There is no WebView
  and no remote content, so opening a message fires no tracking pixel.
- **Outbound mail is plain text too**, built server-side (RFC 5322) with every
  recipient validated and every header CRLF-stripped. Attachments cannot be
  sent from the app yet.
- **The paperclip in the list is a hint, not a promise.** Gmail's cheap
  metadata format returns headers only, so the list infers attachments from
  the message's top-level MIME type. Opening the thread pulls the real list.
- **Trash is Gmail's Trash** — recoverable for 30 days, with Restore in the
  app's Trash folder. Nothing the app does is permanent.

Attachments are capped at 10 MB through the function; anything larger says so
and points at Gmail. Design and the audit behind all of it: `docs/CRM_EMAIL.md`.
