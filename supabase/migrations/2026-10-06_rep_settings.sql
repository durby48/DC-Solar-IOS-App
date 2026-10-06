-- Sales rep settings (2026-10-06): Plans & prices text, Do not disturb,
-- notification switches, personal saved texts, and a push when a prospect is
-- assigned to someone.
--
-- 1. service_plans.includes — "what's included", one item per line, written
--    by admins (CRM Settings → Service plans), shown to reps on Plans & prices.
-- 2. staff_profiles — each person's own row (sp_self_* policies already let a
--    rep write it):
--      dnd_enabled, work_start, work_end   Do not disturb: outside these hours
--        (America/Chicago) a call to their DC Solar number does not ring; the
--        caller gets a text back and it is logged as missed (twilio-voice-inbound).
--      notify_texts, notify_missed_calls, notify_new_prospects   push switches,
--        honoured by `notify` for pushes addressed to that person.
-- 3. message_templates.owner_email — a rep's PERSONAL saved texts. Company
--    texts (owner_email null) stay admin-written and readable by all staff; a
--    personal one is readable and writable only by its owner (and admins).
-- 4. leads_assigned_notify_trg — a push to whoever a lead is assigned to (a new
--    lead, or a reassignment), unless they assigned it to themselves.
--
-- Idempotent: safe to re-run.

begin;

-- 1 -------------------------------------------------------------------------
alter table public.service_plans add column if not exists includes text;

-- 2 -------------------------------------------------------------------------
alter table public.staff_profiles
  add column if not exists dnd_enabled          boolean not null default false,
  add column if not exists work_start           time    not null default time '08:00',
  add column if not exists work_end             time    not null default time '19:00',
  add column if not exists notify_texts         boolean not null default true,
  add column if not exists notify_missed_calls  boolean not null default true,
  add column if not exists notify_new_prospects boolean not null default true;

-- 3 -------------------------------------------------------------------------
alter table public.message_templates add column if not exists owner_email text;
comment on column public.message_templates.owner_email is
  'Null = a company saved text (admins write it). Set = that person''s own saved text.';

drop policy if exists mt_member_select on public.message_templates;
create policy mt_member_select on public.message_templates for select
  using (
    public.is_company_member(company)
    and (owner_email is null or lower(owner_email) = lower(public.jwt_email()) or public.is_company_admin(company))
  );
drop policy if exists mt_sales_select on public.message_templates;
create policy mt_sales_select on public.message_templates for select
  using (
    public.is_company_sales(company)
    and (owner_email is null or lower(owner_email) = lower(public.jwt_email()))
  );
drop policy if exists mt_own_insert on public.message_templates;
create policy mt_own_insert on public.message_templates for insert
  with check (public.is_company_staff(company) and lower(owner_email) = lower(public.jwt_email()));
drop policy if exists mt_own_update on public.message_templates;
create policy mt_own_update on public.message_templates for update
  using (public.is_company_staff(company) and lower(owner_email) = lower(public.jwt_email()))
  with check (public.is_company_staff(company) and lower(owner_email) = lower(public.jwt_email()));
drop policy if exists mt_own_delete on public.message_templates;
create policy mt_own_delete on public.message_templates for delete
  using (public.is_company_staff(company) and lower(owner_email) = lower(public.jwt_email()));

-- 4 -------------------------------------------------------------------------
drop trigger if exists leads_assigned_notify_ins on public.leads;
create trigger leads_assigned_notify_ins
  after insert on public.leads
  for each row
  when (new.assigned_to is not null and new.source_ref is null
        and lower(new.assigned_to) is distinct from lower(coalesce(public.jwt_email(), '')))
  execute function public.notify_webhook();

drop trigger if exists leads_assigned_notify_upd on public.leads;
create trigger leads_assigned_notify_upd
  after update of assigned_to on public.leads
  for each row
  when (new.assigned_to is not null
        and lower(new.assigned_to) is distinct from lower(coalesce(old.assigned_to, ''))
        and lower(new.assigned_to) is distinct from lower(coalesce(public.jwt_email(), '')))
  execute function public.notify_webhook();

commit;
