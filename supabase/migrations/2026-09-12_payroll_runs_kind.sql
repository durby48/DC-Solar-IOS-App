-- payroll_runs.kind — regular vs off-cycle runs (2026-09-12).
--
-- Chase/Gusto runs OFF-CYCLE payrolls (a correction for one person, a
-- transition between pay schedules) whose period can overlap or share its
-- end date with the next regular run. The table's unique (company,
-- period_end) would make the next regular run OVERWRITE such a row through
-- the app's upsert, and every reader took max(period_end) as "paid through
-- for everyone", so one person's correction marked the whole crew's period
-- as paid and labor was understated.
--
-- Now: `kind` ('regular' | 'off_cycle', default regular), uniqueness on
-- (company, period_end, kind), and the app derives "paid through" from
-- REGULAR runs only (lib/financials.ts, lib/valuation.ts). Off-cycle runs
-- still count in labor by payday. Idempotent.

begin;

alter table public.payroll_runs
  add column if not exists kind text not null default 'regular';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payroll_runs_kind_check'
  ) then
    alter table public.payroll_runs
      add constraint payroll_runs_kind_check check (kind in ('regular', 'off_cycle'));
  end if;
end $$;

-- Replace unique (company, period_end) with (company, period_end, kind).
do $$
declare
  c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.payroll_runs'::regclass
       and contype = 'u'
       and pg_get_constraintdef(oid) = 'UNIQUE (company, period_end)'
  loop
    execute format('alter table public.payroll_runs drop constraint %I', c.conname);
  end loop;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payroll_runs_company_period_end_kind_key'
  ) then
    alter table public.payroll_runs
      add constraint payroll_runs_company_period_end_kind_key unique (company, period_end, kind);
  end if;
end $$;

comment on column public.payroll_runs.kind is
  'regular = a scheduled pay period for the whole crew (advances "paid through"); '
  'off_cycle = a correction / transition run for some people (counts in labor, never advances paid-through).';

-- The one off-cycle run recorded so far: Ben Nettleton's correction (Gusto
-- receipt baee358c…, period 2026-08-31 → 2026-09-13, payday 2026-09-14).
update public.payroll_runs
   set kind = 'off_cycle'
 where company = 'dc-solar'
   and receipt_id = 'baee358c-e36a-4d4f-96de-d8a33a6184ab'
   and kind <> 'off_cycle';

commit;

-- Verify:
--   select period_start, period_end, payday, kind from public.payroll_runs order by payday;
--   -- exactly one off_cycle row (2026-09-13), the rest regular
