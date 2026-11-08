-- Notifications overhaul (2026-11-08, Devon).
--
-- 1. `notifications` — every push the `notify` edge function sends is also
--    kept here, one row per recipient: the in-app Alerts list and the unread
--    badge read it. RLS: a person sees and marks ONLY their own rows. There
--    is deliberately NO "admins read all" policy — permissive policies OR
--    together (the finance_entries leak).
--    `dedupe_key` + a unique index make the table its own "already sent"
--    ledger: reminders insert first and push only what was new.
-- 2. `register_push_token(token, platform)` — moves a device to whoever is
--    signed in on it. The old client upsert could not (the UPDATE policy is
--    "your own email" and the existing row was the previous person's), so a
--    shared phone kept getting the previous person's pushes.
-- 3. Mute switches: staff_profiles.notify_tasks / notify_schedule.
-- 4. `notify_webhook()` reads its secret from Vault (`notify_secret`), sends
--    the transaction id (multi-day schedule batching), and stays QUIET while
--    `app.silent_notify = 'on'` (data-fix migrations: `set local
--    app.silent_notify = 'on';`). `notify_post(body)` is the same call for
--    cron jobs.
-- 5. New push triggers:
--      lead_appointments  moved (date/time), canceled (outcome), deleted
--      messages           an outbound text failed / undelivered → its sender
--      customers          card saved; a payment problem
--      jobs               a service visit paid
-- 6. Cron: `notify-reminders` (task due, appointment 24 h / 1 h) and
--    `crm-email-watch` (customer / lead email replies), every 5 minutes.
--
-- Vault secret `notify_secret` must exist (created outside the repo with the
-- same value as the edge functions' NOTIFY_SECRET).
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. notifications
-- ---------------------------------------------------------------------------

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  company text not null default 'dc-solar',
  recipient_email text not null check (recipient_email = lower(recipient_email)),
  title text not null,
  body text not null default '',
  target jsonb,
  source text,
  dedupe_key text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create unique index if not exists notifications_dedupe_uq
  on public.notifications (recipient_email, dedupe_key);
create index if not exists notifications_inbox_idx
  on public.notifications (company, recipient_email, created_at desc);
create index if not exists notifications_unread_idx
  on public.notifications (recipient_email) where read_at is null;

alter table public.notifications enable row level security;

drop policy if exists notif_own_select on public.notifications;
create policy notif_own_select on public.notifications
  for select to authenticated
  using (recipient_email = lower(public.jwt_email()) and public.is_company_staff(company));

drop policy if exists notif_own_update on public.notifications;
create policy notif_own_update on public.notifications
  for update to authenticated
  using (recipient_email = lower(public.jwt_email()))
  with check (recipient_email = lower(public.jwt_email()));

revoke all on public.notifications from anon;
revoke insert, delete, update, truncate on public.notifications from authenticated;
grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

-- Live badge / list.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- Mark read: the given ids, or (null) everything of mine.
create or replace function public.mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  n integer;
begin
  update public.notifications
     set read_at = now()
   where recipient_email = lower(public.jwt_email())
     and read_at is null
     and (p_ids is null or id = any(p_ids));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

-- Retention: keep 90 days.
create or replace function public.prune_notifications()
returns void
language sql
security definer
set search_path = public
as $$ delete from public.notifications where created_at < now() - interval '90 days' $$;
revoke all on function public.prune_notifications() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. register_push_token
-- ---------------------------------------------------------------------------

create or replace function public.register_push_token(p_token text, p_platform text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me text := lower(public.jwt_email());
begin
  if me is null or me = '' then
    raise exception 'not signed in';
  end if;
  if not exists (select 1 from employees e where lower(e.email) = me) then
    raise exception 'staff only';
  end if;
  if p_token is null or length(p_token) > 300 or p_token !~ '^(Expo|Exponent)PushToken\[' then
    raise exception 'bad token';
  end if;
  -- One device, one person: whoever signed in on it last.
  delete from push_tokens where token = p_token and lower(email) <> me;
  insert into push_tokens (company, email, token, platform, updated_at)
  values ('dc-solar', me, p_token, left(coalesce(p_platform, ''), 20), now())
  on conflict (token) do update
    set email = excluded.email, platform = excluded.platform, updated_at = now();
end $$;
revoke all on function public.register_push_token(text, text) from public, anon;
grant execute on function public.register_push_token(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Mute switches
-- ---------------------------------------------------------------------------

alter table public.staff_profiles add column if not exists notify_tasks boolean not null default true;
alter table public.staff_profiles add column if not exists notify_schedule boolean not null default true;

-- ---------------------------------------------------------------------------
-- 4. notify_webhook / notify_post
-- ---------------------------------------------------------------------------

create or replace function public.notify_post(p_body jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('app.silent_notify', true), '') = 'on' then
    return;
  end if;
  perform net.http_post(
    url := 'https://kjamxfezsathrsbztiln.supabase.co/functions/v1/notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-notify-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'notify_secret')
    ),
    body := p_body,
    timeout_milliseconds := 30000
  );
end $$;
revoke all on function public.notify_post(jsonb) from public, anon, authenticated;

create or replace function public.notify_webhook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.notify_post(jsonb_build_object(
    'type', TG_OP,
    'table', TG_TABLE_NAME,
    'record', case when TG_OP = 'DELETE' then to_jsonb(old) else to_jsonb(new) end,
    'old_record', case when TG_OP = 'UPDATE' then to_jsonb(old) else null end,
    'txid', txid_current()::text
  ));
  return coalesce(new, old);
end $$;

-- ---------------------------------------------------------------------------
-- 5. New push triggers
-- ---------------------------------------------------------------------------

-- Appointments: reassigned (as before), moved, canceled — and deleted.
drop trigger if exists lead_appointments_notify_update_trg on public.lead_appointments;
create trigger lead_appointments_notify_update_trg
  after update of assigned_to, appt_date, start_time, outcome on public.lead_appointments
  for each row
  when (
    new.assigned_to is not null and (
      new.assigned_to is distinct from old.assigned_to
      or new.appt_date is distinct from old.appt_date
      or new.start_time is distinct from old.start_time
      or (new.outcome = 'canceled' and old.outcome is distinct from 'canceled')
    )
  )
  execute function public.notify_webhook();

drop trigger if exists lead_appointments_notify_delete_trg on public.lead_appointments;
create trigger lead_appointments_notify_delete_trg
  after delete on public.lead_appointments
  for each row
  when (old.assigned_to is not null and old.appt_date >= current_date)
  execute function public.notify_webhook();

-- An outbound text that failed: tell whoever sent it.
drop trigger if exists messages_failed_notify_trg on public.messages;
create trigger messages_failed_notify_trg
  after update of status on public.messages
  for each row
  when (
    new.direction = 'out' and new.channel = 'sms'
    and new.status in ('failed', 'undelivered')
    and old.status is distinct from new.status
  )
  execute function public.notify_webhook();

-- Stripe, as it lands on the customer: a card saved; a payment problem.
drop trigger if exists customers_billing_notify_trg on public.customers;
create trigger customers_billing_notify_trg
  after update of card_on_file_at, payment_issue on public.customers
  for each row
  when (
    (old.card_on_file_at is null and new.card_on_file_at is not null)
    or (new.payment_issue is not null and new.payment_issue is distinct from old.payment_issue)
  )
  execute function public.notify_webhook();

-- A service visit paid.
drop trigger if exists jobs_paid_notify_trg on public.jobs;
create trigger jobs_paid_notify_trg
  after update of service_paid_at on public.jobs
  for each row
  when (old.service_paid_at is null and new.service_paid_at is not null)
  execute function public.notify_webhook();

-- ---------------------------------------------------------------------------
-- 6. Cron: reminders, CRM email replies, retention
-- ---------------------------------------------------------------------------

create table if not exists public.crm_email_watch (
  mailbox text primary key,
  last_seen_ms bigint not null,
  updated_at timestamptz not null default now()
);
alter table public.crm_email_watch enable row level security;
revoke all on public.crm_email_watch from anon, authenticated;

create or replace function public.crm_email_watch_call()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://kjamxfezsathrsbztiln.supabase.co/functions/v1/crm-email-watch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-notify-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'notify_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
end $$;
revoke all on function public.crm_email_watch_call() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname in ('notify-reminders', 'crm-email-watch', 'prune-notifications');
  perform cron.schedule('notify-reminders', '*/5 * * * *', $c$select public.notify_post('{"action":"reminders"}'::jsonb)$c$);
  perform cron.schedule('crm-email-watch', '*/5 * * * *', $c$select public.crm_email_watch_call()$c$);
  perform cron.schedule('prune-notifications', '17 9 * * *', $c$select public.prune_notifications()$c$);
end $$;

commit;
