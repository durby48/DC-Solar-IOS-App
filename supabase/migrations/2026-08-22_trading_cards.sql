-- DC SOLAR: The Trading Card Game — card database + art bucket (2026-08-22).
--
-- WHY THIS EXISTS
--
-- The trading card game was built in a separate repo (github.com/durby48/
-- dc-solar-tcg) as a print-and-play gag gift: one cards.json, one static HTML
-- print sheet, 51 MB of AI art, and prose rules. That is fine for a printer and
-- useless to the app. Devon wants the deck inside the field app — browsable on
-- a phone, editable by an admin, with new cards added as new jobs land — so the
-- JSON has to stop being the source of truth and the database has to start.
--
-- Two tables. `card_sets` is the printing (one row today: DCS26), and carries
-- the set's own tagline, version note, and the full game rules as Markdown so
-- the app can render RULES.md without shipping a copy in the bundle. `cards` is
-- one row per card, keyed by the slug the art file already uses (`job-26019`,
-- `crew-devon`, `special-cow`) — that slug is stable, human-readable, and is
-- what every filename, print sheet, and future deep link already says.
--
-- ONE TABLE, NOT FIVE. Job, crew, tool, event, and special cards share far more
-- than they differ (title, rarity, ability, flavor, art) and a card game reads
-- its deck as one list. The type-specific columns are simply null on the types
-- that do not use them, and NULL IS SEMANTIC here: `panels` null on a Critter
-- Guard job means "not counted in panels", `power = 0` on The Inspector means
-- he genuinely contributes nothing. Do not coalesce either one away.
--
-- SOFT LINKS TO REAL RECORDS. 27 job cards are real 2026 jobs and 4 crew cards
-- are real people, so `job_id` and `employee_id` point at `jobs` and
-- `employees`. Both are ON DELETE SET NULL, and `job_number` is kept as text
-- alongside `job_id`: the card is a keepsake of the work, and it should survive
-- the job record being reorganised. Neither is required — most cards have no
-- real-world counterpart at all.
--
-- WHAT IS AND IS NOT SENSITIVE
--
-- Card data is a gag gift, not money. Every company member can read it; only
-- admins can write, because a card is company-published artwork and a viewer
-- editing one is vandalism, not field work. That is the same split
-- `job_artwork` uses, and the read predicate is the same
-- public.is_company_member(company) the crew already gets on `jobs`.
--
-- THE ART GETS ITS OWN BUCKET. The obvious shortcut is a prefix inside
-- `job-photos` — do not take it. That bucket's INSERT policy is member-level
-- (the crew has to be able to upload site photos), so any crew member could
-- overwrite card art. `cards` is a new private bucket whose writes are
-- admin-only, matching the property-art shape from 2026-08-04. Private rather
-- than public because the job cards are drawn from customers' actual roofs.
--
-- Idempotent: safe to re-run. Seeds nothing — scripts/tcg/import.mjs loads the
-- deck.

begin;

-- ---------------------------------------------------------------------------
-- 1. Sets — one row per printing
-- ---------------------------------------------------------------------------
create table if not exists public.card_sets (
  company      text not null default 'dc-solar',
  -- Short printing code, e.g. 'DCS26'. Part of the key so a future company
  -- could have its own set with the same code without colliding.
  code         text not null,
  name         text not null,
  tagline      text,
  -- The set's own version string from cards.json meta ("0.1.0"), not a row
  -- version — cards carry their own `version` counter.
  version      text,
  notes        text,
  -- RULES.md, verbatim. Lives here rather than in app/assets so the rules can
  -- be corrected over the air without an app store round trip, and so a second
  -- set could ship different rules.
  rules_md     text,
  generated_on date,
  created_at   timestamptz not null default now(),
  primary key (company, code)
);

comment on table public.card_sets is
  'One row per printing of the trading card game. rules_md holds RULES.md so '
  'the app renders the rules from the database, not from a bundled copy.';

-- ---------------------------------------------------------------------------
-- 2. Cards
-- ---------------------------------------------------------------------------
create table if not exists public.cards (
  -- The slug: 'job-26019', 'crew-devon', 'special-cow'. Also the art filename.
  id           text primary key,
  company      text not null default 'dc-solar',
  set_code     text not null default 'DCS26',

  -- Printed position. card_number is what appears on the card ("14/61");
  -- sort_order is the collection order and is the one the app sorts by, so a
  -- card can be re-numbered for a reprint without reshuffling the grid.
  card_number  smallint,
  sort_order   int not null,

  card_type    text not null
                 check (card_type in ('job', 'crew', 'tool', 'event', 'special')),
  title        text not null,
  rarity       text not null
                 check (rarity in ('common', 'uncommon', 'rare', 'legendary', 'secret')),
  -- Rules text. Null on the plain job cards that only pay out kW.
  ability      text,
  flavor       text,
  -- The Gemini prompt the artwork was generated from. Kept so an admin can
  -- regenerate or restyle a card later without inventing a new prompt.
  art_prompt   text,

  -- Job cards (and The Mothership) --------------------------------------------
  job_number   text,
  job_id       uuid references public.jobs(id) on delete set null,
  location     text,          -- city level only. No street addresses on cards.
  service_type text,
  panels       int,
  kw_dc        numeric(5, 1), -- 0.4 .. 23.4; one decimal is the real precision
  annual_kwh   int,
  difficulty   smallint,
  reward_kw    smallint,

  -- Crew cards ----------------------------------------------------------------
  -- Set only on the four cards drawn from a real person's likeness.
  employee_id  uuid references public.employees(id) on delete set null,
  role         text,
  power        smallint,      -- 0 is a real value (The Inspector). Never coalesce.

  -- Tool cards ----------------------------------------------------------------
  bonus        smallint,      -- 0 is a real value (The Sharpie).

  -- Presentation --------------------------------------------------------------
  full_art     boolean not null default false,
  holo_only    boolean not null default false,
  -- Object key in the private `cards` bucket, e.g. 'special-cow.webp'.
  art_path     text,

  -- Bookkeeping ---------------------------------------------------------------
  version      int not null default 1,
  -- Soft delete: a printed card never disappears from someone's binder, so it
  -- never disappears from the table either.
  archived_at  timestamptz,
  created_by   text default (auth.jwt() ->> 'email'),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint cards_set_fk
    foreign key (company, set_code) references public.card_sets (company, code)
);

comment on column public.cards.power is
  'Crew power rating, 0-4. ZERO IS MEANINGFUL (The Inspector is Power 0) — '
  'null means "not a crew card", 0 means "contributes nothing". Same for bonus.';

comment on column public.cards.job_id is
  'Soft link to the real job. ON DELETE SET NULL and job_number is kept as '
  'text, because the card outlives the job record.';

create index if not exists cards_set_order_idx
  on public.cards (company, set_code, sort_order);

create index if not exists cards_type_idx
  on public.cards (company, card_type);

create index if not exists cards_job_idx
  on public.cards (job_id) where job_id is not null;

create or replace function public.cards_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cards_touch on public.cards;
create trigger cards_touch before update on public.cards
  for each row execute function public.cards_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Access
-- ---------------------------------------------------------------------------
-- Read = public.is_company_member(company), the same predicate `jobs` and
-- `job_artwork` use. Write = public.is_company_admin(company), split per verb
-- rather than FOR ALL so a future "let the crew favourite a card" policy can be
-- added to one verb without widening the other three.

alter table public.card_sets enable row level security;

drop policy if exists card_sets_member_select on public.card_sets;
create policy card_sets_member_select on public.card_sets for select
  using (public.is_company_member(company));

drop policy if exists card_sets_admin_insert on public.card_sets;
create policy card_sets_admin_insert on public.card_sets for insert
  with check (public.is_company_admin(company));

drop policy if exists card_sets_admin_update on public.card_sets;
create policy card_sets_admin_update on public.card_sets for update
  using (public.is_company_admin(company))
  with check (public.is_company_admin(company));

drop policy if exists card_sets_admin_delete on public.card_sets;
create policy card_sets_admin_delete on public.card_sets for delete
  using (public.is_company_admin(company));

alter table public.cards enable row level security;

drop policy if exists cards_member_select on public.cards;
create policy cards_member_select on public.cards for select
  using (public.is_company_member(company));

drop policy if exists cards_admin_insert on public.cards;
create policy cards_admin_insert on public.cards for insert
  with check (public.is_company_admin(company));

drop policy if exists cards_admin_update on public.cards;
create policy cards_admin_update on public.cards for update
  using (public.is_company_admin(company))
  with check (public.is_company_admin(company));

drop policy if exists cards_admin_delete on public.cards;
create policy cards_admin_delete on public.cards for delete
  using (public.is_company_admin(company));

-- ---------------------------------------------------------------------------
-- 4. Art bucket
-- ---------------------------------------------------------------------------
-- Private, and deliberately NOT a prefix inside job-photos: that bucket's
-- INSERT policy is member-level so the crew can upload site photos, which would
-- let any crew member overwrite card art. Same four-policy shape as
-- property-art (2026-08-04).

insert into storage.buckets (id, name, public)
values ('cards', 'cards', false)
on conflict (id) do nothing;

drop policy if exists "cards read" on storage.objects;
create policy "cards read" on storage.objects for select
  using (bucket_id = 'cards' and public.is_company_member('dc-solar'));

drop policy if exists "cards upload" on storage.objects;
create policy "cards upload" on storage.objects for insert
  with check (bucket_id = 'cards' and public.is_company_admin('dc-solar'));

drop policy if exists "cards update" on storage.objects;
create policy "cards update" on storage.objects for update
  using (bucket_id = 'cards' and public.is_company_admin('dc-solar'))
  with check (bucket_id = 'cards' and public.is_company_admin('dc-solar'));

drop policy if exists "cards delete" on storage.objects;
create policy "cards delete" on storage.objects for delete
  using (bucket_id = 'cards' and public.is_company_admin('dc-solar'));

commit;

-- Verify (expect 8 table policies + 4 storage policies):
--   select tablename, policyname, cmd
--     from pg_policies
--    where (schemaname = 'public' and tablename in ('cards', 'card_sets'))
--       or (schemaname = 'storage' and policyname like 'cards %')
--    order by tablename, policyname;
--
-- Verify the barrier by SIMULATING the users, not by reading the policies:
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"email":"snettleton2005@gmail.com","role":"authenticated"}';
--   select count(*) from public.cards;            -- expect: 61, readable
--   select count(*) from public.finance_entries;  -- expect: 0, always
--   insert into public.cards (id, sort_order, card_type, title, rarity)
--     values ('probe', 999, 'tool', 'Probe', 'common');  -- expect: denied
--   rollback;
