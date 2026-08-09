-- Company settings — currently just the last reconciled bank balance.
--
-- The app has no bank feed, so the balance cannot be derived; it is entered by
-- an admin when they reconcile. Storing it with an "as of" date lets the Cash
-- Position panel say how stale the figure is instead of implying it is live.
--
-- Admin-only in both directions. finance_entries once leaked every money row
-- because a broad policy ORed with the narrow ones, so this grants nothing to
-- authenticated users generally — only to the same admin check the rest of the
-- money surface uses.

begin;

create table if not exists public.company_settings (
  company              text primary key,
  bank_balance         numeric(12, 2),
  bank_balance_as_of   date,
  -- Last day covered by a completed payroll run. Hours logged after this are
  -- worked but unpaid, so the cash is still in the account.
  payroll_through      date,
  updated_at           timestamptz not null default now(),
  updated_by           text
);

insert into public.company_settings (company)
values ('dc-solar')
on conflict (company) do nothing;

alter table public.company_settings enable row level security;

drop policy if exists company_settings_admin_select on public.company_settings;
create policy company_settings_admin_select on public.company_settings
  for select using (public.is_company_admin(company));

drop policy if exists company_settings_admin_update on public.company_settings;
create policy company_settings_admin_update on public.company_settings
  for update using (public.is_company_admin(company)) with check (public.is_company_admin(company));

commit;

-- Added 2026-08-09: hours after this date are worked but not yet paid.
alter table public.company_settings add column if not exists payroll_through date;
