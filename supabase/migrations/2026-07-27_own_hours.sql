-- Migration 14: crew members log their own hours per job (no clock times).
-- Applied directly via the Supabase Management API on 2026-07-27. Re-runnable.
--
-- employee_hours previously had SELECT policies only (rows written by the
-- ops console / imports, keyed by display_name). Now app users insert their
-- OWN rows: identified by a new email column; a trigger fills employee
-- (display name) and rate (employees.pay_rate) from the roster so crew
-- never set their own rate and all existing labor math keeps working.

alter table public.employee_hours add column if not exists email text;

create or replace function public.employee_hours_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_rate numeric;
begin
  select display_name, pay_rate into v_name, v_rate
    from public.employees
    where lower(email) = lower(new.email)
    limit 1;
  if v_name is not null then
    new.employee := v_name;
  end if;
  new.rate := v_rate; -- roster rate always wins on own entries
  return new;
end;
$$;

drop trigger if exists employee_hours_fill_trg on public.employee_hours;
create trigger employee_hours_fill_trg
  before insert on public.employee_hours
  for each row
  when (new.email is not null)
  execute function public.employee_hours_fill();

drop policy if exists eh_own_select on public.employee_hours;
create policy eh_own_select on public.employee_hours for select
  using (email = public.jwt_email());
drop policy if exists eh_own_insert on public.employee_hours;
create policy eh_own_insert on public.employee_hours for insert
  with check (email = public.jwt_email() and public.is_company_member(company));
drop policy if exists eh_own_update on public.employee_hours;
create policy eh_own_update on public.employee_hours for update
  using (email = public.jwt_email())
  with check (email = public.jwt_email());
drop policy if exists eh_own_delete on public.employee_hours;
create policy eh_own_delete on public.employee_hours for delete
  using (email = public.jwt_email());
