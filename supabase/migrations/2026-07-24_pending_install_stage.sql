-- Migration 8: add the 'Pending Install' pipeline stage.
-- Run in Supabase dashboard → SQL Editor. Re-runnable.
--
-- New-install jobs (no removal/reinstall) get their own stage, same weight
-- as Pending Reinstall. Only the CHECK constraint changes — no data moves.

alter table public.jobs drop constraint if exists jobs_stage_check;
alter table public.jobs add constraint jobs_stage_check
  check (stage is null or stage in (
    'Pending Estimate','Pending Contract','Pending Removal',
    'Pending Reinstall','Pending Install','Pending Permit',
    'Pending Payment','Complete'));
