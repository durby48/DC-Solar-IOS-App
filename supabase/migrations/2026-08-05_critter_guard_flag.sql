-- Critter guard as a per-job FLAG, not a job type (2026-08-05).
--
-- Migration 20 only allowed critter guard to be recorded via job_type =
-- 'Critter Guard', i.e. a standalone job. In reality most critter guard is
-- installed as part of an R&R, so those panels were invisible to the company
-- metrics. This adds a toggle any job can carry, whatever its type.
--
-- Panel count resolution (see lib/metrics.ts): when the flag is on, use
-- critter_guard_panels if set, otherwise fall back to the job's module_count —
-- guard normally covers the whole array, so the count follows the module count
-- automatically and stays correct if the module count is later corrected.
--
-- Only COMPLETE jobs contribute to the metric; a job carrying the flag while
-- still in progress doesn't count until it's finished.
--
-- Idempotent: safe to re-run.

alter table public.jobs
  add column if not exists has_critter_guard boolean not null default false;

comment on column public.jobs.has_critter_guard is
  'Critter guard was installed on this job. Independent of job_type — most critter guard rides along with an R&R.';

-- Existing standalone critter-guard jobs carry the flag by definition.
update public.jobs
   set has_critter_guard = true
 where company = 'dc-solar'
   and job_type = 'Critter Guard'
   and has_critter_guard = false;
