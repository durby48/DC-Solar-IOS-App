-- Crew availability for booking service visits (2026-10-06, S2).
--
-- THE RULE (Carson):
--   field crew      = employees with field_crew = true (Devon, Isaiah, Garrett,
--                     Simon, Ben, Tyler; Ethan once invited — never Clark or
--                     sales reps)
--   busy that day   = field crew assigned (job_assignments) to any NON-service
--                     job scheduled that day (job_schedule_dates)
--   free            = field crew − busy
--   the service crew (service_crew_size, default 2) runs only if free ≥ that,
--   and does up to service_visits_per_day (default 5) visits
--   spots left      = that − service visits already booked that day (booked
--                     visits count whether or not anyone is assigned to them)
--   FULL            = no spots left
--   a non-service job that day with nobody assigned = "Job not staffed": shown,
--   never blocks.
--
-- WHO SEES WHAT. service_availability() answers COUNTS only — no job, customer
-- or crew name — so a sales rep can see "3 of 5 visits left" without seeing
-- whose install is taking the crew. Any employee may call it.
--
-- ENFORCED FOR SALES. A trigger on job_schedule_dates refuses a sales rep's
-- service visit on a full day (book and reschedule both write there). Admins
-- may still book over capacity on purpose.
--
-- employees has NO write policies by design, so the Field crew checkbox goes
-- through set_field_crew(), admin-only.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. Who is field crew, and the service crew's capacity
-- ---------------------------------------------------------------------------
alter table public.employees add column if not exists field_crew boolean not null default false;
comment on column public.employees.field_crew is
  'Counts toward daily crew availability for service-visit booking (2026-10-06). '
  'Set by admins (set_field_crew).';

update public.employees
   set field_crew = true
 where company = 'dc-solar'
   and lower(email) in (
     'devonsd311@gmail.com',      -- Devon
     'inettleton18@gmail.com',    -- Isaiah
     'gnimsgern.2022@gmail.com',  -- Garrett
     'snettleton2005@gmail.com',  -- Simon
     'bnettleton403@gmail.com',   -- Ben
     'tylersisson99@yahoo.com'    -- Tyler
   )
   and field_crew = false;

alter table public.company_settings
  add column if not exists service_crew_size      integer not null default 2,
  add column if not exists service_visits_per_day integer not null default 5;
alter table public.company_settings drop constraint if exists company_settings_service_capacity_check;
alter table public.company_settings add constraint company_settings_service_capacity_check
  check (service_crew_size between 1 and 20 and service_visits_per_day between 1 and 50);

create or replace function public.set_field_crew(p_email text, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_company text;
begin
  select company into v_company from public.employees where lower(email) = lower(p_email);
  if v_company is null then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
  if not public.is_company_admin(v_company) then
    raise exception 'admins only' using errcode = '42501';
  end if;
  update public.employees set field_crew = coalesce(p_on, false) where lower(email) = lower(p_email);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Availability per day (counts only)
-- ---------------------------------------------------------------------------
create or replace function public.service_availability(
  p_from date,
  p_to   date,
  p_exclude_job uuid default null
)
returns table (
  day            date,
  field_crew     integer,
  busy_crew      integer,
  free_crew      integer,
  visits_booked  integer,
  visit_spots    integer,
  spots_left     integer,
  unstaffed_jobs integer
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_company text := 'dc-solar';
  v_size    integer;
  v_per_day integer;
  v_crew    integer;
begin
  if not public.is_company_staff(v_company) then
    raise exception 'staff only' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'ask for at most two months at a time' using errcode = '22023';
  end if;

  select coalesce(cs.service_crew_size, 2), coalesce(cs.service_visits_per_day, 5)
    into v_size, v_per_day
    from public.company_settings cs where cs.company = v_company;
  v_size := coalesce(v_size, 2);
  v_per_day := coalesce(v_per_day, 5);
  select count(*) into v_crew from public.employees e where e.company = v_company and e.field_crew;

  return query
  with days as (
    select d::date as day from generate_series(p_from, p_to, interval '1 day') d
  ),
  other_jobs as (
    select jsd.work_date as day, j.id as job_id
      from public.job_schedule_dates jsd
      join public.jobs j on j.id = jsd.job_id
     where jsd.company = v_company
       and jsd.work_date between p_from and p_to
       and coalesce(j.job_type, '') not in ('Cleaning', 'Inspection')
  ),
  busy as (
    select oj.day, count(distinct lower(ja.email))::integer as n
      from other_jobs oj
      join public.job_assignments ja on ja.job_id = oj.job_id
      join public.employees e on lower(e.email) = lower(ja.email) and e.company = v_company and e.field_crew
     group by oj.day
  ),
  unstaffed as (
    select oj.day, count(*)::integer as n
      from other_jobs oj
     where not exists (select 1 from public.job_assignments ja where ja.job_id = oj.job_id)
     group by oj.day
  ),
  visits as (
    select jsd.work_date as day, count(*)::integer as n
      from public.job_schedule_dates jsd
      join public.jobs j on j.id = jsd.job_id
     where jsd.company = v_company
       and jsd.work_date between p_from and p_to
       and coalesce(j.job_type, '') in ('Cleaning', 'Inspection')
       and (p_exclude_job is null or j.id <> p_exclude_job)
     group by jsd.work_date
  )
  select
    d.day,
    v_crew,
    coalesce(b.n, 0),
    greatest(v_crew - coalesce(b.n, 0), 0),
    coalesce(v.n, 0),
    case when v_crew - coalesce(b.n, 0) >= v_size then v_per_day else 0 end,
    greatest((case when v_crew - coalesce(b.n, 0) >= v_size then v_per_day else 0 end) - coalesce(v.n, 0), 0),
    coalesce(u.n, 0)
  from days d
  left join busy b on b.day = d.day
  left join unstaffed u on u.day = d.day
  left join visits v on v.day = d.day
  order by d.day;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. A sales rep cannot book or move a visit onto a full day
-- ---------------------------------------------------------------------------
create or replace function public.jsd_service_capacity_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_type  text;
  v_left  integer;
begin
  if tg_op = 'UPDATE' and new.work_date is not distinct from old.work_date then
    return new;
  end if;
  -- Only sales are held to it; admins may overbook on purpose.
  if not public.is_company_sales(new.company) then
    return new;
  end if;
  select job_type into v_type from public.jobs where id = new.job_id;
  if coalesce(v_type, '') not in ('Cleaning', 'Inspection') then
    return new;
  end if;
  select a.spots_left into v_left
    from public.service_availability(new.work_date, new.work_date, new.job_id) a;
  if coalesce(v_left, 0) <= 0 then
    raise exception 'that day is full — pick another day' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists jsd_service_capacity_guard on public.job_schedule_dates;
create trigger jsd_service_capacity_guard
  before insert or update of work_date on public.job_schedule_dates
  for each row execute function public.jsd_service_capacity_guard();

revoke all on function public.set_field_crew(text, boolean) from public, anon;
grant execute on function public.set_field_crew(text, boolean) to authenticated;
revoke all on function public.service_availability(date, date, uuid) from public, anon;
grant execute on function public.service_availability(date, date, uuid) to authenticated;
revoke all on function public.jsd_service_capacity_guard() from public, anon, authenticated;

commit;
