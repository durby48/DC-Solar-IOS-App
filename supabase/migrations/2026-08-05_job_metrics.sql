-- Job metrics + customer avatars (2026-08-05 pipeline overhaul II).
--
-- Backstory that explains the design: module counts were only ever recorded in
-- the free-text job NAME, in six different formats ("(22 modules)",
-- "- 38 Modules", "43 panel removal", and one typo'd "18 mobules"). Deriving
-- company statistics by re-parsing that text on every render would mean a typo
-- fix silently changes the numbers, and 6 of 25 jobs parse to nothing at all.
-- So the parser now only SEEDS these columns; the columns are the truth and are
-- editable in the job editor.
--
-- Idempotent: safe to re-run.

alter table public.jobs add column if not exists module_count integer;
alter table public.jobs add column if not exists job_type text;
alter table public.jobs add column if not exists critter_guard_panels integer;
-- Company Home Base (DC-26026) is our own building, not customer work. Without
-- this flag it inflates "projects completed".
alter table public.jobs add column if not exists is_internal boolean not null default false;

comment on column public.jobs.module_count is
  'Panels/modules on this job. Seeded from the job name by lib/jobs.ts::parseModuleCount, then hand-editable.';
comment on column public.jobs.job_type is
  'R&R | Reinstall | Install | Critter Guard | Other. Selects the hours-per-module coefficient used to forecast future jobs.';

-- Customer contact photo. Stored in the EXISTING private job-photos bucket so
-- it inherits that bucket's policies — no new bucket, no new storage policies.
alter table public.customers add column if not exists photo_path text;
