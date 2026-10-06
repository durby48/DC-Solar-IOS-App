-- Lead import, the unassigned pool, bulk assign, and "call first" (2026-10-07).
--
-- IMPORT. An admin uploads a spreadsheet in the CRM; the app maps the columns
-- and sends the rows to import_leads(). Each becomes a Prospect (status new)
-- with NOBODY assigned, tagged with the batch's source ("KC solar permits ·
-- Oct 2026") so a batch can be found or undone. Skipped server-side too, not
-- only in the preview: no phone and no email; the same phone/email + address
-- already a lead or customer; the same phone/email + address twice in one
-- upload. A shared phone at a DIFFERENT address is a separate lead (Carson).
--
-- CALL FIRST. Imported people never agreed to texts, so leads.call_first is
-- set and twilio-send-sms refuses to text them. It clears by itself after a
-- connected call (a call row that completed with talk time) or when they text
-- in — messages_unlock_call_first below.
--
-- BULK ASSIGN. assign_leads() hands N pool leads to a rep in one go and sends
-- ONE push ("You have 25 new prospects") through lead_assignment_batches →
-- notify, instead of one per lead: the per-lead push trigger is skipped while
-- app.bulk_assign is on.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists call_first   boolean not null default false,
  add column if not exists import_batch text;
comment on column public.leads.call_first is
  'Imported without text consent: texting is refused until a connected call or an inbound text (2026-10-07).';
comment on column public.leads.import_batch is
  'The import this lead came from (its source tag), for finding or undoing a batch.';
create index if not exists leads_unassigned_idx on public.leads (company, created_at) where assigned_to is null;

-- ---------------------------------------------------------------------------
-- 2. Import
-- ---------------------------------------------------------------------------
create or replace function public.lead_match_key(p_phone text, p_email text, p_address text)
returns text language sql immutable as $$
  select nullif(
    coalesce(nullif(right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10), ''), lower(trim(coalesce(p_email, ''))))
    || '|' ||
    regexp_replace(lower(coalesce(p_address, '')), '[^a-z0-9]', '', 'g'),
    '|');
$$;

create or replace function public.import_leads(p_source text, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_company  text := 'dc-solar';
  v_source   text := nullif(trim(coalesce(p_source, '')), '');
  v_row      jsonb;
  v_name     text;
  v_phone    text;
  v_email    text;
  v_address  text;
  v_key      text;
  v_seen     text[] := '{}';
  v_inserted integer := 0;
  v_existing integer := 0;
  v_invalid  integer := 0;
  v_dupes    integer := 0;
begin
  if not public.is_company_admin(v_company) then
    raise exception 'admins only' using errcode = '42501';
  end if;
  if v_source is null then
    raise exception 'name this import (its source)' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'send at most 5,000 rows at a time' using errcode = '22023';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_name    := nullif(trim(coalesce(v_row->>'name', '')), '');
    v_phone   := nullif(trim(coalesce(v_row->>'phone', '')), '');
    v_email   := nullif(lower(trim(coalesce(v_row->>'email', ''))), '');
    v_address := nullif(trim(coalesce(v_row->>'address', '')), '');
    if v_name is null or (v_phone is null and v_email is null) then
      v_invalid := v_invalid + 1;
      continue;
    end if;
    v_key := public.lead_match_key(v_phone, v_email, v_address);
    if v_key = any(v_seen) then
      v_dupes := v_dupes + 1;
      continue;
    end if;
    v_seen := v_seen || v_key;
    if exists (select 1 from public.leads l
                where l.company = v_company and public.lead_match_key(l.phone, l.email, l.address) = v_key)
       or exists (select 1 from public.customers c
                   where c.company = v_company and public.lead_match_key(c.phone, c.email, c.address) = v_key) then
      v_existing := v_existing + 1;
      continue;
    end if;

    insert into public.leads
      (company, name, phone, email, address, source, status, notes, assigned_to, call_first, import_batch)
    values
      (v_company, left(v_name, 200), v_phone, v_email, v_address, left(v_source, 120), 'new',
       nullif(left(trim(coalesce(v_row->>'notes', '')), 4000), ''), null, true, left(v_source, 120));
    v_inserted := v_inserted + 1;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'skipped_existing', v_existing,
                            'skipped_invalid', v_invalid, 'skipped_duplicate', v_dupes);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Bulk assign with one push
-- ---------------------------------------------------------------------------
create table if not exists public.lead_assignment_batches (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  company     text not null default 'dc-solar',
  rep_email   text not null,
  lead_count  integer not null,
  assigned_by text
);
alter table public.lead_assignment_batches enable row level security;
drop policy if exists lab_admin_select on public.lead_assignment_batches;
create policy lab_admin_select on public.lead_assignment_batches for select
  using (public.is_company_admin(company));

drop trigger if exists lead_assignment_batches_notify on public.lead_assignment_batches;
create trigger lead_assignment_batches_notify
  after insert on public.lead_assignment_batches
  for each row execute function public.notify_webhook();

-- The per-lead push stays quiet during a bulk assign.
drop trigger if exists leads_assigned_notify_upd on public.leads;
create trigger leads_assigned_notify_upd
  after update of assigned_to on public.leads
  for each row
  when (new.assigned_to is not null
        and lower(new.assigned_to) is distinct from lower(coalesce(old.assigned_to, ''))
        and lower(new.assigned_to) is distinct from lower(coalesce(public.jwt_email(), ''))
        and coalesce(current_setting('app.bulk_assign', true), '') <> 'on')
  execute function public.notify_webhook();

create or replace function public.assign_leads(p_ids uuid[], p_rep text)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_company text := 'dc-solar';
  v_rep     text := lower(trim(coalesce(p_rep, '')));
  v_count   integer;
begin
  if not public.is_company_admin(v_company) then
    raise exception 'admins only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.employees e where e.company = v_company and lower(e.email) = v_rep) then
    raise exception 'pick someone on the team' using errcode = '22023';
  end if;
  perform set_config('app.bulk_assign', 'on', true);
  update public.leads
     set assigned_to = v_rep
   where company = v_company
     and id = any(coalesce(p_ids, '{}'))
     and assigned_to is distinct from v_rep;
  get diagnostics v_count = row_count;
  perform set_config('app.bulk_assign', 'off', true);
  if v_count > 0 and v_rep is distinct from lower(coalesce(public.jwt_email(), '')) then
    insert into public.lead_assignment_batches (company, rep_email, lead_count, assigned_by)
    values (v_company, v_rep, v_count, lower(public.jwt_email()));
  end if;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Call first unlocks itself
-- ---------------------------------------------------------------------------
create or replace function public.messages_unlock_call_first()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_other text;
begin
  if not (
    (new.channel = 'call' and new.status = 'completed' and coalesce(new.duration_seconds, 0) > 0)
    or (new.channel = 'sms' and new.direction = 'in')
  ) then
    return new;
  end if;
  v_other := case when new.direction = 'in' then new.from_number else new.to_number end;
  update public.leads
     set call_first = false
   where company = new.company
     and call_first
     and (id = new.lead_id or (v_other is not null and phone_e164 = v_other));
  return new;
end;
$$;

drop trigger if exists messages_unlock_call_first on public.messages;
create trigger messages_unlock_call_first
  after insert or update of status, duration_seconds on public.messages
  for each row execute function public.messages_unlock_call_first();

revoke all on function public.import_leads(text, jsonb) from public, anon;
grant execute on function public.import_leads(text, jsonb) to authenticated;
revoke all on function public.assign_leads(uuid[], text) from public, anon;
grant execute on function public.assign_leads(uuid[], text) to authenticated;
revoke all on function public.messages_unlock_call_first() from public, anon, authenticated;

commit;
