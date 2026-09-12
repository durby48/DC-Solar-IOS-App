-- payroll_runs: one row per Gusto RECEIPT, not per period (2026-09-12, night).
--
-- The morning's `2026-09-12_payroll_runs_kind.sql` replaced unique
-- (company, period_end) with (company, period_end, kind) so an off-cycle
-- correction could share its period_end with the next regular run. That still
-- collapses two off-cycle runs for the same period (two people corrected on
-- different days, or a correction plus a transition run) into one slot, and
-- the app's upsert would silently overwrite the first with the second.
--
-- Now the natural key is (company, period_end, receipt_id): every Gusto run
-- has its own receipt, so every run gets its own row, whatever its kind.
-- NULLS NOT DISTINCT (Postgres 15+) keeps the "re-save the same period to fix
-- a typo" behaviour for runs recorded without a receipt id: there can be at
-- most one receipt-less row per period, and re-saving it updates in place.
-- The app edits an existing run by `id`, so changing a receipt id on a row
-- never forks it.
--
-- "Paid through" for the accrual estimate is company_settings.payroll_through
-- (advanced by the app only for REGULAR runs), never max(period_end) over this
-- table — see lib/financials.ts + lib/payroll.ts. Idempotent.

begin;

-- Drop the per-kind key (and the original per-period key if a database ever
-- skipped the kind migration).
do $$
declare
  c record;
begin
  for c in
    select conname
      from pg_constraint
     where conrelid = 'public.payroll_runs'::regclass
       and contype = 'u'
       and pg_get_constraintdef(oid) in (
         'UNIQUE (company, period_end)',
         'UNIQUE (company, period_end, kind)'
       )
  loop
    execute format('alter table public.payroll_runs drop constraint %I', c.conname);
  end loop;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payroll_runs_company_period_end_receipt_key'
  ) then
    alter table public.payroll_runs
      add constraint payroll_runs_company_period_end_receipt_key
      unique nulls not distinct (company, period_end, receipt_id);
  end if;
end $$;

comment on constraint payroll_runs_company_period_end_receipt_key on public.payroll_runs is
  'One row per Gusto receipt. Off-cycle runs may share a period_end with the regular run; '
  'a receipt-less run is unique per period (nulls not distinct) so re-saving it updates in place.';

comment on table public.payroll_runs is
  'Completed Gusto payroll runs, one row per receipt. Labor in Financials = Σ total_withdrawn + the '
  'loaded estimate for hours after company_settings.payroll_through (advanced by regular runs only).';

commit;

-- Verify:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.payroll_runs'::regclass and contype = 'u';
--   -- exactly one: UNIQUE NULLS NOT DISTINCT (company, period_end, receipt_id)
