-- Sales role: a fourth employee role whose CRM is only their own prospects,
-- leads and customers (2026-10-05).
--
-- WHO. New hires who only sell solar service (cleanings, inspections, the
-- annual service plan). An admin assigns them prospects; they call, work the
-- lead and, later, book the visit. They see ONLY the CRM, and in it only what
-- is theirs. No jobs, no money (not even estimates), no photos, no schedule,
-- no company directory.
--
-- THE SHAPE OF THE PROBLEM. 45 RLS policies grant access to "any staff
-- member" through is_company_member(), and two older website policies
-- ("customers company read", "jobs company read") grant every employee every
-- customer and every job. A sales login is an employee, so without care it
-- would inherit all of it — the same failure mode as the 2026-08-06
-- finance_entries leak, where one broad permissive policy defeated the narrow
-- ones (Postgres ORs permissive policies together).
--
-- THE DESIGN: DENY BY DEFAULT.
--   1. is_company_member() now means "staff, EXCEPT sales". Nobody holds the
--      sales role when this runs, so it changes nothing for any existing
--      account — and every existing policy, plus every one written later that
--      reaches for is_company_member(), leaves sales out unless someone opts
--      them in on purpose.
--   2. is_company_staff() is the old meaning (any employee, sales included).
--      It replaces is_company_member() ONLY in the own-row policies a sales
--      rep needs: their leads, tasks, lead appointments, notes they wrote,
--      their staff profile (voice identity), crash diagnostics.
--   3. Explicit sales policies: insert leads assigned to themselves; read the
--      customers that are theirs; read/add notes on those customers.
--      "Theirs" = they sold one of the customer's jobs (jobs.sales_rep_email)
--      OR the customer came from a lead assigned to them (leads.converted_job_id).
--   4. The two older website policies exclude sales.
--   5. A guard trigger on leads: only an admin may change who a lead belongs
--      to or which job it became. Without it a rep could point their own
--      lead's converted_job_id at ANY job and, through rule 3, read that
--      job's customer. (Lead conversion is already admin-only in practice —
--      it creates a customer and a job, which only admins can insert.)
--   6. 'sales' is a valid employees.role; 'interested' a valid leads.status
--      (between contacted and the admin-side 'estimating').
--
-- Untouched on purpose: finance_entries.fin_sales_rep_select still reads
-- through is_company_member(), so a sales login gets NO estimate/contract
-- rows (Carson: "no to estimate"); admins and viewer-reps keep theirs.
-- comms_settings / message_templates (calling + texting) stay staff-only until
-- the in-app calling step opens them deliberately.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. The role and the status
-- ---------------------------------------------------------------------------
alter table public.employees drop constraint if exists employees_role_check;
alter table public.employees
  add constraint employees_role_check
  check (role in ('owner', 'operator', 'viewer', 'sales'));

alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads
  add constraint leads_status_check
  check (status in ('new', 'contacted', 'interested', 'estimating', 'won', 'lost'));

-- ---------------------------------------------------------------------------
-- 2. Membership helpers
-- ---------------------------------------------------------------------------
-- Staff, except sales. Same signature, same security definer shape as before,
-- so every policy and function that calls it keeps working unchanged.
create or replace function public.is_company_member(comp text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from employees e
    where e.email = (auth.jwt() ->> 'email') and e.company = comp
      and e.role <> 'sales'
  );
$$;

-- Any employee of the company, sales included (the old is_company_member).
create or replace function public.is_company_staff(comp text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from employees e
    where e.email = (auth.jwt() ->> 'email') and e.company = comp
  );
$$;

create or replace function public.is_company_sales(comp text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from employees e
    where e.email = (auth.jwt() ->> 'email') and e.company = comp
      and e.role = 'sales'
  );
$$;

-- Is this customer the caller's? They sold one of its jobs, or it came from a
-- lead assigned to them. Security definer so the check can look at jobs and
-- leads the caller cannot read themselves.
create or replace function public.is_sales_rep_for_customer(cust uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from jobs j
    where j.customer_id = cust
      and j.sales_rep_email is not null
      and lower(j.sales_rep_email) = lower(auth.jwt() ->> 'email')
  ) or exists (
    select 1 from leads l
    join jobs j on j.id = l.converted_job_id
    where j.customer_id = cust
      and l.assigned_to is not null
      and lower(l.assigned_to) = lower(auth.jwt() ->> 'email')
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Own-row policies a sales rep needs: member -> staff
-- ---------------------------------------------------------------------------
-- Leads: reps read and work only the leads assigned to them.
drop policy if exists leads_own_select on public.leads;
create policy leads_own_select on public.leads for select
  using (
    public.is_company_staff(company)
    and assigned_to is not null
    and lower(assigned_to) = lower(public.jwt_email())
  );

drop policy if exists leads_own_update on public.leads;
create policy leads_own_update on public.leads for update
  using (
    public.is_company_staff(company)
    and assigned_to is not null
    and lower(assigned_to) = lower(public.jwt_email())
  )
  with check (
    public.is_company_staff(company)
    and assigned_to is not null
    and lower(assigned_to) = lower(public.jwt_email())
  );

-- Tasks: same rules as 2026-09-07_tasks.sql, staff instead of member.
drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks
  for select using (
    public.is_company_staff(company)
    and (
      public.is_company_admin(company)
      or lower(assigned_to) = lower(public.jwt_email())
      or lower(created_by)  = lower(public.jwt_email())
    )
  );

drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks
  for insert with check (
    public.is_company_staff(company)
    and lower(created_by) = lower(public.jwt_email())
  );

drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks
  for update using (
    public.is_company_staff(company)
    and (
      public.is_company_admin(company)
      or lower(assigned_to) = lower(public.jwt_email())
      or lower(created_by)  = lower(public.jwt_email())
    )
  ) with check (
    public.is_company_staff(company)
    and (
      public.is_company_admin(company)
      or lower(assigned_to) = lower(public.jwt_email())
      or lower(created_by)  = lower(public.jwt_email())
    )
  );

drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks
  for delete using (
    public.is_company_staff(company)
    and (public.is_company_admin(company) or lower(created_by) = lower(public.jwt_email()))
  );

-- Lead appointments: same rules as 2026-09-07_lead_appointments.sql. The
-- EXISTS on leads runs under the caller's own leads RLS, so a rep only
-- reaches appointments on leads they can see.
drop policy if exists la_select on public.lead_appointments;
create policy la_select on public.lead_appointments
  for select using (
    exists (select 1 from public.leads l where l.id = lead_appointments.lead_id)
    or (public.is_company_staff(company) and lower(assigned_to) = lower(public.jwt_email()))
  );

drop policy if exists la_insert on public.lead_appointments;
create policy la_insert on public.lead_appointments
  for insert with check (
    public.is_company_staff(company)
    and lower(created_by) = lower(public.jwt_email())
    and exists (select 1 from public.leads l where l.id = lead_appointments.lead_id)
  );

drop policy if exists la_update on public.lead_appointments;
create policy la_update on public.lead_appointments
  for update using (
    exists (select 1 from public.leads l where l.id = lead_appointments.lead_id)
    or (public.is_company_staff(company) and lower(assigned_to) = lower(public.jwt_email()))
  ) with check (
    exists (select 1 from public.leads l where l.id = lead_appointments.lead_id)
    or (public.is_company_staff(company) and lower(assigned_to) = lower(public.jwt_email()))
  );

-- Customer notes: an author edits their own note (reading is separate, below).
drop policy if exists cn_author_update on public.customer_notes;
create policy cn_author_update on public.customer_notes
  for update using (
    public.is_company_staff(company)
    and lower(author_email) = lower(public.jwt_email())
  ) with check (
    public.is_company_staff(company)
    and lower(author_email) = lower(public.jwt_email())
  );

-- Staff profile (voice identity, cell for call bridging): your own row only.
drop policy if exists sp_self_insert on public.staff_profiles;
create policy sp_self_insert on public.staff_profiles
  for insert with check (
    public.is_company_staff(company)
    and lower(email) = lower(public.jwt_email())
  );

drop policy if exists sp_self_update on public.staff_profiles;
create policy sp_self_update on public.staff_profiles
  for update using (lower(email) = lower(public.jwt_email()))
  with check (
    public.is_company_staff(company)
    and lower(email) = lower(public.jwt_email())
  );

-- Crash / event diagnostics: every staff device reports its own.
drop policy if exists cd_member_insert on public.client_diagnostics;
create policy cd_member_insert on public.client_diagnostics
  for insert with check (
    public.is_company_staff(company)
    and lower(email) = lower(public.jwt_email())
  );

-- ---------------------------------------------------------------------------
-- 4. Sales-only policies
-- ---------------------------------------------------------------------------
-- Add a prospect: always assigned to yourself (an admin can reassign).
drop policy if exists leads_sales_insert on public.leads;
create policy leads_sales_insert on public.leads
  for insert with check (
    public.is_company_sales(company)
    and assigned_to is not null
    and lower(assigned_to) = lower(public.jwt_email())
    and lower(coalesce(created_by, '')) = lower(public.jwt_email())
  );

drop policy if exists customers_sales_select on public.customers;
create policy customers_sales_select on public.customers
  for select using (
    public.is_company_sales(company)
    and public.is_sales_rep_for_customer(id)
  );

drop policy if exists cn_sales_select on public.customer_notes;
create policy cn_sales_select on public.customer_notes
  for select using (
    public.is_company_sales(company)
    and public.is_sales_rep_for_customer(customer_id)
  );

drop policy if exists cn_sales_insert on public.customer_notes;
create policy cn_sales_insert on public.customer_notes
  for insert with check (
    public.is_company_sales(company)
    and author_email is not null
    and lower(author_email) = lower(public.jwt_email())
    and public.is_sales_rep_for_customer(customer_id)
  );

-- ---------------------------------------------------------------------------
-- 5. The two older website policies: every employee EXCEPT sales
-- ---------------------------------------------------------------------------
alter policy "customers company read" on public.customers
  using (company = (
    select employees.company from employees
    where employees.email = (auth.jwt() ->> 'email') and employees.role <> 'sales'
  ));

alter policy "jobs company read" on public.jobs
  using (company = (
    select employees.company from employees
    where employees.email = (auth.jwt() ->> 'email') and employees.role <> 'sales'
  ));

-- ---------------------------------------------------------------------------
-- 6. Only an admin decides who a lead belongs to and which job it became
-- ---------------------------------------------------------------------------
-- Skipped when there is no signed-in user (service role: website intake,
-- edge functions, migrations), exactly like those paths are trusted today.
create or replace function public.leads_guard_ownership()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.jwt_email() is null or public.is_company_admin(new.company) then
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

drop trigger if exists leads_guard_ownership on public.leads;
create trigger leads_guard_ownership
  before insert or update on public.leads
  for each row execute function public.leads_guard_ownership();

commit;

-- Verify (rolled back): impersonate a sales employee, a viewer and an admin
-- and compare per-table counts with the same probe run BEFORE this migration
-- (crew and admin must be identical; sales sees only its own leads and linked
-- customers, zero jobs / finance / photos / contacts / schedule). See the
-- 2026-10-05 HANDOFF entry for the numbers.
