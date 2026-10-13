-- Solar Shield for COMMERCIAL customers (2026-10-12, Devon). Each tier has a
-- commercial price that covers a number of panels:
--   Bronze $999 / yr   up to 100 panels
--   Silver $1,499 / yr up to 250 panels
--   Gold   $1,999 / yr any size (the only tier over 250 panels)
-- Residential prices are unchanged ($299 / $499 / $899).
--
-- leads.is_commercial + leads.panel_count (the rep fills the count in on the
-- call); every lead from a "...Commercial..." list is commercial (backfill + an
-- insert trigger). Booking copies both onto the customer and the job
-- (jobs.plan_commercial, jobs.module_count). service_plan_price() now takes the
-- commercial flag and panel count: a commercial tier needs a panel count and
-- refuses a system bigger than the tier covers. set_service_plan follows the
-- job. service-visit-done charges service_plans.commercial_stripe_price_id for
-- a commercial job (live prices, set right after this migration).
-- public_service_plans() also returns the commercial columns (brochure).
-- book_service_visit below is the live 2026-10-07 definition with three edits.
-- Idempotent.

begin;

alter table public.service_plans
  add column if not exists commercial_amount_cents integer,
  add column if not exists commercial_max_panels integer,
  add column if not exists commercial_stripe_price_id text;
update public.service_plans set commercial_amount_cents = 99900,  commercial_max_panels = 100  where company = 'dc-solar' and tier = 'bronze';
update public.service_plans set commercial_amount_cents = 149900, commercial_max_panels = 250  where company = 'dc-solar' and tier = 'silver';
update public.service_plans set commercial_amount_cents = 199900, commercial_max_panels = null where company = 'dc-solar' and tier = 'gold';

alter table public.leads
  add column if not exists is_commercial boolean not null default false,
  add column if not exists panel_count integer;
alter table public.leads drop constraint if exists leads_panel_count_check;
alter table public.leads add constraint leads_panel_count_check check (panel_count is null or panel_count between 1 and 100000);
update public.leads set is_commercial = true where source ilike '%commercial%' and not is_commercial;

create or replace function public.leads_commercial_from_source()
returns trigger language plpgsql set search_path = public as $f$
begin
  if new.source ilike '%commercial%' then
    new.is_commercial := true;
  end if;
  return new;
end;
$f$;
drop trigger if exists leads_commercial_from_source on public.leads;
create trigger leads_commercial_from_source before insert on public.leads
  for each row execute function public.leads_commercial_from_source();

alter table public.customers
  add column if not exists is_commercial boolean not null default false,
  add column if not exists panel_count integer;
alter table public.jobs add column if not exists plan_commercial boolean not null default false;

create or replace function public.service_plan_price(
  p_company text, p_plan text, p_price_cents integer, p_commercial boolean, p_panels integer)
returns integer language plpgsql stable security definer set search_path = public as $f$
declare
  v_amount integer;
  v_max    integer;
begin
  if p_plan in ('bronze', 'silver', 'gold') then
    if coalesce(p_commercial, false) then
      if p_panels is null or p_panels < 1 then
        raise exception 'enter the number of panels to quote a commercial plan' using errcode = '22023';
      end if;
      select commercial_amount_cents, commercial_max_panels into v_amount, v_max
        from public.service_plans where company = p_company and tier = p_plan;
      if v_amount is null then
        raise exception 'that commercial plan is not set up yet, ask an admin' using errcode = '22023';
      end if;
      if v_max is not null and p_panels > v_max then
        raise exception '% panels is more than % covers (up to % panels), pick a bigger plan',
          p_panels, initcap(p_plan), v_max using errcode = '22023';
      end if;
      return v_amount;
    end if;
    select amount_cents into v_amount from public.service_plans where company = p_company and tier = p_plan;
    if v_amount is null then
      raise exception 'that plan is not set up yet, ask an admin' using errcode = '22023';
    end if;
    return v_amount;
  elsif p_plan = 'custom' then
    if p_price_cents is null or p_price_cents < 100 or p_price_cents > 1000000 then
      raise exception 'enter a custom yearly price between $1 and $10,000' using errcode = '22023';
    end if;
    return p_price_cents;
  end if;
  raise exception 'pick a plan: Bronze, Silver, Gold or Custom' using errcode = '22023';
end;
$f$;

-- The 3-argument form (residential) stays for anything still calling it.
create or replace function public.service_plan_price(p_company text, p_plan text, p_price_cents integer)
returns integer language sql stable security definer set search_path = public as $f$
  select public.service_plan_price(p_company, p_plan, p_price_cents, false, null);
$f$;

CREATE OR REPLACE FUNCTION public.book_service_visit(p_lead_id uuid, p_kind text, p_date date, p_start time without time zone DEFAULT NULL::time without time zone, p_note text DEFAULT NULL::text, p_plan text DEFAULT NULL::text, p_price_cents integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email    text := lower(public.jwt_email());
  v_today    date := (now() at time zone 'America/Chicago')::date;
  v_lead     public.leads%rowtype;
  v_rep      text;
  v_note     text := nullif(trim(coalesce(p_note, '')), '');
  v_digits   text;
  v_dup      uuid;
  v_customer uuid;
  v_job      uuid;
  v_number   text;
  v_price    integer;
begin
  if v_email is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('Cleaning', 'Inspection') then
    raise exception 'the visit type must be Cleaning or Inspection' using errcode = '22023';
  end if;
  if p_date is null or p_date < v_today then
    raise exception 'pick today or a later date' using errcode = '22023';
  end if;

  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    raise exception 'lead not found' using errcode = 'P0002';
  end if;
  if not (
    (public.is_company_admin(v_lead.company) or public.is_sales_manager(v_lead.company))
    or (public.is_company_staff(v_lead.company) and lower(coalesce(v_lead.assigned_to, '')) = v_email)
  ) then
    raise exception 'only the rep this lead is assigned to, a sales manager or an admin can book it' using errcode = '42501';
  end if;
  if v_lead.converted_job_id is not null or v_lead.status not in ('new', 'contacted', 'interested') then
    raise exception 'this lead already has a visit or is closed' using errcode = '22023';
  end if;
  if coalesce(trim(v_lead.name), '') = '' or coalesce(trim(v_lead.phone), '') = ''
     or coalesce(trim(v_lead.email), '') = '' or coalesce(trim(v_lead.address), '') = '' then
    raise exception 'name, phone, email and address are all needed to book a visit' using errcode = '22023';
  end if;

  -- A previous bundle sends no plan: book as before (legacy price at charge).
  if p_plan is not null then
    -- Commercial (2026-10-12): the lead's flag and panel count pick the price
    -- and refuse a tier too small for the system.
    v_price := public.service_plan_price(v_lead.company, p_plan, p_price_cents, v_lead.is_commercial, v_lead.panel_count);
  end if;

  v_rep := lower(coalesce(v_lead.assigned_to, v_email));

  -- Same person already a customer? Flag it, never attach to it.
  v_digits := right(regexp_replace(v_lead.phone, '\D', '', 'g'), 10);
  select c.id into v_dup
    from public.customers c
   where c.company = v_lead.company
     and c.archived_at is null
     and (
       (length(v_digits) = 10 and right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10) = v_digits)
       or (c.email is not null and lower(trim(c.email)) = lower(trim(v_lead.email)))
     )
   order by c.created_at
   limit 1;

  insert into public.customers
    (company, name, phone, email, address, sms_opt_in_at, sms_opt_in_source, possible_duplicate_of,
     is_commercial, panel_count)
  values
    (v_lead.company, trim(v_lead.name), v_lead.phone, v_lead.email, v_lead.address,
     v_lead.sms_opt_in_at, v_lead.sms_opt_in_source, v_dup,
     v_lead.is_commercial, v_lead.panel_count)
  returning id into v_customer;

  v_number := public.next_service_job_number(v_lead.company);

  insert into public.jobs
    (company, name, customer_id, status, stage, job_type, address, scheduled_for,
     sales_rep_email, job_number, description, plan_tier, plan_price_cents, plan_commercial, module_count)
  values
    (v_lead.company, trim(v_lead.name), v_customer, 'active', 'Service Call', p_kind, v_lead.address, p_date,
     v_rep, v_number, v_note, p_plan, v_price, v_lead.is_commercial, v_lead.panel_count)
  returning id into v_job;

  insert into public.job_schedule_dates (company, job_id, work_date, start_time, note)
  values (v_lead.company, v_job, p_date, p_start, v_note);

  perform set_config('app.lead_guard_bypass', 'on', true);
  update public.leads
     set status = 'scheduled', converted_job_id = v_job
   where id = v_lead.id;
  perform set_config('app.lead_guard_bypass', 'off', true);

  return jsonb_build_object(
    'job_id', v_job,
    'job_number', v_number,
    'customer_id', v_customer,
    'possible_duplicate_of', v_dup
  );
end;
$function$;

create or replace function public.set_service_plan(p_job_id uuid, p_plan text, p_price_cents integer default null)
returns void language plpgsql security definer set search_path = public as $f$
declare
  v_email text := lower(public.jwt_email());
  v_job   public.jobs%rowtype;
  v_price integer;
begin
  if v_email is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found then
    raise exception 'visit not found' using errcode = 'P0002';
  end if;
  if not (
    (public.is_company_admin(v_job.company) or public.is_sales_manager(v_job.company))
    or (public.is_company_staff(v_job.company) and lower(coalesce(v_job.sales_rep_email, '')) = v_email)
  ) then
    raise exception 'only the rep who booked this visit, or an admin, can change its plan' using errcode = '42501';
  end if;
  if coalesce(v_job.job_type, '') not in ('Cleaning', 'Inspection') or v_job.stage is distinct from 'Service Call'
     or v_job.service_paid_at is not null then
    raise exception 'the plan can only change before the visit is done and paid' using errcode = '22023';
  end if;
  v_price := public.service_plan_price(v_job.company, p_plan, p_price_cents, v_job.plan_commercial, v_job.module_count);
  update public.jobs
     set plan_tier = p_plan, plan_price_cents = v_price, updated_at = now()
   where id = p_job_id;
end;
$f$;

drop function if exists public.public_service_plans();
create function public.public_service_plans()
returns table(tier text, label text, amount_cents integer, includes text,
              commercial_amount_cents integer, commercial_max_panels integer)
language sql stable security definer set search_path = public as $f$
  select sp.tier, sp.label, sp.amount_cents, sp.includes, sp.commercial_amount_cents, sp.commercial_max_panels
    from service_plans sp
   where sp.company = 'dc-solar'
   order by sp.sort;
$f$;
revoke all on function public.public_service_plans() from public;
grant execute on function public.public_service_plans() to anon, authenticated, service_role;

commit;
