-- Contacts, Phase 2: tags, a customer link, a job title, and an import key.
-- (2026-09-12)
--
-- WHY. Devon wants to bring selected iPhone contacts into the app for the
-- whole crew — distributors, drivers, city inspectors, electricians — and to
-- file several people under ONE customer ("five contacts for Cromwell").
-- Phase 1's `contacts` had a name, an org and a number; this adds the four
-- things that ask for:
--
--   customer_id  a contact can belong to one customer (a contractor's project
--                manager, their office, their site lead). ON DELETE SET NULL:
--                `customers` has no DELETE policy, but a merge or an archive
--                must never take the people down with the record.
--   tags         free-form, text[]. "distributor", "driver", "city inspector"
--                — Devon's own words, not a CHECK list. `kind` stays for the
--                rows and callers that already use it; the app treats it as
--                the first tag and keeps the two in step on every write.
--   title        their role at the org ("Project manager").
--   source /     where the row came from ('manual' | 'ios_import') and the
--   external_id  iPhone contact identifier, so a re-import UPDATES the row
--                instead of creating a twin. Unique per company where set.
--   is_primary   the one person to ring first for that customer.
--
-- NOTHING ABOUT MATCHING CHANGES. `contacts.phone_e164` (generated, Phase 1)
-- is still the key twilio-inbound uses to file a text from a contact, and it
-- is untouched here. `phone_directory()` gains three columns AT THE END so
-- every existing caller — the Contacts tab, the keypad, the thread header —
-- keeps working; `fetchDirectory` maps by column name, not position.
--
-- RLS IS UNCHANGED: member SELECT, admin INSERT/UPDATE/DELETE, split per
-- verb. Devon wants the crew to HAVE the directory (a driver's number on a
-- roof in Raytown) — that is the member read. Adding, editing and importing
-- stay with owners and operators.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 2a. contacts — the new columns
-- ---------------------------------------------------------------------------
alter table public.contacts
  add column if not exists customer_id uuid references public.customers(id) on delete set null;

alter table public.contacts
  add column if not exists tags text[] not null default '{}';

alter table public.contacts
  add column if not exists title text;

-- 'manual' | 'ios_import'. Free text, same reasoning as `kind`.
alter table public.contacts
  add column if not exists source text not null default 'manual';

-- The iOS contact identifier. Stable per device/iCloud account; a re-import
-- from the same phone finds its own rows by this before falling back to the
-- phone number.
alter table public.contacts
  add column if not exists external_id text;

alter table public.contacts
  add column if not exists is_primary boolean not null default false;

-- `kind` was NOT NULL DEFAULT 'supplier' in Phase 1 and the app now writes it
-- as the first tag. Rows that pre-date tags get their kind copied across so a
-- tag filter on "supplier" finds the suppliers Devon already typed in.
update public.contacts
   set tags = array[kind]
 where cardinality(tags) = 0
   and kind is not null
   and kind <> '';

-- One row per iPhone contact per company. Partial: manual rows have no
-- external_id and there may be any number of those.
create unique index if not exists contacts_company_external_id_key
  on public.contacts (company, external_id)
  where external_id is not null;

-- The customer record's "Contacts" segment: everyone filed under this customer.
create index if not exists contacts_customer_idx
  on public.contacts (company, customer_id)
  where customer_id is not null;

-- Tag filter chips on the Contacts tab.
create index if not exists contacts_tags_idx
  on public.contacts using gin (tags);

comment on column public.contacts.customer_id is
  'The customer this person belongs to (a contractor''s PM, office, site lead). '
  'Null for a stand-alone contact. Set null when the customer goes away.';
comment on column public.contacts.tags is
  'Free-form tags: distributor, driver, city inspector, electrician… '
  'The app writes `kind` = tags[1] so Phase 1 callers keep working.';
comment on column public.contacts.external_id is
  'iOS contact identifier from expo-contacts. Re-imports update by this first, '
  'then by phone_e164, then insert.';
comment on column public.contacts.is_primary is
  'The person to ring first for customer_id. The app clears the others on set.';

comment on table public.contacts is
  'Everyone the company phones who is not a customer or a lead: suppliers, '
  'inspectors, drivers, and the several people behind one contractor customer '
  '(customer_id). Tagged, importable from an iPhone (external_id). '
  'Member read, admin write. See 2026-09-06_phone_contacts.sql and '
  '2026-09-12_contacts_tags.sql.';

-- ---------------------------------------------------------------------------
-- 2b. phone_directory() — same rows, three more columns at the end
-- ---------------------------------------------------------------------------
-- Postgres will not change a function's OUT columns through CREATE OR REPLACE,
-- so this is a drop + create. The revoke/grant pair is re-applied because a
-- dropped function loses its ACL. Body is Phase 1's, verbatim, with
-- customer_id / tags / title carried through for the contact rows and NULL
-- for the rest. Precedence, de-dup key and the inside-the-function admin
-- check are exactly as before.
drop function if exists public.phone_directory();

create function public.phone_directory()
returns table (
  source       text,
  id           uuid,
  display_name text,
  subtitle     text,
  phone_e164   text,
  sort_key     text,
  archived     boolean,
  customer_id  uuid,
  tags         text[],
  title        text
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
           1 as priority,
           null::uuid as customer_id,
           '{}'::text[] as tags,
           null::text as title
      from public.customers c
     where c.company = 'dc-solar'

    union all

    select 'contact',
           k.id,
           k.name,
           k.org,
           k.phone_e164,
           k.archived_at is not null,
           2,
           k.customer_id,
           case when cardinality(k.tags) > 0 then k.tags
                when k.kind is not null and k.kind <> '' then array[k.kind]
                else '{}'::text[] end,
           k.title
      from public.contacts k
     where k.company = 'dc-solar'

    union all

    select 'crew',
           e.id,
           coalesce(e.display_name, e.email),
           initcap(e.role),
           sp.cell_phone_e164,
           false,
           3,
           null::uuid,
           '{}'::text[],
           null::text
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
           4,
           null::uuid,
           '{}'::text[],
           null::text
      from public.leads l
     where l.company = 'dc-solar'
  ),
  deduped as (
    select distinct on (coalesce(e.phone_e164, e.source || ':' || e.id::text))
           e.source, e.id, e.display_name, e.subtitle, e.phone_e164, e.archived,
           e.customer_id, e.tags, e.title
      from everyone e
     order by coalesce(e.phone_e164, e.source || ':' || e.id::text), e.priority, e.display_name
  )
  select d.source,
         d.id,
         d.display_name,
         d.subtitle,
         d.phone_e164,
         lower(coalesce(d.display_name, '')) as sort_key,
         d.archived,
         d.customer_id,
         d.tags,
         d.title
    from deduped d
   where public.is_company_admin('dc-solar')
   order by lower(coalesce(d.display_name, '')), d.source;
$$;

comment on function public.phone_directory() is
  'Every number the Phone section can dial, de-duplicated by handset. '
  'Admin-only (checked inside). Columns 8-10 (customer_id, tags, title) added '
  '2026-09-12; see 2026-09-06_phone_contacts.sql for the rest.';

revoke all on function public.phone_directory() from public, anon;
grant execute on function public.phone_directory() to authenticated;

commit;

-- Verify (rolled-back impersonation, both directions — see CLAUDE.md).
-- Every statement below runs inside one transaction that ends in ROLLBACK,
-- so the admin insert leaves nothing behind.
--
--   begin;
--   set local role authenticated;
--
--   -- 1. Admin: full directory, the new columns present, and a write works.
--   set local request.jwt.claims = '{"email":"devonsd311@gmail.com","role":"authenticated"}';
--   select count(*),
--          count(*) filter (where source = 'contact'),
--          count(*) filter (where tags <> '{}')
--     from public.phone_directory();                      -- expect: rows; contact rows carry tags
--   insert into public.contacts (name, tags, title, source, external_id)
--     values ('RLS probe', array['driver'], 'Probe', 'ios_import', 'probe:1')
--     returning id, kind, tags, phone_e164;               -- expect: one row (kind stays 'supplier' — the app sets it)
--   update public.contacts set customer_id = (select id from public.customers limit 1)
--     where external_id = 'probe:1' returning customer_id; -- expect: one row, customer_id set
--
--   -- 2. Crew: reads the directory table, cannot write it, gets no phone_directory().
--   set local request.jwt.claims = '{"email":"test-crew@dcsolarkc.com","role":"authenticated"}';
--   select count(*) from public.contacts;                 -- expect: > 0 (member read, includes the probe row)
--   select count(*) from public.phone_directory();        -- expect: 0 (admin-only inside the function)
--   update public.contacts set title = 'x' where external_id = 'probe:1'; -- expect: UPDATE 0 (silently denied)
--   select count(*) from public.messages;                 -- expect: 0 (unchanged, admin-only)
--   -- LAST, because a denied insert aborts the transaction:
--   insert into public.contacts (name) values ('crew probe'); -- expect: ERROR 42501 (RLS)
--
--   rollback;
