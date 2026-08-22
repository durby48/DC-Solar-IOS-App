-- Communications: two-way SMS and bridge calling from the DC Solar number.
-- (2026-08-22, Workstream G of the 2026-08 overhaul)
--
-- WHY THIS EXISTS
--
-- Today the only outbound comms in the app are `tel:` and `mailto:` links. A
-- customer texted back goes to whoever's personal cell happened to make the
-- call, nobody else can see it, and when that person is on a roof the message
-- sits unread. This is the schema for a shared inbox on one business number.
--
-- FOUR TABLES, FOUR DIFFERENT ACCESS SHAPES — read this before adding a policy
--
-- staff_profiles  — SELF-service. Each employee stores the cell phone Twilio
--                   should ring for a bridge call. It is deliberately NOT a
--                   column on `employees`: that table has RLS on with SELECT
--                   policies only and no write policies at all, which is the
--                   load-bearing security invariant of this database. Adding
--                   a writable column there would mean adding an UPDATE
--                   policy to `employees`. Never do that.
--
-- comms_settings  — one seeded row, member-readable, admin-writable, and NO
--                   insert policy, exactly like company_settings. The crew has
--                   to be able to read the business number and the business
--                   hours; only Devon may change them.
--
-- messages        — ADMIN ONLY on all four verbs, split per verb. Threads
--                   contain prices, disputes and addresses. finance_entries
--                   leaked $56,617 to four viewer accounts once because one
--                   broad policy ORed over every narrow one; message bodies
--                   are the same class of data and get the same treatment.
--
-- message_templates — member read (a crew member should be able to see what
--                   the "On our way" text says), admin write.
--
-- CONSENT IS A SCHEMA CONCERN, NOT A UI ONE. Every seeded template ends with
-- "Reply STOP to opt out." because A2P 10DLC registration requires it and
-- because customers.sms_opt_out_at (crm.sql) is what twilio-inbound sets when
-- someone replies STOP. Do not seed a template without that sentence.
--
-- RECORDING IS OFF BY DEFAULT. Missouri is one-party consent, but DC Solar
-- works in Kansas too and takes calls from all-party-consent states. The
-- columns exist so the feature can be turned on deliberately later, with
-- recording_consent recorded per call. comms_settings.record_calls defaults
-- to false and should stay false until someone has read the law.
--
-- Idempotent: safe to re-run. Seeds comms_settings (one row) and six
-- templates, both with ON CONFLICT DO NOTHING so re-running never clobbers
-- text Devon has edited.

begin;

-- ---------------------------------------------------------------------------
-- 1. staff_profiles — the cell phone Twilio rings for a bridge call
-- ---------------------------------------------------------------------------
create table if not exists public.staff_profiles (
  company              text not null default 'dc-solar',
  email                text not null,
  cell_phone           text,
  voice_bridge_enabled boolean not null default true,
  updated_at           timestamptz not null default now(),
  primary key (company, email)
);

-- Same normalisation rule as customers.phone_e164 / leads.phone_e164: 10
-- digits or a leading-1 eleven, otherwise NULL. twilio-call refuses to dial
-- when this is null rather than guessing.
alter table public.staff_profiles
  add column if not exists cell_phone_e164 text generated always as (
    case
      when cell_phone is null then null
      when length(regexp_replace(cell_phone, '[^0-9]', '', 'g')) = 10
        then '+1' || regexp_replace(cell_phone, '[^0-9]', '', 'g')
      when length(regexp_replace(cell_phone, '[^0-9]', '', 'g')) = 11
       and left(regexp_replace(cell_phone, '[^0-9]', '', 'g'), 1) = '1'
        then '+' || regexp_replace(cell_phone, '[^0-9]', '', 'g')
      else null
    end
  ) stored;

comment on table public.staff_profiles is
  'Per-employee comms preferences. Separate from `employees` on purpose: that '
  'table is write-protected by having zero write policies, and it must stay '
  'that way.';

-- The PK is (company, email) and the self-policies compare lower(email), so
-- normalise on the way in or the same person can end up with two rows.
create or replace function public.staff_profiles_normalize()
returns trigger
language plpgsql
as $$
begin
  new.email := lower(trim(new.email));
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists staff_profiles_normalize_trg on public.staff_profiles;
create trigger staff_profiles_normalize_trg
  before insert or update on public.staff_profiles
  for each row execute function public.staff_profiles_normalize();

alter table public.staff_profiles enable row level security;

drop policy if exists sp_self_select on public.staff_profiles;
create policy sp_self_select on public.staff_profiles
  for select using (lower(email) = lower(public.jwt_email()));

drop policy if exists sp_self_insert on public.staff_profiles;
create policy sp_self_insert on public.staff_profiles
  for insert with check (
    public.is_company_member(company)
    and lower(email) = lower(public.jwt_email())
  );

drop policy if exists sp_self_update on public.staff_profiles;
create policy sp_self_update on public.staff_profiles
  for update
  using (lower(email) = lower(public.jwt_email()))
  with check (
    public.is_company_member(company)
    and lower(email) = lower(public.jwt_email())
  );

-- Admins need to see whose bridge number is missing before wondering why a
-- call did not connect. Read only — nobody edits somebody else's cell number.
drop policy if exists sp_admin_select on public.staff_profiles;
create policy sp_admin_select on public.staff_profiles
  for select using (public.is_company_admin(company));

-- ---------------------------------------------------------------------------
-- 2. comms_settings — one row, the way company_settings does it
-- ---------------------------------------------------------------------------
create table if not exists public.comms_settings (
  company               text primary key default 'dc-solar',
  -- The purchased Twilio number in E.164. Every customer sees this as caller
  -- ID; no personal cell ever appears.
  from_number           text,
  sms_enabled           boolean not null default false,
  voice_enabled         boolean not null default false,
  record_calls          boolean not null default false,
  business_hours_start  time not null default '07:00',
  business_hours_end    time not null default '18:00',
  after_hours_autoreply text,
  review_link           text,
  updated_at            timestamptz not null default now(),
  updated_by            text
);

insert into public.comms_settings (company, after_hours_autoreply)
values ('dc-solar',
        'Thanks for reaching out to DC Solar KC. We are out of the office right now '
        || 'but we will get back to you first thing. For anything urgent call '
        || '(816) 274-2415.')
on conflict (company) do nothing;

comment on table public.comms_settings is
  'Single seeded row. Member SELECT (the crew must be able to read the '
  'business number and hours), admin UPDATE, and NO INSERT policy on purpose '
  'so one row is the only row a client can ever produce.';

drop trigger if exists comms_settings_touch on public.comms_settings;
create trigger comms_settings_touch
  before update on public.comms_settings
  for each row execute function public.crm_touch_updated_at();

alter table public.comms_settings enable row level security;

drop policy if exists cs_member_select on public.comms_settings;
create policy cs_member_select on public.comms_settings
  for select using (public.is_company_member(company));

drop policy if exists cs_admin_update on public.comms_settings;
create policy cs_admin_update on public.comms_settings
  for update
  using (public.is_company_admin(company))
  with check (public.is_company_admin(company));

-- ---------------------------------------------------------------------------
-- 3. messages — the shared inbox (SMS rows and call logs in one timeline)
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  company           text not null default 'dc-solar',
  -- Three optional links. An inbound text from an unknown number has all
  -- three null until somebody attaches it to a customer or a lead.
  customer_id       uuid references public.customers(id) on delete set null,
  lead_id           uuid references public.leads(id) on delete set null,
  job_id            uuid references public.jobs(id) on delete set null,
  channel           text not null default 'sms' check (channel in ('sms', 'call')),
  direction         text not null check (direction in ('in', 'out')),
  from_number       text,
  to_number         text not null,
  body              text,
  -- FREE TEXT ON PURPOSE — no CHECK constraint. This holds Twilio's own
  -- status vocabulary (queued/sending/sent/delivered/undelivered/failed for
  -- messages, queued/ringing/in-progress/completed/busy/no-answer/canceled
  -- for calls) and Twilio adds to it. A CHECK here would turn a new Twilio
  -- status into a constraint violation inside a webhook that cannot retry,
  -- and we would lose the delivery record rather than the unknown word.
  status            text not null default 'queued',
  twilio_sid        text unique,
  error_code        text,
  error             text,
  sent_by           text,
  num_segments      int,
  media_urls        jsonb,
  duration_seconds  int,
  recording_url     text,
  recording_sid     text,
  recording_consent boolean,
  read_at           timestamptz,
  read_by           text
);

create index if not exists messages_thread_idx
  on public.messages (company, customer_id, created_at desc);

create index if not exists messages_recent_idx
  on public.messages (company, created_at desc);

-- Powers the unread badge on the Customers tab. Partial so it stays tiny
-- however long the archive gets.
create index if not exists messages_unread_idx
  on public.messages (company, created_at desc)
  where read_at is null and direction = 'in';

comment on table public.messages is
  'Every SMS and every bridge call, in and out. ADMIN ONLY on all four verbs '
  '(split per verb, never FOR ALL): threads carry prices, disputes and home '
  'addresses. Do not add a member read policy — Postgres ORs permissive '
  'policies and one broad policy defeats every narrow one.';

alter table public.messages enable row level security;

drop policy if exists msg_admin_select on public.messages;
create policy msg_admin_select on public.messages
  for select using (public.is_company_admin(company));

drop policy if exists msg_admin_insert on public.messages;
create policy msg_admin_insert on public.messages
  for insert with check (public.is_company_admin(company));

drop policy if exists msg_admin_update on public.messages;
create policy msg_admin_update on public.messages
  for update
  using (public.is_company_admin(company))
  with check (public.is_company_admin(company));

drop policy if exists msg_admin_delete on public.messages;
create policy msg_admin_delete on public.messages
  for delete using (public.is_company_admin(company));

-- ---------------------------------------------------------------------------
-- 4. message_templates
-- ---------------------------------------------------------------------------
create table if not exists public.message_templates (
  id      uuid primary key default gen_random_uuid(),
  company text not null default 'dc-solar',
  key     text not null,
  title   text not null,
  body    text not null,
  channel text not null default 'sms',
  active  boolean not null default true,
  sort    int not null default 0,
  unique (company, key)
);

comment on column public.message_templates.body is
  'Merge fields are {{double_braced}} and are filled by renderTemplate() in '
  'lib/comms.ts, which strips any token it cannot resolve rather than sending '
  'the literal braces. EVERY template must end with "Reply STOP to opt out." '
  '— that sentence is part of the A2P 10DLC campaign registration.';

insert into public.message_templates (company, key, title, body, sort) values
  ('dc-solar', 'otw', 'On our way',
   'DC Solar KC: {{tech}} is on the way to {{address}}, ETA about {{eta}}. Reply STOP to opt out.', 10),
  ('dc-solar', 'arrived', 'Arrived',
   'DC Solar KC: {{tech}} is on site at {{address}} and getting started. Reply STOP to opt out.', 20),
  ('dc-solar', 'reminder', 'Reminder',
   'DC Solar KC: reminder that we are scheduled at {{address}} on {{date}} at {{time}}. Reply to this text if that no longer works. Reply STOP to opt out.', 30),
  ('dc-solar', 'complete', 'Job complete',
   'DC Solar KC: we have finished up at {{address}}. Let us know if anything needs another look. Reply STOP to opt out.', 40),
  ('dc-solar', 'review', 'Review request',
   'Thanks for choosing DC Solar KC, {{customer}}. If we did right by you, a quick review helps us a lot: {{review_link}} Reply STOP to opt out.', 50),
  ('dc-solar', 'estimate_sent', 'Estimate sent',
   'DC Solar KC: your estimate {{document_number}} for {{address}} is ready, {{amount}}. Reply here with any questions. Reply STOP to opt out.', 60)
on conflict (company, key) do nothing;

alter table public.message_templates enable row level security;

drop policy if exists mt_member_select on public.message_templates;
create policy mt_member_select on public.message_templates
  for select using (public.is_company_member(company));

drop policy if exists mt_admin_all on public.message_templates;
create policy mt_admin_all on public.message_templates
  for all
  using (public.is_company_admin(company))
  with check (public.is_company_admin(company));

-- ---------------------------------------------------------------------------
-- 5. crm_merge_customers now moves the thread too
-- ---------------------------------------------------------------------------
-- Same function as 2026-08-22_crm.sql with `messages` added. Merging two
-- customer records and leaving the text history on the archived one loses the
-- conversation.
create or replace function public.crm_merge_customers(keep_id uuid, merge_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_keep  public.customers%rowtype;
  v_merge public.customers%rowtype;
  v_jobs  int := 0;
  v_fin   int := 0;
  v_docs  int := 0;
  v_notes int := 0;
  v_accts int := 0;
  v_msgs  int := 0;
begin
  if keep_id is null or merge_id is null then
    raise exception 'crm_merge_customers: both ids are required'
      using errcode = '22023';
  end if;

  if keep_id = merge_id then
    return jsonb_build_object('merged', false, 'reason', 'same customer');
  end if;

  select * into v_keep  from public.customers c where c.id = keep_id;
  select * into v_merge from public.customers c where c.id = merge_id;

  if not public.is_company_admin(coalesce(v_keep.company, v_merge.company, 'dc-solar')) then
    raise exception 'crm_merge_customers: only owners and operators can merge customers'
      using errcode = '42501';
  end if;

  if v_keep.id is null or v_merge.id is null then
    raise exception 'crm_merge_customers: customer not found'
      using errcode = 'P0002';
  end if;

  if v_keep.company <> v_merge.company then
    raise exception 'crm_merge_customers: refusing to merge across companies'
      using errcode = '22023';
  end if;

  update public.jobs j set customer_id = keep_id where j.customer_id = merge_id;
  get diagnostics v_jobs = row_count;

  update public.finance_entries f set customer_id = keep_id where f.customer_id = merge_id;
  get diagnostics v_fin = row_count;

  update public.customer_documents d set customer_id = keep_id where d.customer_id = merge_id;
  get diagnostics v_docs = row_count;

  update public.customer_notes n set customer_id = keep_id where n.customer_id = merge_id;
  get diagnostics v_notes = row_count;

  update public.messages m set customer_id = keep_id where m.customer_id = merge_id;
  get diagnostics v_msgs = row_count;

  update public.customer_accounts a set customer_id = keep_id where a.customer_id = merge_id;
  get diagnostics v_accts = row_count;

  update public.customers c
     set archived_at = coalesce(c.archived_at, now())
   where c.id = merge_id;

  return jsonb_build_object(
    'merged', true,
    'keep_id', keep_id,
    'merge_id', merge_id,
    'jobs', v_jobs,
    'finance_entries', v_fin,
    'customer_documents', v_docs,
    'customer_notes', v_notes,
    'messages', v_msgs,
    'customer_accounts', v_accts
  );
end;
$$;

revoke all on function public.crm_merge_customers(uuid, uuid) from public, anon;
grant execute on function public.crm_merge_customers(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Realtime — the app's first subscriber
-- ---------------------------------------------------------------------------
-- An inbound text has to appear in the inbox without a pull-to-refresh.
-- Realtime still applies RLS per subscriber, and `messages` is admin-only, so
-- a viewer's socket receives nothing — prove that, do not assume it.
-- REPLICA IDENTITY FULL is what makes UPDATE payloads carry old_record (the
-- read_at transition) and what lets Realtime evaluate RLS on updates.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'messages'
  ) then
    execute 'alter publication supabase_realtime add table public.messages';
  end if;
end
$$;

alter table public.messages replica identity full;

commit;

-- Verify:
--   select tablename, policyname, cmd from pg_policies
--    where schemaname = 'public'
--      and tablename in ('messages','staff_profiles','comms_settings','message_templates')
--    order by tablename, policyname;
--   select schemaname, tablename from pg_publication_tables
--    where pubname = 'supabase_realtime';
--
-- Verify the barrier by SIMULATING a viewer:
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"email":"snettleton2005@gmail.com","role":"authenticated"}';
--   select count(*) from public.messages;              -- expect: 0, always
--   select count(*) from public.comms_settings;        -- expect: 1 (readable)
--   update public.comms_settings set sms_enabled = true;  -- expect: 0 rows
--   insert into public.staff_profiles (email, cell_phone)
--     values ('devonsd311@gmail.com', '8165550000');    -- expect: denied
--   rollback;
