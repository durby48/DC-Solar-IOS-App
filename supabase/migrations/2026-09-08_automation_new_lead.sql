-- CRM Phase 10, automation #1 and #2 (2026-09-08): when a lead arrives
-- AUTOMATICALLY (leads.source_ref set — today that means the website quote
-- form via intake_lead), do two small things nobody should have to remember:
--
--   1. create ONE follow-up task on the lead: "Contact new website lead · <name>"
--   2. push ONE notification to the admins' phones (the existing `notify`
--      function, through the existing `notify_webhook()` pg_net trigger)
--
-- NOT a workflow engine. Two triggers calling things that already exist.
-- Typed-in leads (`+ Lead`, source_ref NULL) are untouched: the person
-- entering them is already looking at them.
--
-- IDEMPOTENT. `tasks.source_ref` + a unique partial index means the same
-- lead can never get two automatic tasks (ON CONFLICT DO NOTHING); the push
-- is a per-insert trigger, and intake_lead's own source_ref idempotency
-- already stops the lead from being inserted twice.
--
-- NEVER BLOCKS THE LEAD. The task trigger swallows its own errors with a
-- WARNING (visible in Postgres logs); the notify trigger is async pg_net.
-- Whatever breaks downstream, the lead row is already committed.
--
-- DUE TIME (the one business constant here): 5 PM Central the day the lead
-- arrives, or the next day at noon when it arrives after 5 PM. The website
-- promises "a reply within 1–2 business days"; a same-day task is inside
-- that. Change DUE_HOUR_LOCAL below if Devon wants a different window.
--
-- Idempotent migration: safe to re-run.

begin;

alter table public.tasks
  add column if not exists source_ref text;

comment on column public.tasks.source_ref is
  'Set only on tasks created by automation, e.g. auto:new_lead:<lead_id>. '
  'Unique per company: the same event can never create the task twice.';

create unique index if not exists tasks_source_ref_uq
  on public.tasks (company, source_ref) where source_ref is not null;

create or replace function public.leads_automation_new_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  DUE_HOUR_LOCAL constant int := 17;          -- 5 PM America/Chicago
  v_local  timestamp;
  v_due    timestamptz;
  v_who    text;
begin
  if new.source_ref is null then
    return new;
  end if;
  begin
    v_local := now() at time zone 'America/Chicago';
    if extract(hour from v_local) < DUE_HOUR_LOCAL then
      v_due := (date_trunc('day', v_local) + make_interval(hours => DUE_HOUR_LOCAL)) at time zone 'America/Chicago';
    else
      v_due := (date_trunc('day', v_local) + interval '1 day' + interval '12 hours') at time zone 'America/Chicago';
    end if;
    v_who := coalesce(nullif(new.phone, ''), nullif(new.email, ''), 'no phone or email on file');

    insert into public.tasks (company, title, notes, due_at, assigned_to, lead_id, created_by, source_ref)
    values (
      coalesce(new.company, 'dc-solar'),
      format('Contact new %s lead · %s', lower(coalesce(new.source, 'website')), left(new.name, 80)),
      format('Reach out to %s (%s). Created automatically when the lead arrived.', new.name, v_who),
      v_due,
      new.assigned_to,           -- NULL today: website leads are unassigned by design
      new.id,
      'automation',
      'auto:new_lead:' || new.id::text
    )
    on conflict (company, source_ref) where source_ref is not null do nothing;
  exception when others then
    raise warning 'leads_automation_new_lead: % (lead %)', sqlerrm, new.id;
  end;
  return new;
end;
$$;

revoke all on function public.leads_automation_new_lead() from public, anon, authenticated;

drop trigger if exists leads_automation_new_lead_trg on public.leads;
create trigger leads_automation_new_lead_trg
  after insert on public.leads
  for each row execute function public.leads_automation_new_lead();

-- The push: same trigger function finance/assignments/schedule already use.
-- `notify` (edge function) decides the wording for table = 'leads'.
drop trigger if exists leads_notify_trg on public.leads;
create trigger leads_notify_trg
  after insert on public.leads
  for each row
  when (new.source_ref is not null)
  execute function public.notify_webhook();

commit;
