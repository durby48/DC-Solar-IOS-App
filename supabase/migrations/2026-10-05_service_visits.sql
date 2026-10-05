-- Service visits: a sales rep books an Interested lead's cleaning or
-- inspection, Ops sees it, the crew marks it done (2026-10-05, B1).
--
-- THE FLOW.
--   1. book_service_visit(lead, Cleaning|Inspection, date, time) — the
--      assigned rep (or an admin), on a lead with name, phone, email and
--      address, in ONE transaction: creates the customer record, a service
--      job (stage 'Service Call', number SV-YY###, the rep as seller), its
--      schedule date (so it is on the Operations calendar and the crew get
--      the usual schedule push), and moves the lead to 'scheduled' linked to
--      the job. Replaces, for this path, the client-side convert flow, which
--      is not atomic.
--   2. reschedule_service_visit / cancel_service_visit — the rep who booked
--      it (or an admin). Cancel deletes the visit (and the customer record
--      the booking made) only while nothing real has happened on it — no
--      crew time, photos, receipts, payments; otherwise it refuses and an
--      admin handles it. The lead goes back to 'interested'.
--   3. mark_service_visit_done — any staff member except sales: the job goes
--      to 'Complete' and the lead to 'visit_done'. (B2 charges the card here.)
--
-- PIPELINE. 'Service Call' is a ninth job stage — every booked service job
-- sits in it until done, then joins 'Complete' with the installs. Whether it
-- has been paid is jobs.service_paid_at (null = Not paid), set by Stripe in B2.
--
-- NUMBERS. Service jobs get their own SV-YY### series so they do not use up
-- the DC-YY### project numbers (999 a year). Lowest free number, like the
-- app's DC numbering, under an advisory lock so two bookings cannot collide.
--
-- DUPLICATES. Booking always creates a NEW customer record (a rep never
-- inherits an existing customer's history); when the phone (last 10 digits)
-- or email matches an existing customer, customers.possible_duplicate_of
-- points at it so an admin can merge.
--
-- SALES VISIBILITY. Two read policies let a sales rep see their OWN service
-- jobs (job_type Cleaning/Inspection, sales_rep_email = them) and those jobs'
-- schedule dates — date, time, type, Paid/Not paid. No updates: every change
-- goes through the functions above.
--
-- LEAD GUARD. leads_guard_ownership (2026-10-05_sales_role.sql) refuses a
-- non-admin changing converted_job_id. The functions here change it on the
-- rep's behalf, so they set app.lead_guard_bypass for the statement; that
-- setting cannot be reached from the REST API.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. Values and columns
-- ---------------------------------------------------------------------------
alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads
  add constraint leads_status_check
  check (status in ('new', 'contacted', 'interested', 'scheduled', 'visit_done', 'estimating', 'won', 'lost'));

alter table public.jobs drop constraint if exists jobs_stage_check;
alter table public.jobs
  add constraint jobs_stage_check
  check (stage is null or stage in (
    'Pending Estimate', 'Pending Contract', 'Pending Removal', 'Pending Reinstall',
    'Pending Install', 'Pending Permit', 'Pending Payment', 'Service Call', 'Complete'
  ));

alter table public.jobs add column if not exists service_paid_at timestamptz;
comment on column public.jobs.service_paid_at is
  'Service visits only: when the customer''s card was charged (Stripe, B2). '
  'Null = Not paid. The Paid / Not paid tag on the Pipeline and in the CRM.';

alter table public.customers
  add column if not exists possible_duplicate_of uuid references public.customers (id) on delete set null;
comment on column public.customers.possible_duplicate_of is
  'Set by book_service_visit when the booked person''s phone or email matches '
  'an existing customer. An admin merges or clears it.';

-- ---------------------------------------------------------------------------
-- 2. The lead guard learns the bypass
-- ---------------------------------------------------------------------------
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
  elsif new.assigned_to      is distinct from old.assigned_to
     or new.converted_job_id is distinct from old.converted_job_id
     or new.company          is distinct from old.company then
    raise exception 'only an admin may change who a lead belongs to or which job it became'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Service job numbers: SV-YY###
-- ---------------------------------------------------------------------------
create or replace function public.next_service_job_number(comp text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_yy text := to_char(now() at time zone 'America/Chicago', 'YY');
  v_n  int;
begin
  perform pg_advisory_xact_lock(hashtext('service_job_number:' || comp));
  select g.n into v_n
    from generate_series(1, 999) as g(n)
   where not exists (
     select 1 from public.jobs j
      where j.company = comp and j.job_number = 'SV-' || v_yy || lpad(g.n::text, 3, '0')
   )
   order by g.n
   limit 1;
  if v_n is null then
    raise exception 'no service numbers left for 20%', v_yy;
  end if;
  return 'SV-' || v_yy || lpad(v_n::text, 3, '0');
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Book
-- ---------------------------------------------------------------------------
create or replace function public.book_service_visit(
  p_lead_id uuid,
  p_kind    text,
  p_date    date,
  p_start   time default null,
  p_note    text default null
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
     sales_rep_email, job_number, description)
  values
    (v_lead.company, trim(v_lead.name), v_customer, 'active', 'Service Call', p_kind, v_lead.address, p_date,
     v_rep, v_number, v_note)
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
-- 5. Reschedule / cancel (the rep who booked it, or an admin)
-- ---------------------------------------------------------------------------
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
    public.is_company_admin(v_job.company)
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
    public.is_company_admin(v_job.company)
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

-- ---------------------------------------------------------------------------
-- 6. Done (staff, never sales)
-- ---------------------------------------------------------------------------
create or replace function public.mark_service_visit_done(p_job_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'America/Chicago')::date;
  v_job   public.jobs%rowtype;
begin
  if public.jwt_email() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  select * into v_job from public.jobs where id = p_job_id for update;
  if not found then
    raise exception 'visit not found' using errcode = 'P0002';
  end if;
  if not public.is_company_member(v_job.company) then
    raise exception 'only the crew or an admin can mark a visit done' using errcode = '42501';
  end if;
  if coalesce(v_job.job_type, '') not in ('Cleaning', 'Inspection') or v_job.stage is distinct from 'Service Call' then
    raise exception 'only an open service visit can be marked done' using errcode = '22023';
  end if;

  update public.jobs
     set stage = 'Complete', status = 'completed', completed_on = v_today, updated_at = now()
   where id = p_job_id;
  update public.leads
     set status = 'visit_done'
   where converted_job_id = p_job_id and status = 'scheduled';
end;
$$;

revoke all on function public.next_service_job_number(text) from public, anon, authenticated;
revoke all on function public.book_service_visit(uuid, text, date, time, text) from public, anon;
revoke all on function public.reschedule_service_visit(uuid, date, time) from public, anon;
revoke all on function public.cancel_service_visit(uuid, text) from public, anon;
revoke all on function public.mark_service_visit_done(uuid) from public, anon;
grant execute on function public.book_service_visit(uuid, text, date, time, text) to authenticated;
grant execute on function public.reschedule_service_visit(uuid, date, time) to authenticated;
grant execute on function public.cancel_service_visit(uuid, text) to authenticated;
grant execute on function public.mark_service_visit_done(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. A sales rep reads their own service visits
-- ---------------------------------------------------------------------------
drop policy if exists jobs_sales_service_select on public.jobs;
create policy jobs_sales_service_select on public.jobs
  for select using (
    public.is_company_sales(company)
    and sales_rep_email is not null
    and lower(sales_rep_email) = lower(public.jwt_email())
    and job_type in ('Cleaning', 'Inspection')
  );

drop policy if exists jsd_sales_select on public.job_schedule_dates;
create policy jsd_sales_select on public.job_schedule_dates
  for select using (
    public.is_company_sales(company)
    and exists (select 1 from public.jobs j where j.id = job_schedule_dates.job_id)
  );

commit;

-- Verify (rolled back): book as a probe sales employee, see it as crew on the
-- schedule, reschedule as the rep (another rep refused), mark done as crew
-- (sales refused), cancel a second booking (job + customer gone, lead back to
-- interested), duplicate flag on a matching phone, refusals for missing
-- fields / past dates / someone else's lead; crew and admin per-table counts
-- unchanged. Numbers in the 2026-10-05 HANDOFF entry.
