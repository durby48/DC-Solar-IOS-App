-- Migration 17: database → push-notification triggers (via pg_net).
-- Applied via the Supabase Management API on 2026-07-31 with the real
-- NOTIFY_SECRET substituted; the value here is a placeholder because this
-- repo is public. Re-runnable.
--
-- (a) job_assignments INSERT → notify function → 🔧 push to the assigned
--     member ("You've been assigned to DC-26014 — R&R (…address…)").
-- (b) finance_entries INSERT → notify function → 💰 push to admins for
--     type='payment' rows (the function ignores everything else). This
--     completes NOTIFICATIONS_SETUP.md step 5 without the dashboard.

create extension if not exists pg_net;

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
      'type', 'INSERT',
      'table', TG_TABLE_NAME,
      'record', to_jsonb(new)
    )
  );
  return new;
end;
$$;

drop trigger if exists job_assignments_notify_trg on public.job_assignments;
create trigger job_assignments_notify_trg
  after insert on public.job_assignments
  for each row
  execute function public.notify_webhook();

drop trigger if exists finance_entries_notify_trg on public.finance_entries;
create trigger finance_entries_notify_trg
  after insert on public.finance_entries
  for each row
  execute function public.notify_webhook();
