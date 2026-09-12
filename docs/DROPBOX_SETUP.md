# Dropbox — setup, job folders and photo mirroring

Two things run between the app and Dropbox, both through the one
`dropbox-sync` edge function and the one Dropbox app:

1. **Library, Dropbox → app (since 2026-08-22).** Devon drops photos into
   `EOM/` and `Marketing/` and a nightly sync mirrors them into the app
   (Employee of the Month picker, Sales → Photos). One way; never deletes.
2. **Job folders, app → Dropbox (since 2026-09-12).** Every project made in
   the pipeline gets its own Dropbox folder, and every photo a crew uploads
   to that job is copied into it. Append-only: the function creates folders
   and adds files, and **never deletes, moves or overwrites anything in
   Dropbox**. Deleting a photo in the app does not touch the Dropbox copy —
   Dropbox is the archive.

## Current status (checked live 2026-09-12)

| Piece | State |
|---|---|
| Dropbox app credentials (`integration_secrets`, provider `dropbox`) | **Connected.** Client id, secret and refresh token present; access token refreshed by the nightly run at 07:30 UTC today. |
| Nightly library sync (`dropbox-sync-daily`, `30 7 * * *`) | **Active, healthy.** `/eom` 5 files, `/marketing` 13 files, `last_error` null, `media_assets` 18 rows. |
| Extensions | `pg_cron` 1.6.4 and `pg_net` 0.20.3 installed. |
| Edge-function secrets | `DROPBOX_SYNC_SECRET` set (also `NOTIFY_SECRET`, Twilio, Gmail, Gemini, PDF ones). Nothing Dropbox-specific is missing there. |
| Jobs / photos to backfill | 36 non-internal jobs, 102 job photos. |
| **Write scope** | **Almost certainly missing.** The August setup ticked only `files.metadata.read` + `files.content.read` on purpose. Creating folders and uploading needs `files.content.write`. Until Devon adds it and re-mints the refresh token (steps A–B below), every folder/photo attempt is recorded as `failed` with an error that says exactly this, and nothing else in the app is affected. |

## What Devon has to do once (~5 min)

**A. Add the write scope.** https://www.dropbox.com/developers/apps → the
`DC Solar KC` app → **Permissions** → tick `files.content.write` (keep the two
read scopes) → **Submit**. Scopes must be submitted *before* the next step —
a token minted first carries the old scope set.

**B. Mint a new refresh token** — a token's scopes are frozen when it is
issued, so the existing one cannot gain the write scope. Same as the original
step 4:

```
https://www.dropbox.com/oauth2/authorize?client_id=<APP_KEY>&response_type=code&token_access_type=offline
```

then

```
curl -X POST https://api.dropbox.com/oauth2/token \
  -u "<APP_KEY>:<APP_SECRET>" \
  -d code=<THE_CODE> -d grant_type=authorization_code
```

Check that `scope` in the reply lists `files.content.write`. Store it with the
same statement as before (the `access_token = null, expires_at = null` part
forces the function to mint a fresh access token under the new scope):

```
curl -X POST "https://api.supabase.com/v1/projects/kjamxfezsathrsbztiln/database/query" \
  -H "Authorization: Bearer <SUPABASE_PAT>" -H "Content-Type: application/json" \
  -d '{"query":"update public.integration_secrets set refresh_token = '"'"'<REFRESH_TOKEN>'"'"', access_token = null, expires_at = null, updated_at = now() where company = '"'"'dc-solar'"'"' and provider = '"'"'dropbox'"'"';"}'
```

The PAT lives in `C:\Durbin Enterprises\config\secrets\supabase-access-token.txt`.
Never paste the app secret or the refresh token into a file inside this repo.

**C. Run the backfill** (below) so the 36 existing jobs get folders and the
102 existing photos land in them.

---

## Job folders + photo mirroring — how it works

```
jobs INSERT (not is_internal)
  └─ trigger jobs_dropbox_folder_trg
       inserts dropbox_job_folders (status 'queued')
       pg_net POST {action:'ensure_job_folder', job_id}  ──▶ dropbox-sync
                                                              creates /DC Solar/Jobs/<job_number> - <customer>
                                                              records id + path, status 'ready'
job_photos INSERT
  └─ trigger job_photos_dropbox_mirror_trg
       inserts dropbox_photo_mirrors (status 'queued')
       pg_net POST {action:'mirror_photo', photo_id}  ─────▶ dropbox-sync
                                                              ensures the job folder first,
                                                              downloads the object from job-photos (service role),
                                                              files/upload  mode=add  autorename=true,
                                                              records Dropbox id/path/rev, status 'mirrored'
every 15 min  (pg_cron dropbox-mirror-retry)
  └─ POST {action:'retry_mirrors'} ─────────────────────────▶ drains queued/failed rows with < 5 attempts
```

**The rows are the queue; the HTTP call is only a nudge.** pg_net is
asynchronous and both trigger functions swallow every error, so creating a
job or uploading a photo can never fail because of Dropbox. If the call is
lost, Dropbox is down, the scope is missing, or Dropbox was not connected at
all when the photo was taken, the row stays `queued`/`failed` and the cron
picks it up — up to 5 attempts, then it waits for a backfill with
`reset_failed`.

**Folder naming.** `/DC Solar/Jobs/<job_number> - <customer name>`, e.g.
`/DC Solar/Jobs/DC-26037 - Cromwell Environmental`. No customer → the job
name; slashes become dashes, control characters and trailing dots go, capped
at 120 chars. The Dropbox app has *App folder* access, so on disk that is
`Dropbox/Apps/DC Solar KC/DC Solar/Jobs/…`. A folder that already exists
(made by hand, or by an attempt that never got recorded) is **adopted by id**,
never duplicated.

**File naming.** The app stores `<jobId>/<epochMs>-IMG_7718.jpg`; Dropbox gets
`2026-09-08 IMG_7718.jpg` (the day it was added). Same name on the same day →
Dropbox's autorename appends ` (1)`; nothing is ever overwritten.

**Internal jobs** (`is_internal = true`) get no folder and their photos are
marked `skipped`.

**Not done on purpose (future steps):** renaming a job or changing its number
does **not** rename the Dropbox folder — the mapping is by job id, so photos
keep landing in the original folder. Deleting a job cascades the bookkeeping
rows but leaves Dropbox untouched. Photos taken *before* a job existed, or
attached to internal jobs, are never mirrored.

### Tables (migration `2026-09-12_dropbox_job_folders.sql`)

- **`dropbox_job_folders`** — `job_id` (PK → jobs), `path_display`,
  `path_lower`, `dropbox_folder_id`, `status` (`queued`/`ready`/`failed`/
  `skipped`), `attempts`, `last_error`. Admin SELECT only; the service role
  writes. Cascades when the job is deleted.
- **`dropbox_photo_mirrors`** — one row per photo: `photo_id` (→ job_photos,
  SET NULL on delete so the record of what went to Dropbox survives an
  app-side delete), `job_id`, `storage_path`, `status` (`queued`/`mirrored`/
  `failed`/`skipped`), `attempts`, `last_error`, `dropbox_id`,
  `dropbox_path_display`, `dropbox_rev`, `content_hash`, `size_bytes`,
  `mirrored_at`. Admin SELECT only.
- **`dropbox_sync_post(jsonb)`** — the ONE place the shared secret lives in
  SQL; triggers and the retry cron all go through it. Not executable by
  `anon`/`authenticated`.
- **`dropbox_enqueue_backlog(p_jobs, p_photos, p_reset_failed)`** — the
  backfill's enqueue half (service role only).

These live beside, not inside, `dropbox_folders`: that table's primary key is
`(company, usage)` and the nightly sync treats every row of it as a folder to
pull photos *from*.

### The function's contract

`POST /functions/v1/dropbox-sync` — auth is unchanged: `x-sync-secret:
<DROPBOX_SYNC_SECRET>` (cron, triggers) **or** an owner/operator Bearer JWT
("Sync now"; `verify_jwt` is FALSE, the JWT is re-checked inside).

| Body | Does | Replies |
|---|---|---|
| `{}` or `{usage, full, limit}` | the original nightly library sync — unchanged | `{ok, results:[…]}` |
| `{action:'ensure_job_folder', job_id}` | create/adopt the job's folder | `{ok, path}`; 422 permanent / 502 retryable |
| `{action:'mirror_photo', photo_id}` | folder first, then copy the photo | `{ok, path}`; 422 / 502 |
| `{action:'retry_mirrors', limit?}` | drain queued/failed (< 5 attempts), 25 per call by default, max 100 | `{ok, folders:{tried,ready,failed}, photos:{tried,mirrored,failed}, errors:[…]}` |
| `{action:'backfill_job_folders', limit?, reset_failed?}` | enqueue every job without a row, then drain | as above + `enqueued`, `pending`, `hint` |
| `{action:'backfill_photo_mirrors', limit?, reset_failed?}` | enqueue every photo without a row, then drain | same |

Every action answers **`503 not_configured`** when `integration_secrets` has
no Dropbox row — rows stay queued, nothing is counted as an attempt. A missing
write scope comes back as `502` with the message
`Dropbox refused: the app lacks the files.content.write scope …`, and the
drain stops at the first such error so it does not burn attempts on the rest.
Photo bytes and tokens are never logged.

### The one-time backfill (after steps A–B)

`DROPBOX_SYNC_SECRET` is the edge-function secret. As of 2026-09-12 there is
**no** `dropbox-sync-secret.txt` in `C:\Durbin Enterprises\config\secrets\`
(the August doc said there was); read the value from
`GET https://api.supabase.com/v1/projects/kjamxfezsathrsbztiln/secrets` with
the PAT, or from `select command from cron.job where jobname =
'dropbox-sync-daily'`, and save it there so the next migration apply has it.

```
SECRET=<DROPBOX_SYNC_SECRET>

curl -X POST "https://kjamxfezsathrsbztiln.supabase.co/functions/v1/dropbox-sync" \
  -H "x-sync-secret: $SECRET" -H "content-type: application/json" \
  -d '{"action":"backfill_job_folders","limit":50,"reset_failed":true}'

curl -X POST "https://kjamxfezsathrsbztiln.supabase.co/functions/v1/dropbox-sync" \
  -H "x-sync-secret: $SECRET" -H "content-type: application/json" \
  -d '{"action":"backfill_photo_mirrors","limit":50,"reset_failed":true}'
```

Repeat the second call until `pending.photos` is 0 (102 photos ÷ 50 per call
= three calls), or just let the 15-minute cron finish it. Both are
re-runnable: a job that already has a `ready` folder and a photo already
`mirrored` cost no Dropbox call at all.

### Watching it

```sql
select status, count(*) from public.dropbox_job_folders group by status;
select status, count(*) from public.dropbox_photo_mirrors group by status;

select j.job_number, f.status, f.attempts, f.path_display, f.last_error
  from public.dropbox_job_folders f join public.jobs j on j.id = f.job_id
 order by f.updated_at desc limit 20;

select id, status_code, created from net._http_response order by created desc limit 5;

select jobid, jobname, schedule, active from cron.job
 where jobname in ('dropbox-sync-daily', 'dropbox-mirror-retry');
```

Pause the retry loop without dropping anything:
`update cron.job set active = false where jobname = 'dropbox-mirror-retry';`

### Rotating `DROPBOX_SYNC_SECRET`

The secret is embedded in SQL in exactly two places — `dropbox_sync_post()`
(this migration) and the body of `dropbox-sync-daily` (the 2026-08-22 cron
migration). Rotate = set the new function secret, then re-run both migration
files with the placeholder substituted. The `cron` schema is not readable by
`authenticated` (verified), so neither copy is reachable from the app.

---

## Original setup — the library sync (kept for reference)

Cost **$0** (a free Dropbox Basic account); about 15 minutes, all Devon's.
Until it is done the function answers `503 not_configured` — designed
behaviour, not a bug.

### 1. Create the Dropbox app

https://www.dropbox.com/developers/apps → **Create app** → **Scoped access**
→ **App folder** (*not* Full Dropbox: the app can only ever see
`Dropbox/Apps/DC Solar KC/`) → name it `DC Solar KC`.

### 2. Permissions — three

**Permissions** tab → tick `files.metadata.read`, `files.content.read` and
(since 2026-09-12) `files.content.write` → **Submit**. Scopes must be saved
**before** minting a token.

### 3. Make the library folders

```
Dropbox/Apps/DC Solar KC/EOM/
Dropbox/Apps/DC Solar KC/Marketing/
```

`public.dropbox_folders` is seeded with `/eom` and `/marketing`
(case-insensitive). Subfolders are fine; only `.jpg .jpeg .png .heic .webp`
are picked up. Job folders go under `DC Solar/Jobs/` next to these — the
nightly sync never looks there.

### 4. Mint the refresh token

Authorize with `token_access_type=offline`, exchange the code at
`https://api.dropbox.com/oauth2/token` with `-u "<APP_KEY>:<APP_SECRET>"`,
keep the `refresh_token` (exact commands in steps A–B above).

### 5. Store the credentials

They go in `public.integration_secrets`, **not** in edge-function secrets —
the access token expires every four hours and the function has to *store*
the refreshed one:

```
insert into public.integration_secrets (company, provider, client_id, client_secret, refresh_token)
values ('dc-solar', 'dropbox', '<APP_KEY>', '<APP_SECRET>', '<REFRESH_TOKEN>')
on conflict (company, provider) do update
  set client_id = excluded.client_id, client_secret = excluded.client_secret,
      refresh_token = excluded.refresh_token, access_token = null, expires_at = null,
      updated_at = now();
```

### 6. First library sync

```
curl -X POST "https://kjamxfezsathrsbztiln.supabase.co/functions/v1/dropbox-sync" \
  -H "x-sync-secret: <DROPBOX_SYNC_SECRET>" -H "content-type: application/json" \
  -d '{"usage":"all","full":true}'
```

Run it twice: the second run must come back `imported: 0` with `skipped`
equal to the file count — that proves the cursor and the id+rev
de-duplication work.

### 7. The nightly schedule

`2026-08-22_pg_cron_dropbox.sql` schedules **`dropbox-sync-daily`** at
`30 7 * * *` UTC (about 2:30 a.m. Kansas City).

### How the library sync behaves

| Situation | What happens |
|---|---|
| First run | Full `files/list_folder`, everything downloaded, cursor stored |
| Nothing changed | `list_folder/continue` returns no entries — near-zero cost |
| Same file, same rev | skipped without downloading |
| File edited in Dropbox (new rev) | re-downloaded **to the same storage path**, so signed URLs keep working |
| Same photo re-uploaded under a new name | matched on `content_hash`, skipped |
| File deleted from Dropbox | `media_assets.archived_at` stamped. **The storage object is never removed** |
| A run fails halfway | cursor not advanced; error in `dropbox_folders.last_error` |
| `{"full": true}` | ignores the cursor and rescans |

## What is stored where — do not shortcut this

- **`integration_secrets`** — app key, secret, refresh token. **RLS enabled,
  ZERO policies**: unreachable from any anon or authenticated key, including
  Devon's. Only the service role (the function) reads it. Deliberate.
- **`dropbox_folders`** — library sync state. Member read, admin write.
- **`media_assets`** — the library index. Member SELECT, admin writes.
- **`dropbox_job_folders`, `dropbox_photo_mirrors`** — job-folder bookkeeping.
  Admin SELECT only, service-role writes.
- **The bytes** — the private **`job-photos`** bucket: `eom/library/…`,
  `marketing/<YYYY>/…` (library), `<jobId>/…` (crew uploads, the ones that get
  mirrored *to* Dropbox). Never upload to the library prefixes from a client.
- **`DROPBOX_SYNC_SECRET`** — edge-function secret, embedded in
  `dropbox_sync_post()` and the daily cron body (see *Rotating* above).
