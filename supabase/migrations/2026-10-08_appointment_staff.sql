-- Who an appointment can be for (2026-10-08, Carson): the sales team or Devon
-- (the owner). appointment_staff() returns those people's emails and names
-- to any employee — the sales app reads names through RPCs because employees
-- is admin-read. lead_appointments' insert policy already lets a rep set any
-- assignee, and the owner's Operations calendar already shows them.
-- Idempotent.

begin;

create or replace function public.appointment_staff()
returns table (email text, display_name text, role text)
language sql stable security definer set search_path = public as $$
  select lower(e.email), coalesce(nullif(trim(e.display_name), ''), e.email), e.role
    from employees e
   where e.company = 'dc-solar'
     and e.role in ('sales', 'sales_manager', 'owner')
     and not e.is_test
     and public.is_company_staff('dc-solar')
   order by case when e.role = 'owner' then 1 else 0 end, e.display_name;
$$;

revoke all on function public.appointment_staff() from public, anon;
grant execute on function public.appointment_staff() to authenticated;

commit;
