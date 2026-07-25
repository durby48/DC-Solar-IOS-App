-- Migration 5: project manager fields, monitoring logins, customer editing.
-- Run in Supabase dashboard → SQL Editor. Re-runnable.

-- 1. Project manager per job (name + cell), editable by admins
alter table public.jobs add column if not exists project_manager text;
alter table public.jobs add column if not exists project_manager_phone text;

-- 2. Monitoring logins: admin-managed, visible to ALL signed-in employees
create table if not exists public.monitoring_logins (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  company text not null default 'dc-solar',
  label text not null,                    -- e.g. "Enphase — Smith residence"
  url text,
  username text,
  secret text,                            -- shared portal password (visible to all staff by design)
  notes text,
  job_id uuid references public.jobs(id)
);

alter table public.monitoring_logins enable row level security;
drop policy if exists ml_member_select on public.monitoring_logins;
create policy ml_member_select on public.monitoring_logins for select
  using (public.is_company_member(company));
drop policy if exists ml_admin_all on public.monitoring_logins;
create policy ml_admin_all on public.monitoring_logins for all
  using (public.is_company_admin(company)) with check (public.is_company_admin(company));

-- 3. Customers: admins can add and edit from the app (members can already view)
drop policy if exists customers_admin_insert on public.customers;
create policy customers_admin_insert on public.customers for insert
  with check (public.is_company_admin(company));
drop policy if exists customers_admin_update on public.customers;
create policy customers_admin_update on public.customers for update
  using (public.is_company_admin(company)) with check (public.is_company_admin(company));
