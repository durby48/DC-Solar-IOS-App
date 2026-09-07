-- CRM Phase 6 (2026-09-07): pre-sale appointments for leads.
--
-- A site visit, a consultation, a call — the meeting that happens BEFORE a
-- lead becomes a customer with a job. `job_schedule_dates` cannot hold it:
-- that table is keyed by job (job_id NOT NULL, unique per day) and every
-- calendar reader joins it to `jobs`. Relaxing that would touch the Calendar,
-- Home, notifications and pipeline readers at once. A sibling table costs
-- one extra read where a screen wants both.
--
-- Fields mirror job_schedule_dates where they overlap (a date, an optional
-- start time, a note) and add what a pre-sale meeting has that a work day
-- does not: `kind`, who is going (`assigned_to`, an employee email), and
-- `outcome` once it has happened.
--
-- RLS mirrors `leads` (2026-08-07_sales.sql): admins do everything; a rep
-- sees and manages appointments for the leads assigned to them (the EXISTS
-- runs under leads RLS, so `leads_own_select` decides), plus any appointment
-- they are personally sent to. Nothing wider than leads already grants.
--
-- Idempotent: safe to re-run.

begin;

create table if not exists public.lead_appointments (
  id          uuid primary key default gen_random_uuid(),
  company     text not null default 'dc-solar',
  lead_id     uuid not null references public.leads(id) on delete cascade,
  kind        text not null default 'site_visit'
              check (kind in ('site_visit', 'consultation', 'call', 'follow_up')),
  appt_date   date not null,
  start_time  time,                              -- null = time TBD
  duration_minutes integer check (duration_minutes is null or duration_minutes > 0),
  assigned_to text,
  note        text,
  outcome     text check (outcome is null or outcome in ('completed', 'no_show', 'rescheduled', 'canceled')),
  created_by  text not null default public.jwt_email(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists lead_appointments_date_idx on public.lead_appointments (company, appt_date);
create index if not exists lead_appointments_lead_idx on public.lead_appointments (lead_id, appt_date);

comment on table public.lead_appointments is
  'Pre-sale appointments (site visit / consultation / call / follow-up) for '
  'leads. Sibling of job_schedule_dates, which is per job. See '
  '2026-09-07_lead_appointments.sql.';

drop trigger if exists lead_appointments_touch on public.lead_appointments;
create trigger lead_appointments_touch
  before update on public.lead_appointments
  for each row execute function public.crm_touch_updated_at();

alter table public.lead_appointments enable row level security;

drop policy if exists la_select on public.lead_appointments;
create policy la_select on public.lead_appointments
  for select using (
    exists (select 1 from public.leads l where l.id = lead_appointments.lead_id)
    or (public.is_company_member(company) and lower(assigned_to) = lower(public.jwt_email()))
  );

drop policy if exists la_insert on public.lead_appointments;
create policy la_insert on public.lead_appointments
  for insert with check (
    public.is_company_member(company)
    and lower(created_by) = lower(public.jwt_email())
    and exists (select 1 from public.leads l where l.id = lead_appointments.lead_id)
  );

drop policy if exists la_update on public.lead_appointments;
create policy la_update on public.lead_appointments
  for update using (
    exists (select 1 from public.leads l where l.id = lead_appointments.lead_id)
    or (public.is_company_member(company) and lower(assigned_to) = lower(public.jwt_email()))
  ) with check (
    exists (select 1 from public.leads l where l.id = lead_appointments.lead_id)
    or (public.is_company_member(company) and lower(assigned_to) = lower(public.jwt_email()))
  );

drop policy if exists la_delete on public.lead_appointments;
create policy la_delete on public.lead_appointments
  for delete using (
    public.is_company_admin(company)
    or lower(created_by) = lower(public.jwt_email())
  );

commit;

-- Verify (rolled back, both directions):
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"email":"test-crew@dcsolarkc.com","role":"authenticated"}';
--   insert into public.lead_appointments (lead_id, appt_date, created_by)
--     values ((select id from public.leads limit 1), current_date, 'test-crew@dcsolarkc.com');  -- denied: not their lead
--   select count(*) from public.lead_appointments;                                               -- 0
--   set local request.jwt.claims = '{"email":"devonsd311@gmail.com","role":"authenticated"}';
--   insert ... created_by 'devonsd311@gmail.com', assigned_to 'test-crew@dcsolarkc.com';         -- ok
--   set local request.jwt.claims = '{"email":"test-crew@dcsolarkc.com","role":"authenticated"}';
--   select count(*) from public.lead_appointments;                                               -- 1 (sent to them)
--   rollback;
