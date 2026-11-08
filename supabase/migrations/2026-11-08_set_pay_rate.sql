-- Edit an employee's hourly rate from the Employees screen (2026-11-08, Devon:
-- "Harry needs to be at $22 an hour").
--
-- employees has NO write policies by design, so the rate goes through
-- set_pay_rate(), like set_field_crew() / set_employee_role().
--
-- WHO MAY SET IT
--   * admins only (is_company_admin)
--   * the owner may set anyone's rate, their own included
--   * an operator may NOT set their own rate, the owner's, or another
--     operator's — only crew / sales rates
--
-- WHAT IT AFFECTS
--   * employee_hours rows logged FROM NOW ON (the own-hours trigger stamps
--     the roster rate into employee_hours.rate on insert; existing rows keep
--     the rate they were logged at)
--   * clock-in shifts (time_entries) are costed at the CURRENT pay_rate
--     everywhere they are read, so their labor cost moves with this — old and
--     new shifts alike.
--
-- p_rate null clears the rate. Idempotent: safe to re-run.

begin;

create or replace function public.set_pay_rate(p_email text, p_rate numeric)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_company  text;
  v_target   text;
  v_me       text := lower(public.jwt_email());
  v_my_role  text;
  v_rate     numeric;
begin
  select company, role into v_company, v_target from public.employees where lower(email) = lower(p_email);
  if v_company is null then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
  if not public.is_company_admin(v_company) then
    raise exception 'admins only' using errcode = '42501';
  end if;

  select role into v_my_role from public.employees
   where lower(email) = v_me and company = v_company;
  if coalesce(v_my_role, '') <> 'owner' then
    if lower(p_email) = v_me then
      raise exception 'only the owner can change your pay rate' using errcode = '42501';
    end if;
    if v_target in ('owner', 'operator') then
      raise exception 'only the owner can change an owner''s or operator''s pay rate' using errcode = '42501';
    end if;
  end if;

  if p_rate is null then
    v_rate := null;
  else
    v_rate := round(p_rate, 2);
    if v_rate <= 0 or v_rate > 500 then
      raise exception 'enter an hourly rate between $0.01 and $500' using errcode = '22023';
    end if;
  end if;

  update public.employees set pay_rate = v_rate where lower(email) = lower(p_email);
  return v_rate;
end;
$$;

revoke all on function public.set_pay_rate(text, numeric) from public, anon;
grant execute on function public.set_pay_rate(text, numeric) to authenticated;

commit;
