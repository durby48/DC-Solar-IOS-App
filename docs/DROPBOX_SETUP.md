# Dropbox photo folders — setup checklist

Goal: Devon drops photos into two Dropbox folders and they appear in the app —
Employee of the Month picks from a real library, and Sales → Marketing shows
real job photos instead of nothing.

**One way only.** Nothing in this pipeline ever writes to Dropbox, and the sync
never deletes a storage object. A file that disappears from Dropbox gets
`archived_at` stamped on its row and the bytes stay put; losing a marketing
photo because somebody tidied a folder is not a failure mode worth having.

Cost: **$0.** A free Dropbox Basic account is enough. Time: about 15 minutes,
all of it Devon's, and none of it can be done by a Claude session because it
needs Devon signed in to Dropbox.

Until step 5 the `dropbox-sync` function answers `503 not_configured` — that is
the designed behaviour, not a bug.

---

## 1. Create the Dropbox app (Devon, ~5 min)

1. https://www.dropbox.com/developers/apps → **Create app**.
2. Choose the API: **Scoped access**.
3. Type of access: **App folder** — *not* Full Dropbox. This is the important
   click. App-folder access means Dropbox creates one folder
   (`Dropbox/Apps/DC Solar KC/`) and the app can never see anything outside it.
   Full-Dropbox access would hand a refresh token the run of every file Devon
   owns, forever.
4. Name it `DC Solar KC` (Dropbox app names are globally unique — add a suffix
   if it is taken; the name is only used for the folder).

## 2. Permissions — exactly two (Devon, ~2 min)

**Permissions** tab → tick **only**:

- `files.metadata.read`
- `files.content.read`

Then **Submit**. Do not tick any `.write` scope: the function has no code path
that writes to Dropbox, so a write scope would be permission the system cannot
use and an attacker could.

⚠️ Scopes must be saved **before** the authorization step below. A token minted
before the scopes are submitted carries the old (empty) scope set and every
`files/list_folder` call comes back `missing_scope`.

## 3. Make the folders and move the photos in (Devon, ~5 min)

Inside `Dropbox/Apps/DC Solar KC/`, create exactly two folders:

```
Dropbox/Apps/DC Solar KC/EOM/
Dropbox/Apps/DC Solar KC/Marketing/
```

Case does not matter — the sync uses Dropbox's `path_lower`, and
`public.dropbox_folders` is already seeded with `/eom` and `/marketing`.
Subfolders are fine; the sync is recursive.

Only `.jpg`, `.jpeg`, `.png`, `.heic` and `.webp` files are picked up.
Everything else in there is ignored, so a `notes.txt` or a Lightroom catalogue
does no harm.

## 4. Mint the refresh token (Devon, ~5 min, one time)

The **Settings** tab has the **App key** and **App secret**. With those:

**4a. Authorize.** Open this in a browser, signed in as the Dropbox account that
owns the photos. `token_access_type=offline` is what makes Dropbox issue a
refresh token instead of a four-hour access token:

```
https://www.dropbox.com/oauth2/authorize?client_id=<APP_KEY>&response_type=code&token_access_type=offline
```

Click **Allow** and copy the short code Dropbox shows on the next page. It is
single-use and expires in a few minutes.

**4b. Exchange it for a refresh token:**

```
curl -X POST https://api.dropbox.com/oauth2/token \
  -u "<APP_KEY>:<APP_SECRET>" \
  -d code=<THE_CODE_FROM_4a> \
  -d grant_type=authorization_code
```

The reply looks like:

```json
{
  "access_token": "sl.u.AF…",
  "expires_in": 14400,
  "refresh_token": "3g8…",
  "scope": "files.content.read files.metadata.read",
  "account_id": "dbid:AA…",
  "uid": "…"
}
```

Keep the **`refresh_token`**. It does not expire unless it is revoked. Ignore
the `access_token` — the function mints its own and stores it.

If `scope` in that reply does not list both `files.*.read` scopes, go back to
step 2, submit them, and redo 4a/4b.

## 5. Store the credentials in the database (Devon or a Claude session, ~2 min)

They go in `public.integration_secrets`, **not** in edge-function secrets. This
is not a style preference: the Dropbox access token expires every four hours and
the function has to *store* the refreshed one. The Management API secrets
endpoint is a deploy-time store, not a runtime one.

```
curl -X POST "https://api.supabase.com/v1/projects/kjamxfezsathrsbztiln/database/query" \
  -H "Authorization: Bearer <SUPABASE_PAT>" \
  -H "Content-Type: application/json" \
  -d '{"query":"insert into public.integration_secrets (company, provider, client_id, client_secret, refresh_token) values ('"'"'dc-solar'"'"', '"'"'dropbox'"'"', '"'"'<APP_KEY>'"'"', '"'"'<APP_SECRET>'"'"', '"'"'<REFRESH_TOKEN>'"'"') on conflict (company, provider) do update set client_id = excluded.client_id, client_secret = excluded.client_secret, refresh_token = excluded.refresh_token, access_token = null, expires_at = null, updated_at = now();"}'
```

(`access_token = null, expires_at = null` on the update forces the next run to
refresh, which is how you recover from a rotated app secret.)

The PAT lives in `C:\Durbin Enterprises\config\secrets\supabase-access-token.txt`.
Never paste the app secret or the refresh token into a file inside this repo.

## 6. Run the first sync (~2 min)

`DROPBOX_SYNC_SECRET` is already set as an edge-function secret; the value is in
`C:\Durbin Enterprises\config\secrets\dropbox-sync-secret.txt`.

```
curl -X POST "https://kjamxfezsathrsbztiln.supabase.co/functions/v1/dropbox-sync" \
  -H "x-sync-secret: <DROPBOX_SYNC_SECRET>" \
  -H "content-type: application/json" \
  -d '{"usage":"all","full":true}'
```

Expect:

```json
{"ok":true,"results":[
  {"usage":"eom","scanned":37,"imported":37,"updated":0,"skipped":0,"archived":0,"cursor":"AAF…","error":null},
  {"usage":"marketing","scanned":112,"imported":112,"updated":0,"skipped":0,"archived":0,"cursor":"AAG…","error":null}
]}
```

**Run it a second time. Every folder should come back `imported: 0` with
`skipped` equal to the file count.** That is the real test — it proves the
cursor and the id+rev de-duplication both work, and that a nightly run costs
almost nothing.

Before the credentials exist the same call answers:

```json
{"ok":false,"code":"not_configured","error":"Dropbox is not connected yet: …"}
```

with HTTP 503, and with no auth at all it answers 401.

## 7. The nightly schedule (already applied)

`supabase/migrations/2026-08-22_pg_cron_dropbox.sql` installs `pg_cron` and
schedules **`dropbox-sync-daily`** at `30 7 * * *`. pg_cron runs in the
database's timezone (UTC), so that is about **2:30 a.m. in Kansas City**. It
posts to the function with the same `x-sync-secret` header.

```sql
select jobid, jobname, schedule, active from cron.job where jobname = 'dropbox-sync-daily';

select runid, status, return_message, start_time
  from cron.job_run_details
 where jobid = (select jobid from cron.job where jobname = 'dropbox-sync-daily')
 order by start_time desc limit 5;

select usage, last_synced_at, file_count, last_error from public.dropbox_folders;
```

Pause it without dropping anything:
`update cron.job set active = false where jobname = 'dropbox-sync-daily';`

The admin **"Sync now"** button in the app calls the same function with the
signed-in owner/operator's JWT instead of the secret — `verify_jwt` is FALSE on
this function, so that JWT is re-checked against `employees.role` inside the
function. The header is not authorization by itself and neither is the JWT.

---

## How a sync actually behaves

| Situation | What happens |
|---|---|
| First run | Full `files/list_folder`, everything downloaded, cursor stored |
| Nothing changed | `list_folder/continue` returns no entries — near-zero cost |
| Same file, same rev | skipped without downloading |
| File edited in Dropbox (new rev) | re-downloaded **to the same storage path**, so every signed URL already handed out keeps working |
| Same photo re-uploaded under a new name | matched on Dropbox's `content_hash`, skipped and logged |
| File deleted from Dropbox | `media_assets.archived_at` stamped. **The storage object is never removed** |
| A run fails halfway | the cursor is *not* advanced and the error lands in `dropbox_folders.last_error` — the next run re-reads what it missed |
| `{"full": true}` | ignores the cursor and rescans the whole folder |

## What is stored where — do not shortcut this

- **`integration_secrets`** — the Dropbox app key, app secret and refresh token.
  **RLS is enabled and there are ZERO policies**, which makes the table
  structurally unreachable from any anon or authenticated key, including
  Devon's. Only the service role — the `dropbox-sync` function — can read it.
  That is deliberate and it is not an oversight to fix. Verify it by
  impersonating the **owner** and expecting zero rows.
- **`dropbox_folders`** — sync state only, no credentials. Member read (the crew
  can see when photos last came in), admin write.
- **`media_assets`** — the library index. Member SELECT (marketing shots and EOM
  photos are not money), admin INSERT/UPDATE/DELETE split per verb. The sync
  itself runs as the service role and bypasses all of it.
- **The bytes** go into the existing private **`job-photos`** bucket at
  `eom/library/<dropboxId>.<ext>` and `marketing/<YYYY>/<dropboxId>.<ext>`.
  That bucket has no UPDATE policy, so a stable path can only be rewritten by
  the service role — which is exactly who writes these. **Never upload to those
  two prefixes from the client**, and make sure "delete this month's Employee of
  the Month" never removes an `eom/library/*` object.
- **`DROPBOX_SYNC_SECRET`** is an edge-function secret and is also embedded in
  the pg_cron job body. The `cron` schema is not readable by the `authenticated`
  role (verified — even the owner gets `permission denied for schema cron`), so
  that is not a leak, but it does mean **rotating the secret means re-running
  the cron migration**, not just changing the function secret.

## Owner follow-ups this produces

| Value | Where it comes from | Goes where |
|---|---|---|
| App key | Dropbox app → Settings | `integration_secrets.client_id` |
| App secret | Dropbox app → Settings | `integration_secrets.client_secret` |
| Refresh token | step 4b | `integration_secrets.refresh_token` |
| (already generated + set) | — | `DROPBOX_SYNC_SECRET` edge-function secret |
