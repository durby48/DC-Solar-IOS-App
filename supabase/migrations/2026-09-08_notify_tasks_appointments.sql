-- Push notifications for "handed to me" events (2026-09-08).
--
-- Two more tables feed the existing `notify_webhook()` (pg_net → edge
-- function `notify`, which decides wording and recipients):
--
--   tasks              INSERT with an assignee, or UPDATE that changes it
--   lead_appointments  same
--
-- The function pushes to the ASSIGNEE only, skips self-assignment, and puts
-- a notification target in `data` so a tap opens the lead/customer the task
-- or appointment belongs to. WHEN clauses keep every other write off the
-- wire (a ticked task, an edited note). Insert and update are separate
-- triggers because an INSERT trigger's WHEN may not reference OLD.
--
-- Idempotent: safe to re-run.

begin;

drop trigger if exists tasks_notify_trg on public.tasks;
drop trigger if exists tasks_notify_insert_trg on public.tasks;
create trigger tasks_notify_insert_trg
  after insert on public.tasks
  for each row
  when (new.assigned_to is not null)
  execute function public.notify_webhook();

drop trigger if exists tasks_notify_update_trg on public.tasks;
create trigger tasks_notify_update_trg
  after update of assigned_to on public.tasks
  for each row
  when (new.assigned_to is not null and new.assigned_to is distinct from old.assigned_to)
  execute function public.notify_webhook();

drop trigger if exists lead_appointments_notify_trg on public.lead_appointments;
drop trigger if exists lead_appointments_notify_insert_trg on public.lead_appointments;
create trigger lead_appointments_notify_insert_trg
  after insert on public.lead_appointments
  for each row
  when (new.assigned_to is not null)
  execute function public.notify_webhook();

drop trigger if exists lead_appointments_notify_update_trg on public.lead_appointments;
create trigger lead_appointments_notify_update_trg
  after update of assigned_to on public.lead_appointments
  for each row
  when (new.assigned_to is not null and new.assigned_to is distinct from old.assigned_to)
  execute function public.notify_webhook();

commit;
