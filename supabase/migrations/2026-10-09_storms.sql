-- Storm coverage (2026-10-09, Carson): hail after-care for leads and customers.
--
-- DATA. NOAA Storm Prediction Center storm reports (hail + wind) within 150
-- miles of Kansas City, kept 2+ years: `storm_reports`. Filled by the
-- `storm-sync` edge function (every 30 min: today + yesterday; once: a
-- 2-year backfill). A STORM is all hail ≥ 1 inch on one Central-time day:
-- `storms`. Everyone (lead or customer, placed on the map) within 3 miles of a
-- qualifying report is a hit: `storm_hits` (nearest report, its size, miles).
-- Each lead / customer keeps its most recent hit: `last_hail_at/_size/_miles`.
--
-- REFRESH. storm_recompute_day(day) rebuilds one storm's hits; a lead's or
-- customer's position changing re-checks that one record against 2 years of
-- storms (trigger). storm-sync sends the alerts (one per storm per person),
-- creates ONE "Storm check" task per storm for the sales manager, and sends a
-- 7 AM summary of yesterday's storm.
--
-- WHO SEES WHAT (RPCs, security definer): admins and the sales manager see
-- every hit; a rep sees hits on leads assigned to them and on their own
-- customers (is_sales_rep_for_customer). Idempotent.

begin;

create table if not exists public.storm_reports (
  id          text primary key,                 -- kind|time|lat|lng
  company     text not null default 'dc-solar',
  kind        text not null check (kind in ('hail', 'wind')),
  size        numeric,                          -- hail: inches · wind: mph (null = unknown)
  occurred_at timestamptz not null,
  storm_day   date not null,                    -- the Central-time day
  lat         double precision not null,
  lng         double precision not null,
  location    text,
  county      text,
  state       text,
  comments    text,
  created_at  timestamptz not null default now()
);
create index if not exists storm_reports_day_idx on public.storm_reports (storm_day);
create index if not exists storm_reports_when_idx on public.storm_reports (occurred_at desc);
alter table public.storm_reports enable row level security;
drop policy if exists storm_reports_staff_select on public.storm_reports;
create policy storm_reports_staff_select on public.storm_reports for select using (public.is_company_staff(company));

create table if not exists public.storms (
  storm_day       date primary key,
  company         text not null default 'dc-solar',
  max_hail        numeric,
  places          text[] not null default '{}',
  hail_reports    integer not null default 0,
  lead_count      integer not null default 0,
  customer_count  integer not null default 0,
  alerted_at      timestamptz,
  summary_sent_at timestamptz,
  task_id         uuid,
  checked_at      timestamptz,
  checked_by      text,
  updated_at      timestamptz not null default now()
);
alter table public.storms enable row level security;  -- read through the RPCs below

create table if not exists public.storm_hits (
  storm_day  date not null references public.storms (storm_day) on delete cascade,
  kind       text not null check (kind in ('lead', 'customer')),
  record_id  uuid not null,
  miles      numeric not null,
  hail_size  numeric,
  report_id  text,
  checked_at timestamptz,
  checked_by text,
  primary key (storm_day, kind, record_id)
);
create index if not exists storm_hits_record_idx on public.storm_hits (kind, record_id);
alter table public.storm_hits enable row level security;  -- read through the RPCs below

alter table public.leads add column if not exists last_hail_at timestamptz;
alter table public.leads add column if not exists last_hail_size numeric;
alter table public.leads add column if not exists last_hail_miles numeric;
alter table public.customers add column if not exists last_hail_at timestamptz;
alter table public.customers add column if not exists last_hail_size numeric;
alter table public.customers add column if not exists last_hail_miles numeric;

alter table public.staff_profiles add column if not exists notify_storms boolean not null default true;

-- Great-circle miles.
create or replace function public.miles_between(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
  select 3958.8 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)));
$$;

-- The rules, in one place: hail of at least 1 inch, within 3 miles.
create or replace function public.storm_min_hail() returns numeric language sql immutable as $$ select 1.0::numeric $$;
create or replace function public.storm_radius_miles() returns double precision language sql immutable as $$ select 3.0::double precision $$;

-- Most recent hit → the record's last_hail_* (null when none).
create or replace function public.storm_refresh_last_hail(p_kind text, p_ids uuid[])
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_kind = 'lead' then
    update leads l set last_hail_at = h.occurred_at, last_hail_size = h.hail_size, last_hail_miles = h.miles
      from (select distinct on (sh.record_id) sh.record_id, sr.occurred_at, sh.hail_size, sh.miles
              from storm_hits sh left join storm_reports sr on sr.id = sh.report_id
             where sh.kind = 'lead' and sh.record_id = any(p_ids)
             order by sh.record_id, sh.storm_day desc) h
     where l.id = h.record_id;
    update leads set last_hail_at = null, last_hail_size = null, last_hail_miles = null
     where id = any(p_ids) and not exists (select 1 from storm_hits where kind = 'lead' and record_id = leads.id);
  else
    update customers c set last_hail_at = h.occurred_at, last_hail_size = h.hail_size, last_hail_miles = h.miles
      from (select distinct on (sh.record_id) sh.record_id, sr.occurred_at, sh.hail_size, sh.miles
              from storm_hits sh left join storm_reports sr on sr.id = sh.report_id
             where sh.kind = 'customer' and sh.record_id = any(p_ids)
             order by sh.record_id, sh.storm_day desc) h
     where c.id = h.record_id;
    update customers set last_hail_at = null, last_hail_size = null, last_hail_miles = null
     where id = any(p_ids) and not exists (select 1 from storm_hits where kind = 'customer' and record_id = customers.id);
  end if;
end;
$$;

create or replace function public.storm_refresh_counts(p_day date)
returns void language sql security definer set search_path = public as $$
  update storms s set
    lead_count = (select count(*) from storm_hits h where h.storm_day = p_day and h.kind = 'lead'),
    customer_count = (select count(*) from storm_hits h where h.storm_day = p_day and h.kind = 'customer'),
    updated_at = now()
   where s.storm_day = p_day;
$$;

-- Rebuild one storm day: the storm row and everyone in its path.
create or replace function public.storm_recompute_day(p_day date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_ids_lead uuid[];
  v_ids_cust uuid[];
  v_old_lead uuid[];
  v_old_cust uuid[];
begin
  select coalesce(array_agg(record_id) filter (where kind = 'lead'), '{}'),
         coalesce(array_agg(record_id) filter (where kind = 'customer'), '{}')
    into v_old_lead, v_old_cust
    from storm_hits where storm_day = p_day;

  if not exists (select 1 from storm_reports where storm_day = p_day and kind = 'hail' and size >= storm_min_hail()) then
    delete from storms where storm_day = p_day;  -- hits cascade
    perform storm_refresh_last_hail('lead', v_old_lead);
    perform storm_refresh_last_hail('customer', v_old_cust);
    return jsonb_build_object('storm', false);
  end if;

  insert into storms (storm_day, max_hail, places, hail_reports)
  select p_day, max(size),
         (select coalesce(array_agg(place), '{}') from (
            select distinct on (coalesce(location, county)) coalesce(location, county) as place, size
              from storm_reports
             where storm_day = p_day and kind = 'hail' and size >= storm_min_hail()
             order by coalesce(location, county), size desc) x),
         count(*)
    from storm_reports where storm_day = p_day and kind = 'hail' and size >= storm_min_hail()
  on conflict (storm_day) do update
    set max_hail = excluded.max_hail, places = excluded.places, hail_reports = excluded.hail_reports, updated_at = now();

  -- Keep checks already ticked; rebuild the rest.
  create temp table if not exists _storm_new (kind text, record_id uuid, miles numeric, hail_size numeric, report_id text) on commit drop;
  delete from _storm_new where true;  -- safeupdate refuses a bare DELETE

  insert into _storm_new
  select distinct on (l.id) 'lead', l.id, round(d.miles::numeric, 2), d.size, d.id
    from leads l
    cross join lateral (
      select r.id, r.size, miles_between(l.lat, l.lng, r.lat, r.lng) as miles
        from storm_reports r
       where r.storm_day = p_day and r.kind = 'hail' and r.size >= storm_min_hail()
         and abs(r.lat - l.lat) < 0.06 and abs(r.lng - l.lng) < 0.08
    ) d
   where l.company = 'dc-solar' and l.removed_at is null and l.lat is not null and l.lng is not null
     and d.miles <= storm_radius_miles()
   order by l.id, d.miles;

  insert into _storm_new
  select distinct on (c.id) 'customer', c.id, round(d.miles::numeric, 2), d.size, d.id
    from customers c
    cross join lateral (
      select r.id, r.size, miles_between(c.lat, c.lng, r.lat, r.lng) as miles
        from storm_reports r
       where r.storm_day = p_day and r.kind = 'hail' and r.size >= storm_min_hail()
         and abs(r.lat - c.lat) < 0.06 and abs(r.lng - c.lng) < 0.08
    ) d
   where c.company = 'dc-solar' and c.lat is not null and c.lng is not null
     and d.miles <= storm_radius_miles()
   order by c.id, d.miles;

  delete from storm_hits h
   where h.storm_day = p_day
     and not exists (select 1 from _storm_new n where n.kind = h.kind and n.record_id = h.record_id);
  insert into storm_hits (storm_day, kind, record_id, miles, hail_size, report_id)
  select p_day, kind, record_id, miles, hail_size, report_id from _storm_new
  on conflict (storm_day, kind, record_id) do update
    set miles = excluded.miles, hail_size = excluded.hail_size, report_id = excluded.report_id;

  perform storm_refresh_counts(p_day);

  select coalesce(array_agg(record_id) filter (where kind = 'lead'), '{}'),
         coalesce(array_agg(record_id) filter (where kind = 'customer'), '{}')
    into v_ids_lead, v_ids_cust
    from _storm_new;
  perform storm_refresh_last_hail('lead', array(select distinct unnest(v_ids_lead || v_old_lead)));
  perform storm_refresh_last_hail('customer', array(select distinct unnest(v_ids_cust || v_old_cust)));

  return jsonb_build_object('storm', true, 'leads', cardinality(v_ids_lead), 'customers', cardinality(v_ids_cust));
end;
$$;

-- One record moved (or was placed): check it against every storm on file.
create or replace function public.storm_recheck_record(p_kind text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_lat double precision;
  v_lng double precision;
  v_days date[];
begin
  if p_kind = 'lead' then
    select lat, lng into v_lat, v_lng from leads where id = p_id and removed_at is null;
  else
    select lat, lng into v_lat, v_lng from customers where id = p_id;
  end if;
  select coalesce(array_agg(storm_day), '{}') into v_days from storm_hits where kind = p_kind and record_id = p_id;
  delete from storm_hits where kind = p_kind and record_id = p_id;
  if v_lat is not null and v_lng is not null then
    insert into storm_hits (storm_day, kind, record_id, miles, hail_size, report_id)
    select distinct on (r.storm_day) r.storm_day, p_kind, p_id,
           round(miles_between(v_lat, v_lng, r.lat, r.lng)::numeric, 2), r.size, r.id
      from storm_reports r
      join storms s on s.storm_day = r.storm_day
     where r.kind = 'hail' and r.size >= storm_min_hail()
       and abs(r.lat - v_lat) < 0.06 and abs(r.lng - v_lng) < 0.08
       and miles_between(v_lat, v_lng, r.lat, r.lng) <= storm_radius_miles()
     order by r.storm_day, miles_between(v_lat, v_lng, r.lat, r.lng)
    on conflict do nothing;
  end if;
  perform storm_refresh_counts(d) from unnest(v_days || array(select storm_day from storm_hits where kind = p_kind and record_id = p_id)) d;
  perform storm_refresh_last_hail(p_kind, array[p_id]);
end;
$$;

create or replace function public.storm_recheck_trigger()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.lat is distinct from old.lat or new.lng is distinct from old.lng
     or (tg_table_name = 'leads' and new.removed_at is distinct from old.removed_at) then
    perform storm_recheck_record(case when tg_table_name = 'leads' then 'lead' else 'customer' end, new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists leads_storm_recheck on public.leads;
create trigger leads_storm_recheck after update of lat, lng, removed_at on public.leads
  for each row execute function public.storm_recheck_trigger();
drop trigger if exists customers_storm_recheck on public.customers;
create trigger customers_storm_recheck after update of lat, lng on public.customers
  for each row execute function public.storm_recheck_trigger();

-- Who sees a hit: admins / the sales manager all; a rep their leads + customers.
create or replace function public.storm_hit_visible(p_kind text, p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_company_admin('dc-solar') or public.is_sales_manager('dc-solar')
      or (p_kind = 'lead' and exists (select 1 from leads l where l.id = p_id and lower(l.assigned_to) = lower(public.jwt_email())))
      or (p_kind = 'customer' and public.is_sales_rep_for_customer(p_id));
$$;

create or replace function public.storm_list(p_limit integer default 200)
returns table (storm_day date, max_hail numeric, places text[], hail_reports integer,
               leads integer, customers integer, checked_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.storm_day, s.max_hail, s.places, s.hail_reports,
         (select count(*) from storm_hits h where h.storm_day = s.storm_day and h.kind = 'lead' and storm_hit_visible('lead', h.record_id))::int,
         (select count(*) from storm_hits h where h.storm_day = s.storm_day and h.kind = 'customer' and storm_hit_visible('customer', h.record_id))::int,
         s.checked_at
    from storms s
   where public.is_company_staff('dc-solar')
     and exists (select 1 from storm_hits h where h.storm_day = s.storm_day and storm_hit_visible(h.kind, h.record_id))
   order by s.storm_day desc
   limit p_limit;
$$;

create or replace function public.storm_detail(p_day date)
returns table (kind text, record_id uuid, name text, address text, miles numeric, hail_size numeric,
               owner text, status text, checked_at timestamptz, phone text)
language sql stable security definer set search_path = public as $$
  select h.kind, h.record_id,
         coalesce(l.name, c.name), coalesce(l.address, c.address), h.miles, h.hail_size,
         l.assigned_to, l.status, h.checked_at, coalesce(l.phone, c.phone)
    from storm_hits h
    left join leads l on h.kind = 'lead' and l.id = h.record_id
    left join customers c on h.kind = 'customer' and c.id = h.record_id
   where h.storm_day = p_day and storm_hit_visible(h.kind, h.record_id)
   order by h.kind, h.miles;
$$;

create or replace function public.storm_check_hit(p_day date, p_kind text, p_id uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not storm_hit_visible(p_kind, p_id) then
    raise exception 'not yours' using errcode = '42501';
  end if;
  update storm_hits set checked_at = case when p_on then now() end, checked_by = case when p_on then lower(jwt_email()) end
   where storm_day = p_day and kind = p_kind and record_id = p_id;
end;
$$;

-- The whole storm handled: closes its Storm check task.
create or replace function public.storm_mark_checked(p_day date, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_task uuid;
begin
  if not (public.is_company_admin('dc-solar') or public.is_sales_manager('dc-solar')) then
    raise exception 'admins and the sales manager only' using errcode = '42501';
  end if;
  update storms set checked_at = case when p_on then now() end, checked_by = case when p_on then lower(jwt_email()) end
   where storm_day = p_day returning task_id into v_task;
  if v_task is not null then
    update tasks set done_at = case when p_on then now() end where id = v_task;
  end if;
end;
$$;

-- Reports for the map's Storms layer.
create or replace function public.storm_reports_range(p_from timestamptz, p_to timestamptz)
returns table (id text, kind text, size numeric, occurred_at timestamptz, storm_day date, lat double precision,
               lng double precision, location text, county text, state text)
language sql stable security definer set search_path = public as $$
  select r.id, r.kind, r.size, r.occurred_at, r.storm_day, r.lat, r.lng, r.location, r.county, r.state
    from storm_reports r
   where public.is_company_staff('dc-solar') and r.occurred_at >= p_from and r.occurred_at < p_to
   order by r.occurred_at desc
   limit 3000;
$$;

-- Who an alert / summary goes to, and what they may be told.
create or replace function public.storm_alert_targets(p_day date)
returns table (email text, scope text, leads integer, customers integer)
language sql stable security definer set search_path = public as $$
  -- admins and sales managers: the whole storm
  select lower(e.email), 'all',
         (select count(*) from storm_hits h where h.storm_day = p_day and h.kind = 'lead')::int,
         (select count(*) from storm_hits h where h.storm_day = p_day and h.kind = 'customer')::int
    from employees e
   where e.company = 'dc-solar' and not coalesce(e.is_test, false)
     and (e.role in ('owner', 'operator', 'sales_manager'))
  union all
  -- reps: their own leads and customers
  select lower(e.email), 'own', x.leads, x.customers
    from employees e
    cross join lateral (
      select
        (select count(*) from storm_hits h join leads l on l.id = h.record_id
          where h.storm_day = p_day and h.kind = 'lead' and lower(l.assigned_to) = lower(e.email))::int as leads,
        (select count(*) from storm_hits h join jobs j on j.customer_id = h.record_id
          where h.storm_day = p_day and h.kind = 'customer' and lower(j.sales_rep_email) = lower(e.email))::int as customers
    ) x
   where e.company = 'dc-solar' and not coalesce(e.is_test, false) and e.role = 'sales'
     and (x.leads > 0 or x.customers > 0);
$$;

revoke all on function public.storm_refresh_last_hail(text, uuid[]) from public, anon, authenticated;
revoke all on function public.storm_refresh_counts(date) from public, anon, authenticated;
revoke all on function public.storm_recompute_day(date) from public, anon, authenticated;
revoke all on function public.storm_recheck_record(text, uuid) from public, anon, authenticated;
revoke all on function public.storm_alert_targets(date) from public, anon, authenticated;
grant execute on function public.storm_recompute_day(date) to service_role;
grant execute on function public.storm_alert_targets(date) to service_role;
revoke all on function public.storm_list(integer) from public, anon;
revoke all on function public.storm_detail(date) from public, anon;
revoke all on function public.storm_check_hit(date, text, uuid, boolean) from public, anon;
revoke all on function public.storm_mark_checked(date, boolean) from public, anon;
revoke all on function public.storm_reports_range(timestamptz, timestamptz) from public, anon;
grant execute on function public.storm_list(integer) to authenticated;
grant execute on function public.storm_detail(date) to authenticated;
grant execute on function public.storm_check_hit(date, text, uuid, boolean) to authenticated;
grant execute on function public.storm_mark_checked(date, boolean) to authenticated;
grant execute on function public.storm_reports_range(timestamptz, timestamptz) to authenticated;

commit;
