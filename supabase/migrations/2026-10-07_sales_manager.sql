-- Sales Manager role (2026-10-07). Ken Crum is the first.
--
-- A sales_manager is a sales employee who also runs the team:
--   • sees EVERY lead and every service-plan customer / visit (not installs,
--     job money, payroll — admins keep those), the team's tasks, and all
--     lead messages;
--   • assigns and reassigns leads (assign_leads, and changing a lead's owner —
--     "Take it" — which leads_guard_ownership allowed admins only);
--   • books, reschedules, cancels and re-plans visits on any lead (the owner
--     stays the selling rep, so the commission stays theirs);
--   • otherwise is a rep: own DC Solar number, own commission (30% on leads
--     they own — no team override, Carson), confined to the sales app.
-- Imports stay admin-only. Texts and missed calls to a rep's number still
-- notify only that rep.
--
-- HOW: is_company_sales() now means "sales OR sales_manager" (everything a rep
-- may do, a manager may do), is_company_member() excludes both (no crew
-- data), and is_sales_manager() opens the team-wide policies below.
-- is_sales_rep_for_customer() answers true for a manager on any customer with
-- a service visit or a booked lead. The five RPCs are the 2026-10-05/06
-- definitions with "or a sales manager" added to their permission check.
--
-- Idempotent: safe to re-run.

begin;

alter table public.employees drop constraint if exists employees_role_check;
alter table public.employees add constraint employees_role_check
  check (role in ('owner', 'operator', 'viewer', 'sales', 'sales_manager'));

create or replace function public.is_sales_manager(comp text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from employees e
     where e.email = (auth.jwt() ->> 'email') and e.company = comp and e.role = 'sales_manager'
  );
$$;

create or replace function public.is_company_sales(comp text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from employees e
     where e.email = (auth.jwt() ->> 'email') and e.company = comp and e.role in ('sales', 'sales_manager')
  );
$$;

create or replace function public.is_company_member(comp text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from employees e
     where e.email = (auth.jwt() ->> 'email') and e.company = comp and e.role not in ('sales', 'sales_manager')
  );
$$;

create or replace function public.is_sales_rep_for_customer(cust uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
      select 1 from jobs j
       where j.customer_id = cust and j.sales_rep_email is not null
         and lower(j.sales_rep_email) = lower(auth.jwt() ->> 'email')
    )
    or exists (
      select 1 from leads l join jobs j on j.id = l.converted_job_id
       where j.customer_id = cust and l.assigned_to is not null
         and lower(l.assigned_to) = lower(auth.jwt() ->> 'email')
    )
    -- A sales manager: any customer the sales side made (a service visit, or a booked lead).
    or (
      exists (select 1 from customers c where c.id = cust and public.is_sales_manager(c.company))
      and (
        exists (select 1 from jobs j where j.customer_id = cust and j.job_type in ('Cleaning', 'Inspection'))
        or exists (select 1 from leads l join jobs j on j.id = l.converted_job_id where j.customer_id = cust)
      )
    );
$$;

-- The website's two broad read policies excluded role 'sales' by name; a
-- manager must be excluded the same way, or he would read every job/customer.
drop policy if exists "customers company read" on public.customers;
create policy "customers company read" on public.customers for select
  using (company = (select employees.company from employees
                     where employees.email = (auth.jwt() ->> 'email') and employees.role not in ('sales', 'sales_manager')));
drop policy if exists "jobs company read" on public.jobs;
create policy "jobs company read" on public.jobs for select
  using (company = (select employees.company from employees
                     where employees.email = (auth.jwt() ->> 'email') and employees.role not in ('sales', 'sales_manager')));

-- Team-wide reads and edits for a manager -------------------------------------
drop policy if exists leads_manager_select on public.leads;
create policy leads_manager_select on public.leads for select
  using (public.is_sales_manager(company));
drop policy if exists leads_manager_update on public.leads;
create policy leads_manager_update on public.leads for update
  using (public.is_sales_manager(company)) with check (public.is_sales_manager(company));

drop policy if exists jobs_manager_service_select on public.jobs;
create policy jobs_manager_service_select on public.jobs for select
  using (public.is_sales_manager(company) and job_type in ('Cleaning', 'Inspection'));

drop policy if exists tasks_manager_select on public.tasks;
create policy tasks_manager_select on public.tasks for select
  using (public.is_sales_manager(company) and (lead_id is not null or customer_id is not null));

-- Who is on the sales team, for owner chips and the assign picker (names and
-- emails of sales + sales managers only; employees itself stays admin-read).
create or replace function public.sales_team()
returns table (email text, display_name text, role text)
language sql stable security definer set search_path = public as $$
  select lower(e.email), coalesce(e.display_name, e.email), e.role
    from employees e
   where e.company = 'dc-solar' and e.role in ('sales', 'sales_manager') and not e.is_test
     and public.is_company_staff('dc-solar')
   order by e.display_name;
$$;

-- An admin changes someone's role (employees has no write policies by design).
create or replace function public.set_employee_role(p_email text, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_company text;
  v_current text;
begin
  select company, role into v_company, v_current from employees where lower(email) = lower(p_email);
  if v_company is null then
    raise exception 'employee not found' using errcode = 'P0002';
  end if;
  if not public.is_company_admin(v_company) then
    raise exception 'admins only' using errcode = '42501';
  end if;
  if p_role not in ('viewer', 'sales', 'sales_manager', 'operator') then
    raise exception 'pick Crew, Sales, Sales manager or Operator' using errcode = '22023';
  end if;
  if v_current = 'owner' then
    raise exception 'the owner''s role cannot be changed here' using errcode = '22023';
  end if;
  update employees set role = p_role where lower(email) = lower(p_email);
end;
$$;

-- RPCs: the existing definitions, plus "or a sales manager" ---------------------
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
    (public.is_company_admin(v_job.company) or public.is_sales_manager(v_job.company))
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

create or replace function public.reschedule_service_visit(
  p_job_id uuid,
  p_date   date,
  p_start  time default null
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(public.jwt_email());
  v_today date := (now() at time zone 'America/Chicago')::date;
  v_job   public.jobs%rowtype;
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
    raise exception 'only the rep who booked this visit, or an admin, can change it' using errcode = '42501';
  end if;
  if coalesce(v_job.job_type, '') not in ('Cleaning', 'Inspection') or v_job.stage is distinct from 'Service Call' then
    raise exception 'only an open service visit can be rescheduled' using errcode = '22023';
  end if;
  if p_date is null or p_date < v_today then
    raise exception 'pick today or a later date' using errcode = '22023';
  end if;

  update public.job_schedule_dates
     set work_date = p_date, start_time = p_start
   where job_id = p_job_id;
  if not found then
    insert into public.job_schedule_dates (company, job_id, work_date, start_time)
    values (v_job.company, p_job_id, p_date, p_start);
  end if;
  update public.jobs set scheduled_for = p_date, updated_at = now() where id = p_job_id;
end;
$$;

create or replace function public.cancel_service_visit(
  p_job_id uuid,
  p_reason text default null
)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_email  text := lower(public.jwt_email());
  v_job    public.jobs%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_stamp  text := to_char(now() at time zone 'America/Chicago', 'Mon FMDD');
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
    raise exception 'only the rep who booked this visit, or an admin, can cancel it' using errcode = '42501';
  end if;
  if coalesce(v_job.job_type, '') not in ('Cleaning', 'Inspection') or v_job.stage is distinct from 'Service Call' then
    raise exception 'only an open service visit can be cancelled' using errcode = '22023';
  end if;
  if exists (select 1 from public.time_entries where job_id = p_job_id)
     or exists (select 1 from public.employee_hours where job_id = p_job_id)
     or exists (select 1 from public.job_photos where job_id = p_job_id)
     or exists (select 1 from public.receipts where job_id = p_job_id)
     or exists (select 1 from public.finance_entries where job_id = p_job_id)
     or exists (select 1 from public.job_documents where job_id = p_job_id)
     or exists (select 1 from public.job_materials where job_id = p_job_id)
     or exists (select 1 from public.inventory_transactions where job_id = p_job_id)
     or exists (select 1 from public.monitoring_logins where job_id = p_job_id) then
    raise exception 'this visit already has crew time, photos or payments on it — ask an admin to cancel it'
      using errcode = '22023';
  end if;

  -- The lead goes back to Interested, ready to rebook, with the reason noted.
  perform set_config('app.lead_guard_bypass', 'on', true);
  update public.leads
     set status = 'interested',
         converted_job_id = null,
         notes = case
           when v_reason is null then notes
           else concat_ws(E'\n', nullif(notes, ''), 'Visit cancelled ' || v_stamp || ': ' || v_reason)
         end
   where converted_job_id = p_job_id;
  perform set_config('app.lead_guard_bypass', 'off', true);

  delete from public.job_assignments where job_id = p_job_id;
  delete from public.jobs where id = p_job_id;  -- schedule dates, stage history, Dropbox queue cascade

  -- The customer record this booking made, unless something else now hangs off it.
  if v_job.customer_id is not null
     and not exists (select 1 from public.jobs where customer_id = v_job.customer_id)
     and not exists (select 1 from public.finance_entries where customer_id = v_job.customer_id)
     and not exists (select 1 from public.customer_documents where customer_id = v_job.customer_id)
     and not exists (select 1 from public.customer_accounts where customer_id = v_job.customer_id)
     and not exists (select 1 from public.customer_notes where customer_id = v_job.customer_id)
     and not exists (select 1 from public.messages where customer_id = v_job.customer_id)
     and not exists (select 1 from public.contacts where customer_id = v_job.customer_id)
     and not exists (select 1 from public.employee_hours where customer_id = v_job.customer_id) then
    delete from public.customers where id = v_job.customer_id;
  end if;
end;
$$;

create or replace function public.leads_guard_ownership()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.jwt_email() is null
     or public.is_company_admin(new.company)
     or current_setting('app.lead_guard_bypass', true) = 'on' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.converted_job_id is not null then
      raise exception 'only an admin may link a lead to a job'
        using errcode = '42501';
    end if;
  elsif (new.assigned_to is distinct from old.assigned_to and not public.is_sales_manager(new.company))
     or new.converted_job_id is distinct from old.converted_job_id
     or new.company          is distinct from old.company then
    raise exception 'only an admin may change who a lead belongs to or which job it became'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.assign_leads(p_ids uuid[], p_rep text)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_company text := 'dc-solar';
  v_rep     text := lower(trim(coalesce(p_rep, '')));
  v_count   integer;
begin
  if not (public.is_company_admin(v_company) or public.is_sales_manager(v_company)) then
    raise exception 'admins and sales managers only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.employees e where e.company = v_company and lower(e.email) = v_rep) then
    raise exception 'pick someone on the team' using errcode = '22023';
  end if;
  perform set_config('app.bulk_assign', 'on', true);
  update public.leads
     set assigned_to = v_rep
   where company = v_company
     and id = any(coalesce(p_ids, '{}'))
     and assigned_to is distinct from v_rep;
  get diagnostics v_count = row_count;
  perform set_config('app.bulk_assign', 'off', true);
  if v_count > 0 and v_rep is distinct from lower(coalesce(public.jwt_email(), '')) then
    insert into public.lead_assignment_batches (company, rep_email, lead_count, assigned_by)
    values (v_company, v_rep, v_count, lower(public.jwt_email()));
  end if;
  return v_count;
end;
$$;

create or replace function public.record_sales_commission(
  p_customer_id uuid,
  p_kind        text,
  p_stripe_ref  text,
  p_invoice_id  text,
  p_amount      integer,
  p_occurred_on date
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_company text;
  v_rep     text;
  v_rate    numeric(5,4);
  v_start   date;
  v_end     date;
  v_id      uuid;
begin
  select company into v_company from public.customers where id = p_customer_id;
  if v_company is null or coalesce(p_amount, 0) = 0 then
    return null;
  end if;

  if p_kind = 'refund' then
    -- Same rep and rate as the payment being refunded.
    select rep_email, rate into v_rep, v_rate
      from public.sales_commissions
     where stripe_invoice_id = p_invoice_id and kind in ('first', 'renewal')
     order by created_at limit 1;
  else
    select lower(j.sales_rep_email) into v_rep
      from public.jobs j
      join public.employees e on lower(e.email) = lower(j.sales_rep_email) and e.role in ('sales', 'sales_manager')
     where j.customer_id = p_customer_id
       and j.job_type in ('Cleaning', 'Inspection')
     order by j.created_at desc
     limit 1;
    select commission_rate into v_rate from public.company_settings where company = v_company;
  end if;
  if v_rep is null or v_rate is null then
    return null;
  end if;

  select period_start, period_end into v_start, v_end from public.pay_period_of(v_company, p_occurred_on);

  insert into public.sales_commissions
    (company, rep_email, customer_id, kind, stripe_ref, stripe_invoice_id, amount_cents, rate,
     commission_cents, occurred_on, period_start, period_end)
  values
    (v_company, v_rep, p_customer_id, p_kind, p_stripe_ref, p_invoice_id, p_amount, v_rate,
     round(p_amount * v_rate)::integer, p_occurred_on, v_start, v_end)
  on conflict (stripe_ref) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.is_sales_manager(text) from public, anon;
grant execute on function public.is_sales_manager(text) to authenticated;
revoke all on function public.sales_team() from public, anon;
grant execute on function public.sales_team() to authenticated;
revoke all on function public.set_employee_role(text, text) from public, anon;
grant execute on function public.set_employee_role(text, text) to authenticated;

commit;
