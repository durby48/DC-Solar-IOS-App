# Gmail inbox — setup and operating notes

Goal: Devon opens **Work → Email** in the app and reads `devon@dcsolarkc.com`
without leaving for the Gmail app, on a phone or on app.dcsolarkc.com.

**Read-only, and that is the feature.** The Google credential behind this holds
one scope — `https://www.googleapis.com/auth/gmail.readonly` — so the app
*cannot* send, reply, archive, label, star or delete, no matter what a bug
does. Every button that would change the mailbox (Reply, Open in Gmail) is a
deep link that hands off to Gmail, where those actions already live and already
have an audit trail.

**Nothing is stored.** There is no table, no cache and no offline copy. The app
never writes a subject line, a body or an attachment to Supabase or to the
device. Close the screen and it is gone; the only thing kept anywhere is the
Google access token, in the edge function's memory, for the few minutes an
isolate lives.

Status as of 2026-08-22: **live.** The service account, the domain-wide
delegation, the `GMAIL_SA_JSON` secret and the `gmail-inbox` function are all in
place and verified. Nothing below needs doing again unless a key is rotated or
a third mailbox is added.

Time to add a new mailbox: about 5 minutes, and steps 1 and 2 need Devon signed
in as the Workspace admin — a Claude session cannot do them.

---

## Who can read what

Two gates, both server-side, both in `supabase/functions/gmail-inbox/index.ts`:

1. The caller must be an **owner or operator** in `employees`. The function
   re-checks this with the service role; `verify_jwt` alone is not
   authorization, because every customer-portal account also holds a valid JWT.
2. The caller's **app identity** must appear in the function's `MAILBOXES`
   constant, which maps it to exactly one Workspace mailbox.

| App account (how they sign in) | Mailbox they can read |
|---|---|
| `devonsd311@gmail.com` | `devon@dcsolarkc.com` |
| `inettleton18@gmail.com` | `isaiah@dcsolarkc.com` |

Anyone else — including another owner — gets `403 no_mailbox` and the app says
*"No mailbox is linked to your account."* That is the default, and it is
deliberate: the client never names a mailbox and cannot, so a session belonging
to one person can never ask for another person's mail.

## Where the credentials live

| Thing | Where it lives | Notes |
|---|---|---|
| Service-account key JSON | `C:\Durbin Enterprises\config\secrets\gmail-sa-dcsolarkc.json` | Canonical local backup. Not in any git repo. |
| The same JSON | Supabase function secret `GMAIL_SA_JSON` (project `kjamxfezsathrsbztiln`) | What the function actually reads. |
| The same JSON | Vercel env `GOOGLE_SA_KEY` on the `dcsolarkc` project | Pre-existing, for the website. Unrelated to this app. |

The key **never** goes in the app bundle. `EXPO_PUBLIC_*` variables are public
by definition and an OTA update ships the JavaScript to anyone who opens the
web app; this key can impersonate every mailbox in the domain, so it only ever
exists server-side.

Service account: `gmail-inbox-reader-dcsolar@sharp-bivouac-500823-g3.iam.gserviceaccount.com`
Client id (the number Google Admin asks for): **`105976483744924526112`**

---

## 1. Domain-wide delegation (Devon, Google Admin, ~3 min)

Already done for this domain — this is here for a rebuild or a key rotation.

1. https://admin.google.com → **Security → Access and data control → API
   controls → Manage Domain Wide Delegation**.
2. **Add new**, client id `105976483744924526112`.
3. OAuth scopes: `https://www.googleapis.com/auth/gmail.readonly` — that one,
   and nothing else. Adding `gmail.send` or `gmail.modify` here would give the
   key in the function the run of every mailbox in the domain; the app has no
   code path that needs it.
4. **Authorise.**

If this step is missing or the scope is wrong, the function's token request
fails and the app shows Google's own words back:

> Google refused the delegation (unauthorized_client). In Google Admin →
> Security → API controls → Domain-wide delegation, add client id … with scope …

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

**`verify_jwt` must be TRUE.** It is not the authorization — the admin re-check
inside the function is — but it keeps anonymous traffic off the Google quota.

Smoke it: `OPTIONS` should answer `200` with the CORS headers, and a `POST`
with no `Authorization` header should answer `401`.

---

## Adding a third mailbox

1. Google Admin: nothing to do. Domain-wide delegation is per *client id*, not
   per mailbox — the existing grant already covers every address in
   dcsolarkc.com.
2. Add one line to `MAILBOXES` in `supabase/functions/gmail-inbox/index.ts`,
   mapping the person's **app sign-in address** (the one on their `employees`
   row) to their **Workspace address**.
3. Make sure that person is `owner` or `operator` in `employees` — a viewer is
   refused before the mailbox lookup even runs.
4. Redeploy the function (step 4).

The app sign-in address and the mailbox are usually different — Devon signs in
with a personal Gmail and reads a company address — which is exactly why the
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
| `/inbox` | `app/src/app/inbox.tsx` | Thread list: sender, subject, snippet, relative time, unread dot, star, paperclip. Search box (real Gmail search syntax — `from:`, `has:attachment`, `after:` all work), Inbox / Unread / Starred chips, pull to refresh, Load more. |
| `/inbox/[threadId]` | `app/src/app/inbox/[threadId].tsx` | Every message in the thread, oldest first, headers plus selectable plain-text body, attachments you can download and share, Reply in Gmail / Open in Gmail. |

Client wrapper: `app/src/lib/gmail.ts`. It never throws — every failure comes
back as a sentence for the screen to print.

Two details worth knowing:

- **Bodies are always plain text.** The function prefers `text/plain`, and
  flattens HTML to text when a sender only supplied HTML — scripts, styles and
  comments removed contents-and-all before anything else. There is no WebView
  and no remote content, so opening a message fires no tracking pixel.
- **The paperclip in the list is a hint, not a promise.** Gmail's cheap
  metadata format returns headers only, with no part list, so the list infers
  attachments from the message's top-level MIME type. Opening the thread pulls
  the real list. Fetching every full message just to draw a paperclip would
  cost megabytes per page.

Attachments are capped at 10 MB through the function; anything larger says so
and points at Gmail.
