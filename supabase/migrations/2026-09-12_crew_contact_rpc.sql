-- Build 33: admins can update a crew member's CONTACT information.
--
-- A crew member's contact info lives in two places the app already uses:
--   employees.display_name        -- the name every screen shows
--   staff_profiles.cell_phone     -- the number the directory dials (e164 is GENERATED)
-- Both are self-write (staff_profiles) or not client-writable at all
-- (employees has no UPDATE policy), so an admin could not fix another
-- person's number. Rather than widen RLS on either table — which would also
-- expose role / pay_rate / voice settings to the same write — this is one
-- narrow SECURITY DEFINER function that touches exactly those two columns,
-- for exactly one existing employee, after checking the caller is an admin of
-- that employee's company. No crew or contact row is ever created here.
--
-- Blank handling: a blank name keeps the existing name (a crew member always
-- has one); a blank phone clears the cell number (a deliberate edit).

begin;

create or replace function public.set_crew_contact(
  p_employee_id uuid,
  p_display_name text,
  p_cell_phone text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company text;
  v_email text;
begin
  select e.company, e.email
    into v_company, v_email
    from public.employees e
   where e.id = p_employee_id;

  if v_email is null then
    raise exception 'No crew member with that id.' using errcode = 'P0002';
  end if;

  if not public.is_company_admin(v_company) then
    raise exception 'Only an admin can edit crew contact information.' using errcode = '42501';
  end if;

  if nullif(btrim(coalesce(p_display_name, '')), '') is not null then
    update public.employees
       set display_name = btrim(p_display_name)
     where id = p_employee_id;
  end if;

  insert into public.staff_profiles (company, email, cell_phone, updated_at)
  values (v_company, v_email, nullif(btrim(coalesce(p_cell_phone, '')), ''), now())
  on conflict (company, email)
  do update set cell_phone = excluded.cell_phone,
                updated_at = now();
end;
$$;

revoke all on function public.set_crew_contact(uuid, text, text) from public, anon;
grant execute on function public.set_crew_contact(uuid, text, text) to authenticated;

commit;
