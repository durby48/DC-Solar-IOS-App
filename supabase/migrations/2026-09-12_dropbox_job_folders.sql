-- Dropbox: one folder per job, and every job photo mirrored into it.
-- (2026-09-12)
--
-- WHY THIS EXISTS
--
-- Devon: "any pictures uploaded into any project should be stored in a
-- Dropbox folder. So when a project is made in the pipeline it should
-- automatically make a Dropbox folder too." Crews upload roof photos through
-- the app into the private `job-photos` bucket; until now those never reached
-- Dropbox, and the Dropbox integration was strictly one way (Dropbox → app).
--
-- HOW IT WORKS — the database is the queue, the HTTP call is only a nudge.
--
--   jobs INSERT (not is_internal)
--     └─ trigger inserts a `dropbox_job_folders` row (status 'queued') and
--        fires pg_net POST {action:'ensure_job_folder', job_id} at dropbox-sync.
--   job_photos INSERT
--     └─ trigger inserts a `dropbox_photo_mirrors` row (status 'queued') and
--        fires pg_net POST {action:'mirror_photo', photo_id}.
--   every 15 minutes (pg_cron `dropbox-mirror-retry`)
--     └─ POST {action:'retry_mirrors'}: the function drains anything still
--        queued or failed with fewer than 5 attempts. So a lost HTTP call, a
--        Dropbox outage, or "Dropbox was not connected yet when the photo was
--        taken" all self-heal — nothing is ever dropped on the floor.
--
-- The edge function does the Dropbox work (docs/DROPBOX_SETUP.md). Folders
-- land at `/DC Solar/Jobs/<job_number> - <customer>` inside the Dropbox app
-- folder; photos are uploaded with mode=add + autorename, so Dropbox is an
-- append-only ARCHIVE: deleting a photo in the app never deletes it there.
--
-- NOTHING HERE CAN FAIL A JOB OR A PHOTO. Both trigger functions swallow every
-- error (and pg_net is asynchronous anyway): if Dropbox is down, unconfigured,
-- or the secret is wrong, the row simply stays 'queued' for the retry cron.
--
-- WHY NOT dropbox_folders. Its primary key is (company, usage) with usage in
-- ('eom','marketing') and the nightly sync iterates EVERY row of it as a
-- folder to pull photos FROM. Job folders are pushed TO, one per job, so they
-- get their own table rather than a check-constraint relaxation that would
-- make the nightly sync try to import every job folder as marketing photos.
--
-- ⚠️ THE SECRET IS A PLACEHOLDER IN THIS FILE ON PURPOSE.
-- `__DROPBOX_SYNC_SECRET__` must be replaced with the real value of the
-- DROPBOX_SYNC_SECRET edge-function secret before this is run (it lives in
-- `C:\Durbin Enterprises\config\secrets\dropbox-sync-secret.txt`, outside the
-- repo) — the same convention as 2026-08-22_pg_cron_dropbox.sql. The secret
-- appears in exactly one place below (`dropbox_sync_post`); the triggers and
-- the retry cron all go through that function, so rotating the secret means
-- re-running THIS file and the daily-cron file, nothing else.
--
-- Idempotent: safe to re-run.

begin;

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- 1. dropbox_job_folders — one Dropbox folder per (non-internal) job
-- ---------------------------------------------------------------------------
create table if not exists public.dropbox_job_folders (
  job_id            uuid primary key references public.jobs(id) on delete cascade,
  company           text not null default 'dc-solar',
  -- What the function created, once it has. path_lower is Dropbox's stable
  -- case-insensitive identifier; path_display is what a person sees.
  path_display      text,
  path_lower        text,
  dropbox_folder_id text,
  status            text not null default 'queued'
                    check (status in ('queued', 'ready', 'failed', 'skipped')),
  attempts          int  not null default 0,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists dropbox_job_folders_pending_idx
  on public.dropbox_job_folders (updated_at)
  where status in ('queued', 'failed');

comment on table public.dropbox_job_folders is
  'One Dropbox folder per job (/DC Solar/Jobs/<number> - <customer>). '
  'Written only by the dropbox-sync edge function (service role). Admin '
  'SELECT so the owner can see what is queued or failed; no client writes. '
  'The folder is NOT renamed when a job is renamed (future step).';

alter table public.dropbox_job_folders enable row level security;

drop policy if exists djf_admin_select on public.dropbox_job_folders;
create policy djf_admin_select on public.dropbox_job_folders
  for select using (public.is_company_admin(company));
-- No INSERT / UPDATE / DELETE policy on purpose: the service role writes.

-- ---------------------------------------------------------------------------
-- 2. dropbox_photo_mirrors — one row per job photo pushed to Dropbox
-- ---------------------------------------------------------------------------
create table if not exists public.dropbox_photo_mirrors (
  id                    uuid primary key default gen_random_uuid(),
  -- SET NULL, not CASCADE: deleting a photo in the app must leave the record
  -- of what went to Dropbox (the file itself is never deleted there).
  photo_id              uuid references public.job_photos(id) on delete set null,
  job_id                uuid not null references public.jobs(id) on delete cascade,
  company               text not null default 'dc-solar',
  storage_bucket        text not null default 'job-photos',
  storage_path          text not null,
  status                text not null default 'queued'
                        check (status in ('queued', 'mirrored', 'failed', 'skipped')),
  attempts              int  not null default 0,
  last_error            text,
  dropbox_id            text,
  dropbox_path_lower    text,
  dropbox_path_display  text,
  dropbox_rev           text,
  content_hash          text,
  size_bytes            bigint,
  mirrored_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists dropbox_photo_mirrors_photo_uq
  on public.dropbox_photo_mirrors (photo_id) where photo_id is not null;

create index if not exists dropbox_photo_mirrors_pending_idx
  on public.dropbox_photo_mirrors (updated_at)
  where status in ('queued', 'failed');

create index if not exists dropbox_photo_mirrors_job_idx
  on public.dropbox_photo_mirrors (job_id);

comment on table public.dropbox_photo_mirrors is
  'Every job photo copied into the job''s Dropbox folder, with its Dropbox id '
  'and status (queued / mirrored / failed / skipped). Written only by the '
  'dropbox-sync edge function. Admin SELECT, no client writes. Dropbox is an '
  'append-only archive: an app-side delete never removes the Dropbox file.';

alter table public.dropbox_photo_mirrors enable row level security;

drop policy if exists dpm_admin_select on public.dropbox_photo_mirrors;
create policy dpm_admin_select on public.dropbox_photo_mirrors
  for select using (public.is_company_admin(company));
-- No INSERT / UPDATE / DELETE policy on purpose: the service role writes.

-- ---------------------------------------------------------------------------
-- 3. dropbox_sync_post — the ONE place the shared secret lives in SQL
-- ---------------------------------------------------------------------------
-- pg_net is asynchronous: this enqueues an HTTP request and returns. A failed
-- POST is a row in net._http_response, never an error here. Wrapped anyway so
-- a missing extension or a malformed header can never surface to a caller.
create or replace function public.dropbox_sync_post(p_body jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url     := 'https://kjamxfezsathrsbztiln.supabase.co/functions/v1/dropbox-sync',
    headers := jsonb_build_object(
                 'content-type',  'application/json',
                 'x-sync-secret', '__DROPBOX_SYNC_SECRET__'
               ),
    body    := p_body,
    timeout_milliseconds := 60000
  );
exception when others then
  raise warning 'dropbox_sync_post: %', sqlerrm;
end;
$$;

-- Only triggers and cron may call it; a client key must not be able to make
-- the database fire requests at the function.
revoke all on function public.dropbox_sync_post(jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Triggers — enqueue a row, then nudge the function. Never fail the write.
-- ---------------------------------------------------------------------------
create or replace function public.dropbox_job_folder_enqueue()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if coalesce(new.is_internal, false) then
      return new;
    end if;
    insert into public.dropbox_job_folders (job_id, company)
      values (new.id, coalesce(new.company, 'dc-solar'))
      on conflict (job_id) do nothing;
    perform public.dropbox_sync_post(
      jsonb_build_object('action', 'ensure_job_folder', 'job_id', new.id)
    );
  exception when others then
    -- Dropbox is a convenience; creating the job is not. Swallow everything.
    raise warning 'dropbox_job_folder_enqueue: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists jobs_dropbox_folder_trg on public.jobs;
create trigger jobs_dropbox_folder_trg
  after insert on public.jobs
  for each row
  execute function public.dropbox_job_folder_enqueue();

create or replace function public.dropbox_photo_mirror_enqueue()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_internal boolean;
begin
  begin
    select coalesce(j.is_internal, false) into v_internal
      from public.jobs j where j.id = new.job_id;
    if coalesce(v_internal, false) then
      return new;
    end if;
    insert into public.dropbox_photo_mirrors
        (photo_id, job_id, company, storage_bucket, storage_path)
      values
        (new.id, new.job_id, coalesce(new.company, 'dc-solar'), 'job-photos', new.storage_path)
      on conflict (photo_id) where photo_id is not null do nothing;
    perform public.dropbox_sync_post(
      jsonb_build_object('action', 'mirror_photo', 'photo_id', new.id)
    );
  exception when others then
    -- The crew's upload must never fail because of Dropbox.
    raise warning 'dropbox_photo_mirror_enqueue: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists job_photos_dropbox_mirror_trg on public.job_photos;
create trigger job_photos_dropbox_mirror_trg
  after insert on public.job_photos
  for each row
  execute function public.dropbox_photo_mirror_enqueue();

-- ---------------------------------------------------------------------------
-- 5. dropbox_enqueue_backlog — the one-time backfill's enqueue half
-- ---------------------------------------------------------------------------
-- Called by the edge function (service role) from the backfill actions. Adds a
-- queued row for every non-internal job without a folder row and every photo
-- of a non-internal job without a mirror row, bounded per call; optionally
-- resets 'failed' rows to 'queued' with attempts = 0 (what you want after
-- fixing the Dropbox scope). Pure bookkeeping — no HTTP, no Dropbox.
create or replace function public.dropbox_enqueue_backlog(
  p_jobs int default 200,
  p_photos int default 200,
  p_reset_failed boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jobs   int := 0;
  v_photos int := 0;
  v_reset  int := 0;
  v_tmp    int := 0;
begin
  insert into public.dropbox_job_folders (job_id, company)
  select j.id, coalesce(j.company, 'dc-solar')
    from public.jobs j
   where coalesce(j.is_internal, false) = false
     and not exists (select 1 from public.dropbox_job_folders f where f.job_id = j.id)
   order by j.created_at
   limit greatest(coalesce(p_jobs, 0), 0);
  get diagnostics v_jobs = row_count;

  insert into public.dropbox_photo_mirrors (photo_id, job_id, company, storage_bucket, storage_path)
  select p.id, p.job_id, coalesce(p.company, 'dc-solar'), 'job-photos', p.storage_path
    from public.job_photos p
    join public.jobs j on j.id = p.job_id
   where coalesce(j.is_internal, false) = false
     and not exists (select 1 from public.dropbox_photo_mirrors m where m.photo_id = p.id)
   order by p.created_at
   limit greatest(coalesce(p_photos, 0), 0);
  get diagnostics v_photos = row_count;

  if p_reset_failed then
    update public.dropbox_job_folders
       set status = 'queued', attempts = 0, updated_at = now()
     where status = 'failed';
    get diagnostics v_tmp = row_count;
    v_reset := v_reset + v_tmp;

    update public.dropbox_photo_mirrors
       set status = 'queued', attempts = 0, updated_at = now()
     where status = 'failed';
    get diagnostics v_tmp = row_count;
    v_reset := v_reset + v_tmp;
  end if;

  return jsonb_build_object(
    'jobs_enqueued', v_jobs,
    'photos_enqueued', v_photos,
    'reset', v_reset
  );
end;
$$;

revoke all on function public.dropbox_enqueue_backlog(int, int, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Retry cron — every 15 minutes, drain queued/failed rows (< 5 attempts)
-- ---------------------------------------------------------------------------
-- The body carries NO secret: it goes through dropbox_sync_post above.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'dropbox-mirror-retry') then
    perform cron.unschedule('dropbox-mirror-retry');
  end if;
end
$$;

select cron.schedule(
  'dropbox-mirror-retry',
  '*/15 * * * *',
  $job$ select public.dropbox_sync_post(jsonb_build_object('action', 'retry_mirrors')); $job$
);

commit;

-- ===========================================================================
-- VERIFY (run after applying; everything below is read-only or rolled back)
-- ===========================================================================
--
-- Objects exist:
--   select tablename, policyname, cmd from pg_policies
--    where schemaname = 'public'
--      and tablename in ('dropbox_job_folders', 'dropbox_photo_mirrors')
--    order by tablename, policyname;
--   -- expect exactly two rows, both cmd = SELECT (djf_admin_select, dpm_admin_select)
--
--   select tgname, tgrelid::regclass from pg_trigger
--    where tgname in ('jobs_dropbox_folder_trg', 'job_photos_dropbox_mirror_trg');
--
--   select jobid, jobname, schedule, active from cron.job
--    where jobname in ('dropbox-sync-daily', 'dropbox-mirror-retry');
--
-- The client roles cannot fire HTTP requests or enqueue backlog:
--   select has_function_privilege('authenticated', 'public.dropbox_sync_post(jsonb)', 'execute')      as post_auth,
--          has_function_privilege('anon',          'public.dropbox_sync_post(jsonb)', 'execute')      as post_anon,
--          has_function_privilege('authenticated', 'public.dropbox_enqueue_backlog(int,int,boolean)', 'execute') as backlog_auth;
--   -- expect: false, false, false
--
-- RLS, PROVEN BY IMPERSONATION (the owner reads; nobody writes; a viewer sees nothing):
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"email":"devonsd311@gmail.com","role":"authenticated"}';
--   select count(*) from public.dropbox_job_folders;      -- owner: readable (a number, no error)
--   select count(*) from public.dropbox_photo_mirrors;    -- owner: readable
--   insert into public.dropbox_job_folders (job_id)
--     select id from public.jobs limit 1;                 -- expect: denied (RLS, no insert policy)
--   rollback;
--
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"email":"devonsd311@gmail.com","role":"authenticated"}';
--   update public.dropbox_photo_mirrors set status = 'mirrored'; -- expect: 0 rows (no update policy)
--   delete from public.dropbox_job_folders;                      -- expect: 0 rows (no delete policy)
--   rollback;
--
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"email":"snettleton2005@gmail.com","role":"authenticated"}';
--   select count(*) from public.dropbox_job_folders;      -- viewer: expect 0
--   select count(*) from public.dropbox_photo_mirrors;    -- viewer: expect 0
--   select public.dropbox_sync_post('{}'::jsonb);         -- expect: permission denied for function
--   rollback;
--
-- The triggers never break a write, even with Dropbox unconfigured — inside a
-- rolled-back transaction as the postgres role:
--   begin;
--   insert into public.jobs (company, name, job_number)
--     values ('dc-solar', 'dropbox probe', 'DC-PROBE') returning id;
--   select job_id, status, attempts from public.dropbox_job_folders
--    where job_id = (select id from public.jobs where job_number = 'DC-PROBE');
--   -- expect: one row, status 'queued', attempts 0
--   rollback;
--
-- Watch it work:
--   select job_id, status, attempts, path_display, last_error from public.dropbox_job_folders
--    order by updated_at desc limit 10;
--   select status, count(*) from public.dropbox_photo_mirrors group by status;
--   select id, status_code, created from net._http_response order by created desc limit 5;
--   select runid, status, return_message, start_time from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'dropbox-mirror-retry')
--    order by start_time desc limit 5;
--
-- Pause the retry loop without dropping anything:
--   update cron.job set active = false where jobname = 'dropbox-mirror-retry';
