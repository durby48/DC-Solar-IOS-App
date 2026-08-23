-- Module wattage per job (2026-08-22).
--
-- Every kW figure derived from a job was computed as module_count × 0.4,
-- because 400 W was the only wattage the database knew. DC-26019 "The Oberlin
-- Beast" runs 600 W class modules — 39 panels, 23.4 kWdc as contracted — so
-- card-forge would rate it 15.6 kW and `rare` instead of `legendary`: the
-- single largest residual in the card-forge calibration (docs/CARD_FORGE.md,
-- "How well it fits").
--
-- NULL IS SEMANTIC: null means "assume 400 W", the company's standard module.
-- Readers resolve it as coalesce(module_watts, 400). The column is deliberately
-- NOT defaulted to 400, so a job nobody checked stays distinguishable from a
-- job somebody did.
--
-- Idempotent: safe to re-run.

begin;

alter table public.jobs
  add column if not exists module_watts integer;

comment on column public.jobs.module_watts is
  'Nameplate watts per module on this job. NULL means "assume 400 W" (the company standard) — readers use coalesce(module_watts, 400). Set it only when the job runs something else, e.g. 600 W class modules.';

-- Residential modules run roughly 250–700 W today; the band is wide on purpose
-- and only exists to catch a panel COUNT typed into the wattage box.
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.jobs'::regclass
       and conname = 'jobs_module_watts_check'
  ) then
    alter table public.jobs
      add constraint jobs_module_watts_check
      check (module_watts is null or module_watts between 100 and 1000);
  end if;
end $$;

-- The one job known to run 600 W modules: 39 panels, 23.4 kWdc as contracted.
-- Guarded on null so a later deliberate edit is never overwritten by a re-run.
update public.jobs
   set module_watts = 600
 where company = 'dc-solar'
   and job_number = 'DC-26019'
   and module_watts is null;

commit;
