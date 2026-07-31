-- Migration 16: per-job crew assignments (who is expected to work/earn
-- hours on a job). Applied via the Supabase Management API 2026-07-31.
-- Re-runnable.
--
-- Shown on the Calendar views and the job screen; admins assign/unassign,
-- everyone can see who's on a job. Display name fills from the roster by
-- trigger (same pattern as employee_hours).

create table if not exists public.job_assignments (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  company text not null default 'dc-solar',
  job_id uuid not null references public.jobs(id),
  email text not null,
  employee text,
  unique (job_id, email)
);
create index if not exists job_assignments_job_idx on public.job_assignments (job_id);

create or replace function public.job_assignments_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  select display_name into v_name
    from public.employees
    where lower(email) = lower(new.email)
    limit 1;
  if v_name is not null then
    new.employee := v_name;
  end if;
  return new;
end;
$$;

drop trigger if exists job_assignments_fill_trg on public.job_assignments;
create trigger job_assignments_fill_trg
  before insert on public.job_assignments
  for each row
  execute function public.job_assignments_fill();

alter table public.job_assignments enable row level security;

drop policy if exists ja_select on public.job_assignments;
create policy ja_select on public.job_assignments for select
  using (public.is_company_member(company));
drop policy if exists ja_insert on public.job_assignments;
create policy ja_insert on public.job_assignments for insert
  with check (public.is_company_admin(company));
drop policy if exists ja_delete on public.job_assignments;
create policy ja_delete on public.job_assignments for delete
  using (public.is_company_admin(company));
