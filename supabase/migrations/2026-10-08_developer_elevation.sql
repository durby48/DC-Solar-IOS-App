-- Developer power only in a developer view (2026-10-08, Carson).
--
-- 2026-10-08_developer.sql made a developer an admin ALL the time, so
-- Carson's normal Sales view loaded every lead (and, being a rep's screen,
-- showed no owner tags). Now a developer's normal view is exactly their own
-- role; the extra power applies only while they use Developer Tools → View as
-- a role:
--
--   the app sends `x-dev-as-role: <role>` on database requests in a role view;
--   dev_pre_request() (developers only) copies it to `app.dev_role` for that
--   request; the helpers read it:
--     owner / operator  → is_company_admin, is_company_member, website reads
--     sales_manager     → is_sales_manager
--     viewer (Crew)     → is_company_member
--     sales             → is_company_sales
--
-- View as a PERSON is unchanged (claims swapped to that person). Developer
-- Tools' own reads go through dev_* RPCs gated on is_developer(), so they
-- work in the normal view too. Idempotent.

begin;

create or replace function public.is_company_admin(comp text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from employees e
     where e.email = (auth.jwt() ->> 'email') and e.company = comp
       and (e.role in ('owner', 'operator')
            or (e.is_developer and current_setting('app.dev_role', true) in ('owner', 'operator')))
  );
$$;

create or replace function public.is_company_member(comp text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from employees e
     where e.email = (auth.jwt() ->> 'email') and e.company = comp
       and (e.role not in ('sales', 'sales_manager')
            or (e.is_developer and current_setting('app.dev_role', true) in ('owner', 'operator', 'viewer')))
  );
$$;

create or replace function public.is_sales_manager(comp text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from employees e
     where e.email = (auth.jwt() ->> 'email') and e.company = comp
       and (e.role = 'sales_manager'
            or (e.is_developer and current_setting('app.dev_role', true) = 'sales_manager'))
  );
$$;

create or replace function public.is_company_sales(comp text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from employees e
     where e.email = (auth.jwt() ->> 'email') and e.company = comp
       and (e.role in ('sales', 'sales_manager')
            or (e.is_developer and current_setting('app.dev_role', true) in ('sales', 'sales_manager')))
  );
$$;

drop policy if exists "customers company read" on public.customers;
create policy "customers company read" on public.customers for select
  using (company = (select employees.company from employees
                     where employees.email = (auth.jwt() ->> 'email')
                       and (employees.role not in ('sales', 'sales_manager')
                            or (employees.is_developer and current_setting('app.dev_role', true) in ('owner', 'operator', 'viewer')))));
drop policy if exists "jobs company read" on public.jobs;
create policy "jobs company read" on public.jobs for select
  using (company = (select employees.company from employees
                     where employees.email = (auth.jwt() ->> 'email')
                       and (employees.role not in ('sales', 'sales_manager')
                            or (employees.is_developer and current_setting('app.dev_role', true) in ('owner', 'operator', 'viewer')))));

-- Developer Tools' own reads, independent of the view.
create or replace function public.dev_people()
returns table (email text, display_name text, role text, is_test boolean)
language sql stable security definer set search_path = public as $$
  select e.email, coalesce(e.display_name, e.email), e.role, coalesce(e.is_test, false)
    from employees e
   where e.company = 'dc-solar' and public.is_developer()
   order by e.display_name;
$$;

create or replace function public.dev_phone_events(p_email text)
returns setof client_diagnostics
language sql stable security definer set search_path = public as $$
  select * from client_diagnostics
   where company = 'dc-solar' and lower(email) = lower(p_email) and public.is_developer()
   order by created_at desc
   limit 30;
$$;

revoke all on function public.dev_people() from public, anon;
revoke all on function public.dev_phone_events(text) from public, anon;
grant execute on function public.dev_people() to authenticated;
grant execute on function public.dev_phone_events(text) to authenticated;

-- The hook: x-dev-as-role (role view) for developers, then x-view-as.
create or replace function public.dev_pre_request()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_headers jsonb;
  v_target text;
  v_role text;
  v_claims jsonb;
  v_real text;
  v_email text;
  v_uid uuid;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    return;
  end;
  v_target := nullif(btrim(coalesce(v_headers ->> 'x-view-as', '')), '');
  v_role := nullif(btrim(coalesce(v_headers ->> 'x-dev-as-role', '')), '');
  if v_target is null and v_role is null then
    return;  -- every ordinary request
  end if;

  v_claims := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  v_real := v_claims ->> 'email';
  if v_real is null or not exists (select 1 from employees where email = v_real and is_developer) then
    raise exception 'View as is for developers only.' using errcode = '42501';
  end if;

  if v_target is null then
    -- View as a ROLE: the developer's own identity, that role's power.
    if v_role in ('owner', 'operator', 'viewer', 'sales', 'sales_manager') then
      perform set_config('app.dev_role', v_role, true);
    end if;
    return;
  end if;

  if coalesce(v_headers ->> 'prefer', '') !~ 'tx=rollback'
     or coalesce(current_setting('pgrst.db_tx_end', true), '') <> 'commit-allow-override' then
    raise exception 'View as is look-only, and this request would have been saved.' using errcode = '42501';
  end if;

  select e.email into v_email from employees e where lower(e.email) = lower(v_target);
  if v_email is null then
    raise exception 'View as: that person is not an employee.' using errcode = '42501';
  end if;
  select u.id into v_uid from auth.users u where lower(u.email) = lower(v_email) limit 1;

  v_claims := v_claims || jsonb_build_object(
    'email', v_email,
    'sub', coalesce(v_uid::text, '00000000-0000-0000-0000-000000000000'),
    'view_as_by', v_real);
  perform set_config('request.jwt.claims', v_claims::text, true);
  perform set_config('request.jwt.claim.sub', v_claims ->> 'sub', true);
  perform set_config('request.jwt.claim.email', v_email, true);
end;
$$;
grant execute on function public.dev_pre_request() to anon, authenticated, service_role;

commit;
