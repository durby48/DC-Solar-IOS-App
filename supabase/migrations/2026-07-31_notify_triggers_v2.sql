-- Migration 18: extend push triggers — unassignment + schedule changes.
-- Applied via the Supabase Management API on 2026-07-31 with the real
-- NOTIFY_SECRET substituted (placeholder here; public repo). Re-runnable.
--
-- notify_webhook() now reports the operation (INSERT/UPDATE/DELETE) with
-- record + old_record, and fires on:
--   job_assignments  INSERT (assigned 🔧) + DELETE (removed 🔧)
--   job_schedule_dates INSERT/UPDATE/DELETE (📅 to the job's assigned crew;
--     the function skips updates where date+time didn't change)
--   finance_entries INSERT (💰 payments to admins — unchanged)

create or replace function public.notify_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://kjamxfezsathrsbztiln.supabase.co/functions/v1/notify',
    headers := '{"Content-Type": "application/json", "x-notify-secret": "<NOTIFY_SECRET>"}'::jsonb,
    body := jsonb_build_object(
      'type', TG_OP,
      'table', TG_TABLE_NAME,
      'record', case when TG_OP = 'DELETE' then to_jsonb(old) else to_jsonb(new) end,
      'old_record', case when TG_OP = 'UPDATE' then to_jsonb(old) else null end
    )
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists job_assignments_notify_trg on public.job_assignments;
create trigger job_assignments_notify_trg
  after insert or delete on public.job_assignments
  for each row
  execute function public.notify_webhook();

drop trigger if exists job_schedule_dates_notify_trg on public.job_schedule_dates;
create trigger job_schedule_dates_notify_trg
  after insert or update or delete on public.job_schedule_dates
  for each row
  execute function public.notify_webhook();
