-- Actual completed payroll runs (Gusto pay receipts), so labor cost in the
-- Financials rollup can use the money that REALLY left the account instead of
-- the flat 10.626% employer-burden estimate. One row per run; the estimate
-- still covers hours worked after the newest period_end.
--
-- Admin-only in both directions: payroll totals are the same sensitivity
-- class as messages and finance_entries. Idempotent.

begin;

create table if not exists public.payroll_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  company text not null,
  period_start date not null,
  period_end date not null,
  payday date not null,
  -- Sum of hours × rate for the period — what the crew earned.
  gross_wages numeric not null check (gross_wages >= 0),
  -- What actually left the bank: net pay + every tax, both sides.
  total_withdrawn numeric not null check (total_withdrawn >= 0),
  -- Gusto receipt ID, for tracing a row back to its PDF.
  receipt_id text,
  notes text,
  unique (company, period_end)
);

alter table public.payroll_runs enable row level security;

drop policy if exists payroll_runs_admin_select on public.payroll_runs;
create policy payroll_runs_admin_select on public.payroll_runs
  for select using (is_company_admin(company));

drop policy if exists payroll_runs_admin_insert on public.payroll_runs;
create policy payroll_runs_admin_insert on public.payroll_runs
  for insert with check (is_company_admin(company));

drop policy if exists payroll_runs_admin_update on public.payroll_runs;
create policy payroll_runs_admin_update on public.payroll_runs
  for update using (is_company_admin(company)) with check (is_company_admin(company));

drop policy if exists payroll_runs_admin_delete on public.payroll_runs;
create policy payroll_runs_admin_delete on public.payroll_runs
  for delete using (is_company_admin(company));

-- The four 2026 Gusto runs, from the pay receipts (total withdrawals by Chase
-- + check payments). P3's withdrawal is $2.06 UNDER gross+detail-table taxes —
-- Gusto's own summary rounds differently than its tax table; the withdrawal
-- figure is what the bank saw, so it wins.
insert into public.payroll_runs
  (company, period_start, period_end, payday, gross_wages, total_withdrawn, receipt_id)
values
  ('dc-solar', '2026-06-18', '2026-07-03', '2026-07-10', 1471.00, 1627.32, '27758e4f-d570-4b69-8fba-4aec8ab2f65f'),
  ('dc-solar', '2026-07-04', '2026-07-17', '2026-07-24', 3077.00, 3403.95, '1a4d35ec-e0ca-49af-b990-0d1a3a86dfff'),
  ('dc-solar', '2026-07-18', '2026-08-03', '2026-08-10', 6811.00, 7532.68, 'fc3c6415-b63e-43ea-8036-758c815ad550'),
  ('dc-solar', '2026-08-04', '2026-08-17', '2026-08-24', 3267.50, 3614.25, '65640bd2-360d-421f-8ada-4c2997c3f66b')
on conflict (company, period_end) do update
  set gross_wages = excluded.gross_wages,
      total_withdrawn = excluded.total_withdrawn,
      payday = excluded.payday,
      receipt_id = excluded.receipt_id;

commit;
