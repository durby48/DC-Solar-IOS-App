-- Migration 3: multi-date job scheduling, pay rates, and app read access.
-- Run in Supabase dashboard → SQL Editor. Re-runnable.

-- ---------------------------------------------------------------------------
-- 1. Pay rates (visible to each employee for their own row; admins see all)
-- ---------------------------------------------------------------------------
alter table public.employees add column if not exists pay_rate numeric;
update public.employees set pay_rate = 35 where email = 'devonsd311@gmail.com';
update public.employees set pay_rate = 33 where email in ('inettleton18@gmail.com','isaiah.nettleton@dcsolarkc.com');
update public.employees set pay_rate = 35 where email = 'bnettleton403@gmail.com';
update public.employees set pay_rate = 30 where email in ('snettleton2005@gmail.com','gnimsgern.2022@gmail.com','tylersisson99@yahoo.com');

alter table public.employees enable row level security;
drop policy if exists emp_admin_select on public.employees;
create policy emp_admin_select on public.employees for select
  using (public.is_company_admin(company));
-- (any existing own-row policy still applies; policies are OR'd)

-- ---------------------------------------------------------------------------
-- 2. App read/write access to existing tables
-- ---------------------------------------------------------------------------
alter table public.jobs enable row level security;
drop policy if exists jobs_member_select on public.jobs;
create policy jobs_member_select on public.jobs for select
  using (public.is_company_member(company));
drop policy if exists jobs_admin_write on public.jobs;
create policy jobs_admin_write on public.jobs for update
  using (public.is_company_admin(company)) with check (public.is_company_admin(company));
drop policy if exists jobs_admin_insert on public.jobs;
create policy jobs_admin_insert on public.jobs for insert
  with check (public.is_company_admin(company));

alter table public.customers enable row level security;
drop policy if exists customers_member_select on public.customers;
create policy customers_member_select on public.customers for select
  using (public.is_company_member(company));

alter table public.finance_entries enable row level security;
drop policy if exists fin_admin_select on public.finance_entries;
create policy fin_admin_select on public.finance_entries for select
  using (public.is_company_admin(company));
drop policy if exists fin_admin_write on public.finance_entries;
create policy fin_admin_write on public.finance_entries for insert
  with check (public.is_company_admin(company));

alter table public.employee_hours enable row level security;
drop policy if exists hours_select on public.employee_hours;
create policy hours_select on public.employee_hours for select
  using (employee = (select display_name from public.employees where email = public.jwt_email() limit 1)
         or public.is_company_admin(company));

-- ---------------------------------------------------------------------------
-- 3. Multi-date scheduling with per-date start times
--    A job can be worked Mon + Wed (skipping Tue), each date with its own start.
-- ---------------------------------------------------------------------------
create table if not exists public.job_schedule_dates (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  company text not null default 'dc-solar',
  job_id uuid not null references public.jobs(id) on delete cascade,
  work_date date not null,
  start_time time,                       -- null = time TBD
  note text,
  unique (job_id, work_date)
);
create index if not exists jsd_date_idx on public.job_schedule_dates (company, work_date);

alter table public.job_schedule_dates enable row level security;
drop policy if exists jsd_member_select on public.job_schedule_dates;
create policy jsd_member_select on public.job_schedule_dates for select
  using (public.is_company_member(company));
drop policy if exists jsd_admin_all on public.job_schedule_dates;
create policy jsd_admin_all on public.job_schedule_dates for all
  using (public.is_company_admin(company)) with check (public.is_company_admin(company));

-- Seed: carry each job's existing single scheduled_for date over (time TBD)
insert into public.job_schedule_dates (company, job_id, work_date)
select company, id, scheduled_for::date
from public.jobs
where scheduled_for is not null
on conflict (job_id, work_date) do nothing;
