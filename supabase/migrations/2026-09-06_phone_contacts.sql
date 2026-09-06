-- Phone section, Phase 1: suppliers/vendors, a third thread slot on
-- `messages`, and one server-side directory the Keypad/Contacts screens read.
-- (2026-09-06)
--
-- WHY A SUPPLIER TABLE. The Phone section's Contacts tab is everybody the crew
-- dials: customers, leads, each other, and the supply house. The first three
-- already have tables; the fourth had nowhere to live, so a supplier's number
-- was in somebody's personal phone and a text from them landed in the inbox as
-- an unclaimed "unknown number". `contacts` is deliberately narrow — a name, an
-- org, a number, an email, notes — not a second CRM.
--
-- WHY `phone_e164` IS COPIED VERBATIM FROM `customers`. Two different
-- normalisers in one database is how a number threads on one screen and not
-- on another. The CASE below is the customers.phone_e164 expression character
-- for character (staff_profiles.cell_phone_e164 uses the same one).
--
-- WHY ONE FUNCTION AND NOT FOUR CLIENT QUERIES. `phone_directory()` unions
-- customers, leads, crew and contacts, sorts A–Z and de-duplicates ONCE,
-- server-side — and, because it re-checks `is_company_admin()` itself, a crew
-- member's cell number never travels to a non-admin client at all. Same shape
-- as `my_projects()` / `my_documents()`: the function chooses the rows AND the
-- columns, so a client cannot widen the query.
--
-- RLS ON `contacts`: member SELECT, admin INSERT/UPDATE/DELETE, split per verb
-- (matching message_templates in spirit; split rather than FOR ALL because one
-- broad policy is how finance_entries leaked). Suppliers are not sensitive —
-- the crew calling the supply house is a feature.
--
-- NOTHING HERE TOUCHES THE POLICIES ON `messages`. It stays admin-only on all
-- four verbs. Threads carry prices and home addresses.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1a. contacts — suppliers, vendors, inspectors, anyone who is not a customer
-- ---------------------------------------------------------------------------
create table if not exists public.contacts (
  id          uuid primary key default gen_random_uuid(),
  company     text not null default 'dc-solar',
  -- supplier | vendor | inspector | other. Free text on purpose, same as
  -- messages.status: a CHECK here turns "utility" into a constraint error.
  kind        text not null default 'supplier',
  -- The person, or the business when there is no particular person.
  name        text not null,
  -- "Kansas City Solar Supply". Shown as the subtitle in the directory.
  org         text,
  phone       text,
  email       text,
  notes       text,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  created_by  text
);

-- customers.phone_e164, verbatim. 10 digits or a leading-1 eleven → E.164,
-- anything else → NULL, and the directory shows WHY it can't be dialled
-- rather than silently hiding the row.
alter table public.contacts
  add column if not exists phone_e164 text generated always as (
    case
      when phone is null then null
      when length(regexp_replace(phone, '[^0-9]', '', 'g')) = 10
        then '+1' || regexp_replace(phone, '[^0-9]', '', 'g')
      when length(regexp_replace(phone, '[^0-9]', '', 'g')) = 11
       and left(regexp_replace(phone, '[^0-9]', '', 'g'), 1) = '1'
        then '+' || regexp_replace(phone, '[^0-9]', '', 'g')
      else null
    end
  ) stored;

create index if not exists contacts_company_name_idx
  on public.contacts (company, lower(name));

create index if not exists contacts_phone_idx
  on public.contacts (company, phone_e164)
  where phone_e164 is not null;

comment on table public.contacts is
  'Suppliers, vendors, inspectors — everyone the crew phones who is not a '
  'customer or a lead. Narrow on purpose; not a second CRM. Member read, '
  'admin write.';

alter table public.contacts enable row level security;

drop policy if exists contacts_member_select on public.contacts;
create policy contacts_member_select on public.contacts
  for select using (public.is_company_member(company));

drop policy if exists contacts_admin_insert on public.contacts;
create policy contacts_admin_insert on public.contacts
  for insert with check (public.is_company_admin(company));

drop policy if exists contacts_admin_update on public.contacts;
create policy contacts_admin_update on public.contacts
  for update
  using (public.is_company_admin(company))
  with check (public.is_company_admin(company));

drop policy if exists contacts_admin_delete on public.contacts;
create policy contacts_admin_delete on public.contacts
  for delete using (public.is_company_admin(company));

-- ---------------------------------------------------------------------------
-- 1b. messages.contact_id — the third thread slot
-- ---------------------------------------------------------------------------
-- `messages` had customer_id and lead_id, so a text from the supply house
-- landed as an unclaimed number. twilio-inbound now looks contacts up after
-- customers and leads (that is an edge-function redeploy, done alongside
-- this file), and twilio-send-sms / twilio-call stamp it on outbound rows.
alter table public.messages
  add column if not exists contact_id uuid references public.contacts(id) on delete set null;

create index if not exists messages_contact_thread_idx
  on public.messages (company, contact_id, created_at desc)
  where contact_id is not null;

-- ---------------------------------------------------------------------------
-- 1c. phone_directory() — one query for the Contacts tab and the keypad
-- ---------------------------------------------------------------------------
-- ADMIN ONLY, enforced INSIDE the function: it is SECURITY DEFINER so it can
-- read staff_profiles (crew cell numbers) on the caller's behalf, and the
-- is_company_admin() check is what makes that safe. A viewer or an outsider
-- gets zero rows, not an error — the Phone section is admin-only by Devon's
-- decision, and RLS on the underlying tables is unchanged either way.
--
-- DE-DUPLICATION IS BY NUMBER. A lead who became a customer, or a customer
-- entered twice, is the same handset; showing it twice under two names is the
-- confusion this function exists to remove. Precedence when two rows share a
-- number: customer > contact > crew > lead. Rows with NO usable number are all
-- kept — there is nothing to de-duplicate them on and they are still worth
-- seeing, greyed, with the reason.
create or replace function public.phone_directory()
returns table (
  source       text,
  id           uuid,
  display_name text,
  subtitle     text,
  phone_e164   text,
  sort_key     text,
  archived     boolean
)
language sql
security definer
set search_path = public
stable
as $$
  with everyone as (
    select 'customer'::text as source,
           c.id,
           c.name as display_name,
           c.address as subtitle,
           c.phone_e164,
           c.archived_at is not null as archived,
           1 as priority
      from public.customers c
     where c.company = 'dc-solar'

    union all

    select 'contact',
           k.id,
           k.name,
           k.org,
           k.phone_e164,
           k.archived_at is not null,
           2
      from public.contacts k
     where k.company = 'dc-solar'

    union all

    select 'crew',
           e.id,
           coalesce(e.display_name, e.email),
           initcap(e.role),
           sp.cell_phone_e164,
           false,
           3
      from public.employees e
      left join public.staff_profiles sp
        on sp.company = e.company
       and lower(sp.email) = lower(e.email)
     where e.company = 'dc-solar'
       and e.is_test = false

    union all

    select 'lead',
           l.id,
           l.name,
           l.status,
           l.phone_e164,
           false,
           4
      from public.leads l
     where l.company = 'dc-solar'
  ),
  deduped as (
    select distinct on (coalesce(e.phone_e164, e.source || ':' || e.id::text))
           e.source, e.id, e.display_name, e.subtitle, e.phone_e164, e.archived
      from everyone e
     order by coalesce(e.phone_e164, e.source || ':' || e.id::text), e.priority, e.display_name
  )
  select d.source,
         d.id,
         d.display_name,
         d.subtitle,
         d.phone_e164,
         lower(coalesce(d.display_name, '')) as sort_key,
         d.archived
    from deduped d
   where public.is_company_admin('dc-solar')
   order by lower(coalesce(d.display_name, '')), d.source;
$$;

comment on function public.phone_directory() is
  'Every number the Phone section can dial, de-duplicated by handset. '
  'Admin-only (checked inside). See 2026-09-06_phone_contacts.sql.';

revoke all on function public.phone_directory() from public, anon;
grant execute on function public.phone_directory() to authenticated;

commit;

-- Verify (rolled-back impersonation, both directions — see CLAUDE.md):
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"email":"devonsd311@gmail.com","role":"authenticated"}';
--   select count(*), count(*) filter (where source = 'crew' and phone_e164 is not null)
--     from public.phone_directory();                      -- expect: the full directory
--   set local request.jwt.claims = '{"email":"test-crew@dcsolarkc.com","role":"authenticated"}';
--   select count(*) from public.phone_directory();        -- expect: 0
--   select count(*) from public.messages;                 -- expect: 0
--   select count(*) from public.contacts;                 -- expect: readable (member)
--   insert into public.contacts (name) values ('x');      -- expect: denied
--   rollback;
