-- Developer tag + Developer Tools (2026-10-08). Devon and Carson first.
--
-- DEVELOPER is a tag, not a role: `employees.is_developer` sits on top of
-- whatever role the person has (Carson stays Sales, Devon stays Owner), so
-- their normal view is unchanged. What it adds:
--   • full power: is_company_admin() / is_company_member() and the two
--     website read policies answer yes for a developer, and the admin-only
--     edge functions treat a developer as an owner;
--   • Developer Tools in the app: switch the SCREENS to any role (own data),
--     or look through a specific employee's eyes (their data, look-only);
--   • a view log and phone reports, developer-read only.
-- Only a developer can add or remove the tag (set_developer).
--
-- "VIEW AS A PERSON" — how it works, and why it is safe:
--   The app sends `x-view-as: <email>` and `Prefer: tx=rollback` on every
--   database request while viewing. dev_pre_request() (PostgREST's
--   db-pre-request hook, run before every API request) then:
--     1. does nothing at all when there is no x-view-as header (everyone else);
--     2. refuses unless the REAL signed-in person is a developer;
--     3. refuses unless the request will be rolled back (the Prefer header,
--        honoured because db-tx-end = commit-allow-override) — so nothing done
--        while viewing is ever saved, while every check (RLS, RPC rules) still
--        runs and answers truthfully: "Ken could do this" / "Ken can't";
--     4. swaps the request's JWT claims (email + sub) to the viewed person, so
--        auth.jwt(), auth.uid() and every policy and helper see THEM — no
--        policy had to change.
--   Side effects are transactional too: pg_net push/notify calls queued in a
--   rolled-back transaction are never sent. Sequences are not, so a dry-run
--   insert can skip a number.
--   Edge functions never see the header; the app blocks them while viewing,
--   except twilio-send-sms / twilio-voice-token, which take `devViewAs` and
--   answer without sending (dry run).
--
-- Idempotent: safe to re-run.

begin;

-- The tag ---------------------------------------------------------------------
alter table public.employees add column if not exists is_developer boolean not null default false;
update public.employees set is_developer = true
 where lower(email) in ('devonsd311@gmail.com', 'ke4ting@gmail.com') and not is_developer;

-- True for the REAL signed-in developer. While viewing as someone the claims
-- are theirs, so this is false — a look-through sees exactly what they see.
create or replace function public.is_developer()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from employees e where e.email = (auth.jwt() ->> 'email') and e.is_developer);
$$;

-- Full power: a developer is an admin and a member, whatever their role.
create or replace function public.is_company_admin(comp text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from employees e
     where e.email = (auth.jwt() ->> 'email') and e.company = comp
       and (e.role in ('owner', 'operator') or e.is_developer)
  );
$$;

create or replace function public.is_company_member(comp text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from employees e
     where e.email = (auth.jwt() ->> 'email') and e.company = comp
       and (e.role not in ('sales', 'sales_manager') or e.is_developer)
  );
$$;

-- The website's two broad reads exclude sales by role name; a developer on a
-- Sales account (Carson) still reads everything.
drop policy if exists "customers company read" on public.customers;
create policy "customers company read" on public.customers for select
  using (company = (select employees.company from employees
                     where employees.email = (auth.jwt() ->> 'email')
                       and (employees.role not in ('sales', 'sales_manager') or employees.is_developer)));
drop policy if exists "jobs company read" on public.jobs;
create policy "jobs company read" on public.jobs for select
  using (company = (select employees.company from employees
                     where employees.email = (auth.jwt() ->> 'email')
                       and (employees.role not in ('sales', 'sales_manager') or employees.is_developer)));

-- Only a developer adds or removes the tag (employees has no write policies).
create or replace function public.set_developer(p_email text, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_developer() then
    raise exception 'developers only' using errcode = '42501';
  end if;
  if not exists (select 1 from employees where lower(email) = lower(p_email)) then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
  if not p_on and lower(p_email) = lower(auth.jwt() ->> 'email')
     and (select count(*) from employees where is_developer) <= 1 then
    raise exception 'you are the last developer' using errcode = '22023';
  end if;
  update employees set is_developer = p_on where lower(email) = lower(p_email);
end;
$$;

-- View log --------------------------------------------------------------------
create table if not exists public.dev_view_log (
  id uuid primary key default gen_random_uuid(),
  company text not null default 'dc-solar',
  developer_email text not null,
  kind text not null check (kind in ('role', 'person')),
  target_role text,
  target_email text,
  target_name text,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists dev_view_log_started_idx on public.dev_view_log (started_at desc);
alter table public.dev_view_log enable row level security;
drop policy if exists dev_view_log_select on public.dev_view_log;
create policy dev_view_log_select on public.dev_view_log for select using (public.is_developer());

-- Start a view: checks, logs, and hands back who the person is.
create or replace function public.dev_view_start(p_kind text, p_role text default null, p_email text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me text := auth.jwt() ->> 'email';
  v_row employees%rowtype;
  v_uid uuid;
  v_id uuid;
begin
  if not public.is_developer() then
    raise exception 'developers only' using errcode = '42501';
  end if;
  if p_kind = 'role' then
    if p_role not in ('owner', 'operator', 'viewer', 'sales', 'sales_manager') then
      raise exception 'unknown role' using errcode = '22023';
    end if;
    insert into dev_view_log (developer_email, kind, target_role) values (v_me, 'role', p_role) returning id into v_id;
    return jsonb_build_object('id', v_id, 'role', p_role);
  elsif p_kind = 'person' then
    select * into v_row from employees where lower(email) = lower(p_email);
    if not found then
      raise exception 'employee not found' using errcode = 'P0002';
    end if;
    if lower(v_row.email) = lower(v_me) then
      raise exception 'that is you — use My normal view' using errcode = '22023';
    end if;
    select id into v_uid from auth.users where lower(email) = lower(v_row.email) limit 1;
    insert into dev_view_log (developer_email, kind, target_role, target_email, target_name)
    values (v_me, 'person', v_row.role, v_row.email, coalesce(v_row.display_name, v_row.email))
    returning id into v_id;
    return jsonb_build_object(
      'id', v_id, 'email', v_row.email, 'name', coalesce(v_row.display_name, v_row.email),
      'role', v_row.role, 'uid', v_uid);
  end if;
  raise exception 'kind is role or person' using errcode = '22023';
end;
$$;

create or replace function public.dev_view_end(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update dev_view_log set ended_at = now()
   where id = p_id and ended_at is null and lower(developer_email) = lower(auth.jwt() ->> 'email');
$$;

-- Phone reports: each employee's last app version / update and recent
-- problems, from client_diagnostics (the app writes an `app_open` row per
-- launch and a row per error).
create or replace function public.dev_phone_reports()
returns table (
  email text, display_name text, role text, platform text, app_version text, runtime text,
  last_seen timestamptz, problems_7d int, last_problem_at timestamptz
)
language sql stable security definer set search_path = public as $$
  with d as (
    select lower(c.email) as email, c.platform, c.app_version, c.runtime, c.created_at, c.ok
      from client_diagnostics c where c.company = 'dc-solar'
  ),
  latest as (
    select distinct on (d.email) d.email, d.platform, d.app_version, d.runtime, d.created_at
      from d order by d.email, d.created_at desc
  ),
  probs as (
    select d.email, count(*) filter (where d.created_at > now() - interval '7 days') as n, max(d.created_at) as last_at
      from d where d.ok is false group by d.email
  )
  select lower(e.email), coalesce(e.display_name, e.email), e.role, l.platform, l.app_version, l.runtime,
         l.created_at, coalesce(p.n, 0)::int, p.last_at
    from employees e
    left join latest l on l.email = lower(e.email)
    left join probs p on p.email = lower(e.email)
   where e.company = 'dc-solar' and not e.is_test and public.is_developer()
   order by l.created_at desc nulls last, e.display_name;
$$;

-- "Send me a test notification": a row here fires notify_webhook, and the
-- notify function pushes to that email only.
create table if not exists public.dev_test_pushes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  created_at timestamptz not null default now()
);
alter table public.dev_test_pushes enable row level security;  -- no policies: RPC only
drop trigger if exists dev_test_pushes_notify on public.dev_test_pushes;
create trigger dev_test_pushes_notify after insert on public.dev_test_pushes
  for each row execute function public.notify_webhook();

create or replace function public.dev_test_push()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_developer() then
    raise exception 'developers only' using errcode = '42501';
  end if;
  insert into dev_test_pushes (email) values (lower(auth.jwt() ->> 'email'));
end;
$$;

-- The view-as hook --------------------------------------------------------------
create or replace function public.dev_pre_request()
returns void language plpgsql security definer set search_path = public as $$
declare
  v_headers jsonb;
  v_target text;
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
  if v_target is null then
    return;  -- every ordinary request
  end if;

  v_claims := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  v_real := v_claims ->> 'email';
  if v_real is null or not exists (select 1 from employees where email = v_real and is_developer) then
    raise exception 'View as is for developers only.' using errcode = '42501';
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

alter role authenticator set pgrst.db_tx_end = 'commit-allow-override';
alter role authenticator set pgrst.db_pre_request = 'public.dev_pre_request';

commit;

notify pgrst, 'reload config';
notify pgrst, 'reload schema';
