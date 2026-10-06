-- Service plan tiers + custom price + the 2-year agreement (2026-10-06).
--
-- THE PLANS. Bronze $299 / Silver $499 / Gold $899 a year (Carson), each a
-- yearly Stripe Price on one product. `service_plans` holds them — label,
-- amount, Stripe price — so the booking form can show prices to a rep
-- (company_settings is admin-only) and a price change is a row edit, not a
-- release. A rep may instead sell a CUSTOM yearly price ("if they can swing
-- it"); no floor for now, it is just tagged Custom for admins.
--
-- WHERE A SALE IS RECORDED.
--   jobs.plan_tier / plan_price_cents    what the rep sold on this booking
--                                         (book_service_visit, set_service_plan)
--   customers.plan_tier / plan_price_cents / contract_starts_on / contract_ends_on
--                                         what they are actually on, written by
--                                         service-visit-done when year one is
--                                         charged. The agreement is 2 years
--                                         minimum on every plan (for now);
--                                         stripe-webhook flags a cancel before
--                                         contract_ends_on.
--
-- WHO SEES IT. service_plans: every employee may read (the rep quotes them);
-- admins write. The jobs/customers columns follow those tables' existing
-- policies. Nothing here is a secret — a price id is not a key.
--
-- book_service_visit gains p_plan / p_price_cents (defaulted, so a phone still
-- running the previous bundle books exactly as before, charged at the legacy
-- company_settings.stripe_annual_price_id). The old 5-argument version is
-- dropped first so PostgREST never sees two overloads.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. The tiers
-- ---------------------------------------------------------------------------
create table if not exists public.service_plans (
  company          text not null default 'dc-solar',
  tier             text not null check (tier in ('bronze', 'silver', 'gold')),
  label            text not null,
  amount_cents     integer not null check (amount_cents > 0),
  stripe_price_id  text not null check (stripe_price_id ~ '^price_[A-Za-z0-9]+$'),
  sort             integer not null default 0,
  updated_at       timestamptz not null default now(),
  primary key (company, tier)
);

alter table public.service_plans enable row level security;

drop policy if exists sp_staff_select on public.service_plans;
create policy sp_staff_select on public.service_plans for select
  using (public.is_company_staff(company));
drop policy if exists sp_admin_insert on public.service_plans;
create policy sp_admin_insert on public.service_plans for insert
  with check (public.is_company_admin(company));
drop policy if exists sp_admin_update on public.service_plans;
create policy sp_admin_update on public.service_plans for update
  using (public.is_company_admin(company)) with check (public.is_company_admin(company));

insert into public.service_plans (company, tier, label, amount_cents, stripe_price_id, sort) values
  ('dc-solar', 'bronze', 'Bronze', 29900, 'price_1UNMMFIGKObcdHTL9MmcKYhG', 1),
  ('dc-solar', 'silver', 'Silver', 49900, 'price_1UNMMWIGKObcdHTLBPMfUM45', 2),
  ('dc-solar', 'gold',   'Gold',   89900, 'price_1UNMMrIGKObcdHTL0DTpkS0o', 3)
on conflict (company, tier) do nothing;

-- ---------------------------------------------------------------------------
-- 2. What was sold, and what they are on
-- ---------------------------------------------------------------------------
alter table public.jobs
  add column if not exists plan_tier        text,
  add column if not exists plan_price_cents integer;
alter table public.jobs drop constraint if exists jobs_plan_tier_check;
alter table public.jobs add constraint jobs_plan_tier_check
  check (plan_tier is null or plan_tier in ('bronze', 'silver', 'gold', 'custom'));
alter table public.jobs drop constraint if exists jobs_plan_price_check;
alter table public.jobs add constraint jobs_plan_price_check
  check (plan_price_cents is null or plan_price_cents > 0);
comment on column public.jobs.plan_tier is
  'Service visits: the plan the rep sold on this booking (bronze/silver/gold/custom). '
  'Null = booked before plans existed (charged at the legacy company price).';
comment on column public.jobs.plan_price_cents is
  'Service visits: the yearly price sold, in cents (the tier price, or the rep''s custom price).';

alter table public.customers
  add column if not exists plan_tier          text,
  add column if not exists plan_price_cents   integer,
  add column if not exists contract_starts_on date,
  add column if not exists contract_ends_on   date;
comment on column public.customers.contract_ends_on is
  'End of the minimum 2-year service agreement (set when year one is charged). '
  'A cancel before this date is flagged by stripe-webhook.';

-- ---------------------------------------------------------------------------
-- 3. Validating a plan choice (shared by book + change)
-- ---------------------------------------------------------------------------
create or replace function public.service_plan_price(
  p_company     text,
  p_plan        text,
  p_price_cents integer
)
returns integer language plpgsql stable security definer set search_path = public as $$
declare
  v_amount integer;
begin
  if p_plan in ('bronze', 'silver', 'gold') then
    select amount_cents into v_amount from public.service_plans where company = p_company and tier = p_plan;
    if v_amount is null then
      raise exception 'that plan is not set up yet — ask an admin' using errcode = '22023';
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
$$;
revoke all on function public.service_plan_price(text, text, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Book — same as 2026-10-05_service_visits.sql, plus the plan
-- ---------------------------------------------------------------------------
drop function if exists public.book_service_visit(uuid, text, date, time, text);

create or replace function public.book_service_visit(
  p_lead_id     uuid,
  p_kind        text,
  p_date        date,
  p_start       time default null,
  p_note        text default null,
  p_plan        text default null,
  p_price_cents integer default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
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
    public.is_company_admin(v_lead.company)
    or (public.is_company_staff(v_lead.company) and lower(coalesce(v_lead.assigned_to, '')) = v_email)
  ) then
    raise exception 'only the rep this lead is assigned to, or an admin, can book it' using errcode = '42501';
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
    v_price := public.service_plan_price(v_lead.company, p_plan, p_price_cents);
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
    (company, name, phone, email, address, sms_opt_in_at, sms_opt_in_source, possible_duplicate_of)
  values
    (v_lead.company, trim(v_lead.name), v_lead.phone, v_lead.email, v_lead.address,
     v_lead.sms_opt_in_at, v_lead.sms_opt_in_source, v_dup)
  returning id into v_customer;

  v_number := public.next_service_job_number(v_lead.company);

  insert into public.jobs
    (company, name, customer_id, status, stage, job_type, address, scheduled_for,
     sales_rep_email, job_number, description, plan_tier, plan_price_cents)
  values
    (v_lead.company, trim(v_lead.name), v_customer, 'active', 'Service Call', p_kind, v_lead.address, p_date,
     v_rep, v_number, v_note, p_plan, v_price)
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
$$;

-- ---------------------------------------------------------------------------
-- 5. Change the plan on an open, unpaid visit (the rep who booked it, or an admin)
-- ---------------------------------------------------------------------------
create or replace function public.set_service_plan(
  p_job_id      uuid,
  p_plan        text,
  p_price_cents integer default null
)
returns void language plpgsql security definer set search_path = public as $$
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
    public.is_company_admin(v_job.company)
    or (public.is_company_staff(v_job.company) and lower(coalesce(v_job.sales_rep_email, '')) = v_email)
  ) then
    raise exception 'only the rep who booked this visit, or an admin, can change its plan' using errcode = '42501';
  end if;
  if coalesce(v_job.job_type, '') not in ('Cleaning', 'Inspection') or v_job.stage is distinct from 'Service Call'
     or v_job.service_paid_at is not null then
    raise exception 'the plan can only change before the visit is done and paid' using errcode = '22023';
  end if;
  v_price := public.service_plan_price(v_job.company, p_plan, p_price_cents);
  update public.jobs
     set plan_tier = p_plan, plan_price_cents = v_price, updated_at = now()
   where id = p_job_id;
end;
$$;

revoke all on function public.book_service_visit(uuid, text, date, time, text, text, integer) from public, anon;
grant execute on function public.book_service_visit(uuid, text, date, time, text, text, integer) to authenticated;
revoke all on function public.set_service_plan(uuid, text, integer) from public, anon;
grant execute on function public.set_service_plan(uuid, text, integer) to authenticated;

commit;
