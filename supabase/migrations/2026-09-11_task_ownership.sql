-- Tasks / lead appointments: ownership columns are not the assignee's to
-- change, updates carry who made them, and intake failures make noise
-- (2026-09-11 review of the 2026-09-07/08 CRM migrations).
--
-- 1. OWNERSHIP GUARD. `tasks_update` / `la_update` let the ASSIGNEE update a
--    row (correct: they tick it done, postpone it). But WITH CHECK only asks
--    that one of admin / assignee / creator still holds on the NEW row, so an
--    assignee could `set created_by = me` — still passing as assignee — and
--    then satisfy the delete policy (`created_by = me`) and delete someone
--    else's task, or repoint an appointment's `lead_id` at any lead (FK checks
--    bypass RLS). RLS cannot compare NEW to OLD; a BEFORE UPDATE trigger can.
--    Non-admins may not change created_by, company, or the record links.
--
-- 2. `updated_by`. The `notify` edge function skips "✅ Task for you" when the
--    creator assigns a task to themselves on INSERT, but an UPDATE that goes
--    NULL → me also pushed me, because the row did not say who updated it.
--    Stamped from the JWT on every update (NULL for the service role).
--
-- 3. `quote_requests_intake()` recorded a failure on a row nobody can read
--    (`quote_requests` has no read policy) and said nothing else, so a
--    persistent intake error would zero the CRM's lead flow silently while
--    the website kept reporting success. Now it RAISEs a WARNING too, which
--    lands in the Postgres logs.
--
-- Idempotent; RLS policies untouched.

begin;

-- ---------------------------------------------------------------------------
-- 2. updated_by
-- ---------------------------------------------------------------------------
alter table public.tasks             add column if not exists updated_by text;
alter table public.lead_appointments add column if not exists updated_by text;

comment on column public.tasks.updated_by is
  'Email of the person who last updated the row (JWT), NULL when the service role did.';
comment on column public.lead_appointments.updated_by is
  'Email of the person who last updated the row (JWT), NULL when the service role did.';

-- ---------------------------------------------------------------------------
-- 1. Guard + stamp, one BEFORE UPDATE trigger per table
-- ---------------------------------------------------------------------------
create or replace function public.tasks_guard_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_by := public.jwt_email();
  if not public.is_company_admin(new.company) then
    if new.created_by  is distinct from old.created_by
       or new.company  is distinct from old.company
       or new.customer_id is distinct from old.customer_id
       or new.lead_id  is distinct from old.lead_id
       or new.job_id   is distinct from old.job_id then
      raise exception 'only an admin may change who a task belongs to'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.tasks_guard_update() from public, anon, authenticated;

drop trigger if exists tasks_guard_update_trg on public.tasks;
create trigger tasks_guard_update_trg
  before update on public.tasks
  for each row execute function public.tasks_guard_update();

create or replace function public.lead_appointments_guard_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_by := public.jwt_email();
  if not public.is_company_admin(new.company) then
    if new.created_by is distinct from old.created_by
       or new.company is distinct from old.company
       or new.lead_id  is distinct from old.lead_id then
      raise exception 'only an admin may change who an appointment belongs to'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.lead_appointments_guard_update() from public, anon, authenticated;

drop trigger if exists lead_appointments_guard_update_trg on public.lead_appointments;
create trigger lead_appointments_guard_update_trg
  before update on public.lead_appointments
  for each row execute function public.lead_appointments_guard_update();

-- ---------------------------------------------------------------------------
-- 3. Intake failures are loud
-- ---------------------------------------------------------------------------
create or replace function public.quote_requests_intake()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  begin
    select * into r from public.intake_lead(
      'website',
      'website_quote:' || new.id::text,
      new.name, new.phone, new.email, new.address,
      new.message, new.service_type, new.property_type, new.is_insurance_claim,
      new.created_at,
      case when new.sms_consent then new.sms_consent_at else null end,
      case when new.sms_consent then new.sms_consent_source else null end,
      case when new.sms_consent then new.sms_consent_version else null end
    );
    update public.quote_requests
       set lead_id = r.lead_id, intake_outcome = r.outcome, intake_at = now()
     where id = new.id;
  exception when others then
    -- The visitor's request must never fail because the CRM hiccupped —
    -- but somebody has to hear about it.
    raise warning 'lead intake failed for quote_requests.% : % (%)', new.id, sqlerrm, sqlstate;
    update public.quote_requests
       set intake_outcome = 'error: ' || left(sqlerrm, 200), intake_at = now()
     where id = new.id;
  end;
  return new;
end;
$$;

commit;

-- Verify (rolled back, both directions):
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"email":"devonsd311@gmail.com","role":"authenticated"}';
--   insert into public.tasks (title, created_by, assigned_to) values ('t', 'devonsd311@gmail.com', 'test-crew@dcsolarkc.com') returning id;
--   set local request.jwt.claims = '{"email":"test-crew@dcsolarkc.com","role":"authenticated"}';
--   update public.tasks set done_at = now() where title = 't';                 -- ok, updated_by = test-crew
--   update public.tasks set created_by = 'test-crew@dcsolarkc.com' where title = 't'; -- 42501
--   rollback;
