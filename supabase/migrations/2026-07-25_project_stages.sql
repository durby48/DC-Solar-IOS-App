-- Migration 6: pipeline stages for jobs.
-- Run in Supabase dashboard → SQL Editor. Re-runnable.
--
-- Adds jobs.stage with the 7 pipeline stages. The legacy jobs.status column
-- stays and remains in sync (the app writes both) so the dcsolarkc.com ops
-- console keeps working unchanged.

alter table public.jobs add column if not exists stage text
  check (stage is null or stage in (
    'Pending Estimate','Pending Contract','Pending Removal',
    'Pending Reinstall','Pending Permit','Pending Payment','Complete'));

-- Backfill: completed jobs → Complete; everything else starts at Pending
-- Estimate (Devon can set the real stage per job from the app's editor).
update public.jobs
set stage = case when status = 'completed' then 'Complete' else 'Pending Estimate' end
where stage is null;
