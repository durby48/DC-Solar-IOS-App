-- Staff names (2026-10-08): the CRM timeline, notes and calls attributed
-- things to an email-shaped nickname ("Connect · Ke4ting"). staff_names()
-- returns each employee's email and display name — names only, no role, pay
-- or phone — to any signed-in employee, so the app can show "Carson".
-- employees itself stays admin-read. Idempotent.

begin;

create or replace function public.staff_names()
returns table (email text, display_name text)
language sql stable security definer set search_path = public as $$
  select lower(e.email), coalesce(nullif(trim(e.display_name), ''), e.email)
    from employees e
   where e.company = 'dc-solar' and public.is_company_staff('dc-solar');
$$;

revoke all on function public.staff_names() from public, anon;
grant execute on function public.staff_names() to authenticated;

commit;
