-- Nightly Dropbox photo sync, scheduled inside Postgres.
-- (2026-08-22, Workstream H of the 2026-08 overhaul — OPTIONAL)
--
-- WHY THIS IS ITS OWN FILE
--
-- Everything else in the overhaul is additive schema. This one installs an
-- extension and creates a background job that calls the internet on a
-- schedule, which is a different class of change: if it misbehaves it
-- misbehaves at 2:30 in the morning with nobody watching. Keeping it separate
-- means the media_dropbox migration can be applied, reviewed and rolled
-- forward without also committing to a cron daemon.
--
-- WHAT IT NEEDS
--   pg_net  — installed already (0.20.3, verified 2026-08-22). This is the
--             half that makes an HTTP POST from SQL possible.
--   pg_cron — available (1.6.4) but NOT installed. `create extension` below
--             installs it into the `postgres` database, which is where
--             Supabase wants it.
--
-- If `create extension pg_cron` fails on this project, do not fight it: point
-- a Vercel cron (or any scheduler) at
--   POST https://kjamxfezsathrsbztiln.supabase.co/functions/v1/dropbox-sync
--   header  x-sync-secret: <DROPBOX_SYNC_SECRET>
-- and skip this file entirely. The function is identical either way.
--
-- ⚠️ THE SECRET IS A PLACEHOLDER IN THIS FILE ON PURPOSE.
--
-- `__DROPBOX_SYNC_SECRET__` below must be replaced with the real value of the
-- DROPBOX_SYNC_SECRET edge-function secret BEFORE this is run. The real value
-- lives in `C:\Durbin Enterprises\config\secrets\dropbox-sync-secret.txt`,
-- outside the repo, next to the Supabase access token — never paste it into a
-- migration that gets committed. Substituting at apply time is the whole
-- reason this file reads oddly.
--
-- TIMES ARE UTC. pg_cron on Supabase runs in the database's timezone, which is
-- UTC, so `30 7 * * *` is 2:30 a.m. in Kansas City during daylight saving and
-- 1:30 a.m. in winter. That is deliberate: the sync should have finished long
-- before anyone opens the app, and Dropbox rate limits are irrelevant at that
-- hour.
--
-- Idempotent: safe to re-run. Unschedules the job by name before recreating
-- it, so editing the schedule or the body never leaves two jobs racing.

begin;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Re-running must not stack up duplicate jobs. cron.unschedule raises when the
-- job does not exist, so it is guarded rather than wrapped in a coalesce.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'dropbox-sync-daily') then
    perform cron.unschedule('dropbox-sync-daily');
  end if;
end
$$;

select cron.schedule(
  'dropbox-sync-daily',
  '30 7 * * *',
  $job$
    select net.http_post(
      url     := 'https://kjamxfezsathrsbztiln.supabase.co/functions/v1/dropbox-sync',
      headers := jsonb_build_object(
                   'content-type',  'application/json',
                   'x-sync-secret', '__DROPBOX_SYNC_SECRET__'
                 ),
      body    := jsonb_build_object('usage', 'all'),
      timeout_milliseconds := 60000
    );
  $job$
);

commit;

-- Verify:
--   select jobid, jobname, schedule, active from cron.job
--    where jobname = 'dropbox-sync-daily';
--
-- Watch a run (pg_cron records the job, pg_net records the HTTP call):
--   select runid, status, return_message, start_time
--     from cron.job_run_details
--    where jobid = (select jobid from cron.job where jobname = 'dropbox-sync-daily')
--    order by start_time desc limit 5;
--   select id, status_code, content_type, created
--     from net._http_response order by created desc limit 5;
--
-- And the app-visible result:
--   select usage, last_synced_at, file_count, last_error from public.dropbox_folders;
--
-- Turn it off without dropping anything:
--   update cron.job set active = false where jobname = 'dropbox-sync-daily';
