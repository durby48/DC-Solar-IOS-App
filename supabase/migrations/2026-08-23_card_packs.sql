-- DC SOLAR: The Trading Card Game — packs, personal decks, earned by hours
-- (2026-08-23).
--
-- WHY THIS EXISTS
--
-- 2026-08-22_trading_cards.sql put the 61-card set in Postgres and let every
-- company member browse the whole thing. That is a catalogue, not a card game:
-- there is nothing to collect, nothing to open, and no reason to look twice.
-- Devon's rule is the opposite — EVERY EMPLOYEE HAS THEIR OWN DECK, VISIBLE
-- ONLY TO THEM, everyone starts at zero cards, and the only way to get one is
-- to work: one booster pack per ten hours on the clock, backdated over every
-- hour already logged. Somebody sitting on 172 hours opens this app to 17
-- packs waiting for them.
--
-- Three things follow from that, and all three are enforced here rather than
-- in the app:
--
--   1. THE CATALOGUE STOPS BEING PUBLIC. `cards_member_select` is dropped and
--      replaced with `cards_admin_select`. If a viewer can still SELECT the
--      whole `cards` table, the collection is spoiled before it starts — they
--      can read every card, every rarity, and every piece of art without
--      opening a single pack. Admins (owner/operator — Devon, Isaiah, Clark)
--      keep the full 61 because somebody has to edit the set; they also have
--      their own deck and earn packs the same way. `card_sets` stays
--      member-readable: the rules page is not a spoiler.
--
--   2. THE ART FOLLOWS THE DECK, NOT THE ROSTER. The `"cards read"` storage
--      policy was `is_company_member('dc-solar')`, which would hand a viewer
--      every card image the moment they guessed a filename (and the filenames
--      are the card slugs, which are guessable — `special-cow.webp`). It is now
--      an allow-list built from what the caller actually owns, via
--      `my_card_art_paths()`. That helper HAS to be SECURITY DEFINER: a policy
--      expression runs with the CALLER's privileges, so an inline subquery over
--      `cards` would itself be filtered by `cards_admin_select` and silently
--      return nothing for exactly the people it is meant to serve. Same lesson
--      as `my_document_paths()` in 2026-08-22_document_revisions.sql, which was
--      proven by impersonation after a customer saw 0 of their own 2 PDFs.
--
--   3. NOBODY WRITES THEIR OWN CARDS. `user_cards` and `card_packs` have SELECT
--      policies only — self and admin — and no INSERT/UPDATE/DELETE policy at
--      all, plus an explicit REVOKE of those verbs from anon/authenticated.
--      The single way a row appears is `open_card_pack()`, which checks earned
--      hours first. A client that could insert into `user_cards` could give
--      itself the two secret rares, which is the entire game.
--
-- HOURS ARE COUNTED THE WAY PAYROLL COUNTS THEM, or the pack count in the game
-- disagrees with the number on the Hours tab and one of them is a bug. That
-- means BOTH sources, exactly as app/src/lib/payroll.ts does it:
--   * `employee_hours` rows matched by `lower(email)`, PLUS legacy rows where
--     `email is null` matched by `employee = employees.display_name` (68 rows
--     today, 25 of them legacy — dropping them would cost Simon 34.5 of his
--     55.5 hours and three packs);
--   * completed `time_entries` (both clock_in and clock_out set), as
--     `extract(epoch from clock_out - clock_in) / 3600`.
-- Rows with `hours <= 0` or a null `occurred_on` are skipped, and zero-length
-- shifts are skipped, because payroll skips them.
--
-- `employee_hours_total(text)` takes an email so the Hours tab can reconcile a
-- person's pack count — but it is NOT an hours oracle. It raises 42501 unless
-- you are asking about yourself or you are an admin. `employee_hours` is
-- admin-only through RLS and this function is SECURITY DEFINER; without that
-- guard, one rpc() call would leak everyone's hours to every viewer.
--
-- PACK MATH. 7 cards: slots 1-4 common, 5-6 uncommon, slot 7 is the hit —
-- 3% secret, 12% legendary, 85% rare. Draw is without replacement WITHIN a
-- pack (no duplicate in the same rip) but freely repeats across packs, which is
-- what makes a duplicate feel like a duplicate. Variants roll per card: holo if
-- the card is `holo_only` (Sold a Damn Cow is holographic full-art only, per
-- the printed sheet) or on a 3% roll, else foil at 10%, else base. An empty
-- rarity pool falls down the ladder to common rather than returning six cards.
--
-- SERIALISED BY ADVISORY LOCK. `open_card_pack()` reads the count of packs
-- already opened and then inserts one. Two taps on a slow connection is two
-- concurrent transactions that both read "1 available" and both insert — a free
-- pack. `pg_advisory_xact_lock(hashtext('pack:' || email))` makes the second
-- one wait for the first to commit; it is per-person, so the whole crew can
-- open packs at once.
--
-- SEEDS NOTHING. Everyone starts with zero cards. Backdating needs no data
-- migration because `packs_earned` is derived from historical hours every time
-- it is asked.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 0. Shared trigger — one lowercase spelling of an email, ever
-- ---------------------------------------------------------------------------
-- Every policy and every lookup in this file compares `lower(email)`. If a row
-- ever lands with mixed case, `count(*)` for packs opened and the row's own
-- visibility disagree, and somebody gets a free pack or loses a card. Same
-- normalisation `staff_profiles_normalize()` does for the same reason.
create or replace function public.card_email_lower()
returns trigger
language plpgsql
as $$
begin
  new.email := lower(trim(new.email));
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. card_packs — one row per rip, kept as the receipt
-- ---------------------------------------------------------------------------
-- Created before user_cards because user_cards points at it. `card_ids` is
-- denormalised on purpose: it is what was in the pack at the moment it was
-- opened, and it survives a card being archived, renamed or re-slugged later.
-- `hours_at_open` / `packs_available_before` are the audit trail for "why did I
-- only get one pack" — the numbers the decision was made on, not the numbers
-- today.
create table if not exists public.card_packs (
  id                     uuid primary key default gen_random_uuid(),
  company                text not null default 'dc-solar',
  email                  text not null,
  opened_at              timestamptz not null default now(),
  card_ids               text[] not null,
  hours_at_open          numeric,
  packs_available_before int
);

comment on table public.card_packs is
  'One row per booster pack opened. Written only by public.open_card_pack(); '
  'there is no INSERT policy and no INSERT grant.';

create index if not exists card_packs_email_idx
  on public.card_packs (company, email, opened_at desc);

drop trigger if exists card_packs_email_lower on public.card_packs;
create trigger card_packs_email_lower before insert on public.card_packs
  for each row execute function public.card_email_lower();

-- ---------------------------------------------------------------------------
-- 2. user_cards — the personal deck
-- ---------------------------------------------------------------------------
-- Keyed by EMAIL, not employees.id. The whole app identifies a person by their
-- login email (time_entries.employee, employee_hours.email, staff_profiles,
-- push_tokens), jwt_email() is what every policy has to compare against, and a
-- deck must not evaporate if an `employees` row is re-created.
--
-- One row per copy owned: duplicates are the point of a booster pack, so there
-- is deliberately no unique constraint on (email, card_id).
create table if not exists public.user_cards (
  id          uuid primary key default gen_random_uuid(),
  company     text not null default 'dc-solar',
  email       text not null,
  card_id     text not null references public.cards(id),
  -- Nullable and ON DELETE SET NULL: a card stays in the binder even if the
  -- pack receipt is ever purged.
  pack_id     uuid references public.card_packs(id) on delete set null,
  variant     text not null default 'base'
                check (variant in ('base', 'foil', 'holo')),
  obtained_at timestamptz not null default now()
);

comment on table public.user_cards is
  'One row per card copy a person owns. SELECT-only for self and admins; the '
  'only writer is public.open_card_pack().';

-- The deck screen reads "my cards, newest first"; the second index is for
-- "who owns this card" and for the FK check on cards(id).
create index if not exists user_cards_owner_idx
  on public.user_cards (company, email, obtained_at desc);

create index if not exists user_cards_card_idx
  on public.user_cards (card_id);

drop trigger if exists user_cards_email_lower on public.user_cards;
create trigger user_cards_email_lower before insert on public.user_cards
  for each row execute function public.card_email_lower();

-- ---------------------------------------------------------------------------
-- 3. Access — SELECT only, self or admin. No write policy anywhere.
-- ---------------------------------------------------------------------------
alter table public.user_cards enable row level security;

drop policy if exists uc_self_select on public.user_cards;
create policy uc_self_select on public.user_cards for select
  using (lower(email) = lower(public.jwt_email()));

drop policy if exists uc_admin_select on public.user_cards;
create policy uc_admin_select on public.user_cards for select
  using (public.is_company_admin(company));

alter table public.card_packs enable row level security;

drop policy if exists cp_self_select on public.card_packs;
create policy cp_self_select on public.card_packs for select
  using (lower(email) = lower(public.jwt_email()));

drop policy if exists cp_admin_select on public.card_packs;
create policy cp_admin_select on public.card_packs for select
  using (public.is_company_admin(company));

-- Belt and braces on top of "no write policy": Supabase's default privileges
-- hand `authenticated` all four verbs on a new public table. Missing policies
-- already deny the write, but a REVOKE means the denial does not depend on
-- anyone remembering not to add a policy later.
grant select on public.user_cards to authenticated;
grant select on public.card_packs to authenticated;
revoke insert, update, delete on public.user_cards from authenticated, anon;
revoke insert, update, delete on public.card_packs from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 4. employee_hours_total — the payroll rule, in one place
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because `employee_hours` is admin-only and `employees` is
-- not readable in full by a viewer — a person has to be able to learn their own
-- hours without being able to read the payroll table. The authorisation check
-- is the first statement in the body: self or admin, otherwise 42501.
--
-- `coalesce(... = ..., false)` rather than a bare `<>` so a token with no email
-- claim is refused rather than falling through on a NULL comparison.
create or replace function public.employee_hours_total(p_email text)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email  text := lower(trim(p_email));
  v_name   text;
  v_manual numeric := 0;
  v_clock  numeric := 0;
begin
  if not coalesce(v_email = lower(public.jwt_email()), false)
     and not public.is_company_admin('dc-solar') then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  if v_email is null or v_email = '' then
    return 0;
  end if;

  -- The display name is only needed for the legacy rows. Unknown email ->
  -- v_name stays null -> the legacy branch matches nothing -> 0, not an error.
  select e.display_name into v_name
    from public.employees e
   where e.company = 'dc-solar'
     and lower(e.email) = v_email
   limit 1;

  -- Source 1: manual hour logs. `email is null` rows predate the email column
  -- and are matched by the name the Hours tab shows.
  select coalesce(sum(h.hours), 0) into v_manual
    from public.employee_hours h
   where h.company = 'dc-solar'
     and h.hours > 0
     and h.occurred_on is not null
     and (
           lower(h.email) = v_email
           or (h.email is null and v_name is not null and h.employee = v_name)
         );

  -- Source 2: completed shifts on the time clock. `time_entries.employee` is
  -- the login email, not a display name.
  select coalesce(sum(extract(epoch from t.clock_out - t.clock_in)::numeric / 3600.0), 0)
    into v_clock
    from public.time_entries t
   where t.company = 'dc-solar'
     and t.clock_in is not null
     and t.clock_out is not null
     and t.clock_out > t.clock_in
     and lower(t.employee) = v_email;

  -- Two decimals so the number the app prints and the number the pack maths
  -- used are the same number.
  return round(v_manual + v_clock, 2);
end;
$$;

comment on function public.employee_hours_total(text) is
  'Total hours worked, counted exactly the way app/src/lib/payroll.ts counts '
  'them (employee_hours by email or legacy display_name, plus completed '
  'time_entries). SECURITY DEFINER with a self-or-admin check inside: asking '
  'about somebody else raises 42501. Not an hours oracle.';

revoke all on function public.employee_hours_total(text) from public, anon;
grant execute on function public.employee_hours_total(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. my_pack_status — "how many packs am I owed?"
-- ---------------------------------------------------------------------------
-- Always exactly one row, even for somebody who has never worked an hour or is
-- not on the roster at all: the screen shows "0 packs — 10 hours to your
-- first", not an empty state that looks like a failed request.
create or replace function public.my_pack_status()
returns table (
  total_hours     numeric,
  packs_earned    int,
  packs_opened    int,
  packs_available int,
  hours_to_next   numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email  text := lower(coalesce(public.jwt_email(), ''));
  v_hours  numeric := 0;
  v_earned int := 0;
  v_opened int := 0;
begin
  if v_email <> '' then
    -- Self-lookup, so the guard inside employee_hours_total always passes.
    v_hours  := public.employee_hours_total(v_email);
    v_earned := floor(v_hours / 10)::int;

    select count(*)::int into v_opened
      from public.card_packs p
     where p.company = 'dc-solar'
       and lower(p.email) = v_email;
  end if;

  return query
  select v_hours,
         v_earned,
         v_opened,
         greatest(v_earned - v_opened, 0),
         ((v_earned + 1) * 10)::numeric - v_hours;
end;
$$;

comment on function public.my_pack_status() is
  'One pack per 10 hours worked, backdated over all historical hours. Always '
  'returns exactly one row for the caller.';

revoke all on function public.my_pack_status() from public, anon;
grant execute on function public.my_pack_status() to authenticated;

-- ---------------------------------------------------------------------------
-- 6. open_card_pack — the only writer of user_cards
-- ---------------------------------------------------------------------------
-- Returns the seven cards in slot order, hit last, so the app can flip them one
-- at a time and land on the good one. `is_new` is evaluated BEFORE the inserts,
-- otherwise every card in the pack reports as already-owned.
create or replace function public.open_card_pack()
returns table (
  user_card_id uuid,
  card_id      text,
  variant      text,
  is_new       boolean,
  slot         int
)
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_email     text := lower(coalesce(public.jwt_email(), ''));
  v_hours     numeric := 0;
  v_earned    int := 0;
  v_opened    int := 0;
  v_available int := 0;
  v_pack_id   uuid := gen_random_uuid();
  v_slot      int;
  v_rarity    text;
  v_ladder    text[];
  v_step      text;
  v_pick      record;
  v_found     boolean;
  v_roll      numeric;
  v_ids       text[]    := '{}';
  v_variants  text[]    := '{}';
  v_news      boolean[] := '{}';
  v_uc_ids    uuid[]    := '{}';
  v_no_packs  constant text :=
    'No packs available yet — you earn one for every 10 hours worked.';
begin
  if v_email = '' then
    raise exception '%', v_no_packs using errcode = 'P0001';
  end if;

  -- Serialise this person's rips. Per-email, so the rest of the crew is not
  -- queued behind them; xact-scoped, so it is released on commit or rollback
  -- without an explicit unlock.
  perform pg_advisory_xact_lock(hashtext('pack:' || v_email));

  v_hours  := public.employee_hours_total(v_email);
  v_earned := floor(v_hours / 10)::int;

  select count(*)::int into v_opened
    from public.card_packs p
   where p.company = 'dc-solar'
     and lower(p.email) = v_email;

  v_available := greatest(v_earned - v_opened, 0);

  if v_available <= 0 then
    raise exception '%', v_no_packs using errcode = 'P0001';
  end if;

  for v_slot in 1..7 loop
    -- Slot 7 is the hit: 3% secret / 12% legendary / 85% rare. ONE roll
    -- compared against cumulative thresholds — two separate random() calls
    -- would make legendary 0.97 × 15% instead of the 12% band between 0.03
    -- and 0.15.
    if v_slot <= 4 then
      v_rarity := 'common';
    elsif v_slot <= 6 then
      v_rarity := 'uncommon';
    else
      v_roll := random();
      if v_roll < 0.03 then
        v_rarity := 'secret';
      elsif v_roll < 0.15 then
        v_rarity := 'legendary';
      else
        v_rarity := 'rare';
      end if;
    end if;

    -- Fall down the ladder if a rarity has no live cards left to give.
    v_ladder := case v_rarity
                  when 'secret'    then array['secret', 'legendary', 'rare', 'uncommon', 'common']
                  when 'legendary' then array['legendary', 'rare', 'uncommon', 'common']
                  when 'rare'      then array['rare', 'uncommon', 'common']
                  when 'uncommon'  then array['uncommon', 'common']
                  else                  array['common']
                end;

    v_found := false;
    foreach v_step in array v_ladder loop
      select c.id as cid, c.holo_only as holo
        into v_pick
        from public.cards c
       where c.company = 'dc-solar'
         and c.archived_at is null
         and c.rarity = v_step
         and not (c.id = any (v_ids))     -- without replacement, this pack only
       order by random()
       limit 1;
      if found then
        v_found := true;
        exit;
      end if;
    end loop;

    -- Ladder exhausted (a very small or heavily archived set): take any live
    -- card rather than hand back a short pack.
    if not v_found then
      select c.id as cid, c.holo_only as holo
        into v_pick
        from public.cards c
       where c.company = 'dc-solar'
         and c.archived_at is null
         and not (c.id = any (v_ids))
       order by random()
       limit 1;
      v_found := found;
    end if;

    if not v_found then
      raise exception 'There are not enough cards in the set to fill a pack.'
        using errcode = 'P0001';
    end if;

    -- array_append, not `||`: `text[] || 'foil'` resolves to the array-concat
    -- operator and Postgres tries to parse 'foil' as an array literal.
    v_ids := array_append(v_ids, v_pick.cid::text);

    -- holo_only cards ignore the roll entirely — that is what "holographic
    -- full-art only" means on the printed sheet.
    if v_pick.holo or random() < 0.03 then
      v_variants := array_append(v_variants, 'holo'::text);
    elsif random() < 0.10 then
      v_variants := array_append(v_variants, 'foil'::text);
    else
      v_variants := array_append(v_variants, 'base'::text);
    end if;

    v_news := array_append(v_news, (not exists (
      select 1
        from public.user_cards uc
       where uc.company = 'dc-solar'
         and lower(uc.email) = v_email
         and uc.card_id = v_pick.cid
    ))::boolean);

    v_uc_ids := array_append(v_uc_ids, gen_random_uuid());
  end loop;

  insert into public.card_packs
    (id, company, email, card_ids, hours_at_open, packs_available_before)
  values
    (v_pack_id, 'dc-solar', v_email, v_ids, v_hours, v_available);

  insert into public.user_cards (id, company, email, card_id, pack_id, variant)
  select v_uc_ids[g.i], 'dc-solar', v_email, v_ids[g.i], v_pack_id, v_variants[g.i]
    from generate_series(1, 7) as g(i);

  return query
  select v_uc_ids[g.i], v_ids[g.i], v_variants[g.i], v_news[g.i], g.i
    from generate_series(1, 7) as g(i)
   order by g.i;
end;
$$;

comment on function public.open_card_pack() is
  'Opens one earned booster pack: 7 cards, slots 1-4 common, 5-6 uncommon, '
  'slot 7 the hit (3% secret / 12% legendary / 85% rare). Raises P0001 when no '
  'pack is available. The only writer of user_cards and card_packs.';

revoke all on function public.open_card_pack() from public, anon;
grant execute on function public.open_card_pack() to authenticated;

-- ---------------------------------------------------------------------------
-- 7. my_cards — the caller's binder, joined to the card face
-- ---------------------------------------------------------------------------
-- Every column of `public.cards` in table order, because the card renderer in
-- app/src/lib/cards.ts normalises the full row and `select *` is not available
-- through an rpc(). Archived cards ARE included: a card pulled from the set
-- never leaves the binder of somebody who already pulled it.
create or replace function public.my_cards()
returns table (
  user_card_id uuid,
  obtained_at  timestamptz,
  variant      text,
  pack_id      uuid,
  id           text,
  company      text,
  set_code     text,
  card_number  smallint,
  sort_order   int,
  card_type    text,
  title        text,
  rarity       text,
  ability      text,
  flavor       text,
  art_prompt   text,
  job_number   text,
  job_id       uuid,
  location     text,
  service_type text,
  panels       int,
  kw_dc        numeric,
  annual_kwh   int,
  difficulty   smallint,
  reward_kw    smallint,
  employee_id  uuid,
  role         text,
  power        smallint,
  bonus        smallint,
  full_art     boolean,
  holo_only    boolean,
  art_path     text,
  version      int,
  archived_at  timestamptz,
  created_by   text,
  created_at   timestamptz,
  updated_at   timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select uc.id, uc.obtained_at, uc.variant, uc.pack_id,
         c.id, c.company, c.set_code, c.card_number, c.sort_order,
         c.card_type, c.title, c.rarity, c.ability, c.flavor, c.art_prompt,
         c.job_number, c.job_id, c.location, c.service_type, c.panels,
         c.kw_dc, c.annual_kwh, c.difficulty, c.reward_kw,
         c.employee_id, c.role, c.power, c.bonus,
         c.full_art, c.holo_only, c.art_path,
         c.version, c.archived_at, c.created_by, c.created_at, c.updated_at
    from public.user_cards uc
    join public.cards c on c.id = uc.card_id
   where lower(uc.email) = lower(public.jwt_email())
   order by uc.obtained_at desc, c.sort_order asc;
$$;

comment on function public.my_cards() is
  'The signed-in person''s own cards joined to the card face. Definer, because '
  'public.cards is admin-only SELECT since 2026-08-23 — this is how a viewer '
  'sees the 12 cards they own without seeing the other 49.';

revoke all on function public.my_cards() from public, anon;
grant execute on function public.my_cards() to authenticated;

-- ---------------------------------------------------------------------------
-- 8. The catalogue becomes admin-only
-- ---------------------------------------------------------------------------
-- The one policy change that makes the game a game. Admin write policies
-- (cards_admin_insert / update / delete) are untouched, and `card_sets` keeps
-- its member SELECT so /cards/rules still renders.
drop policy if exists cards_member_select on public.cards;

drop policy if exists cards_admin_select on public.cards;
create policy cards_admin_select on public.cards for select
  using (public.is_company_admin(company));

-- ---------------------------------------------------------------------------
-- 9. Card art follows the deck
-- ---------------------------------------------------------------------------
-- See note 2 in the header: this MUST be a definer function, not an inline
-- subquery, or the policy reads `cards` as the caller and returns nothing.
create or replace function public.my_card_art_paths()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select distinct c.art_path
    from public.user_cards uc
    join public.cards c on c.id = uc.card_id
   where lower(uc.email) = lower(public.jwt_email())
     and c.art_path is not null;
$$;

comment on function public.my_card_art_paths() is
  'Object names in the `cards` bucket the caller is allowed to open — the art '
  'of the cards they own. Exists only to back the "cards read" storage policy, '
  'which cannot read public.cards on its own.';

revoke all on function public.my_card_art_paths() from public, anon;
grant execute on function public.my_card_art_paths() to authenticated;

-- Exact object NAME, never a prefix: the bucket is flat and the filenames are
-- the card slugs, so `like` would be an open door.
drop policy if exists "cards read" on storage.objects;
create policy "cards read" on storage.objects for select
  using (
    bucket_id = 'cards'
    and (
      public.is_company_admin('dc-solar')
      or name in (select public.my_card_art_paths())
    )
  );

-- ---------------------------------------------------------------------------
-- 10. staff_profiles.avatar_path — profile pictures
-- ---------------------------------------------------------------------------
-- Additive column only. staff_profiles already has sp_self_insert /
-- sp_self_update, so a person can set their own and nobody else's; `employees`
-- stays write-policy-free, which is the invariant comms.sql called out.
alter table public.staff_profiles
  add column if not exists avatar_path text;

commit;

-- Verify the policy inventory (expect cards_admin_select + the three admin
-- write policies on `cards`, two SELECT policies each on user_cards and
-- card_packs, and no write policy on either):
--   select tablename, policyname, cmd from pg_policies
--    where schemaname = 'public'
--      and tablename in ('cards', 'user_cards', 'card_packs')
--    order by tablename, cmd, policyname;
--
-- Verify the barrier by SIMULATING the users, not by reading the policies:
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"email":"snettleton2005@gmail.com","role":"authenticated"}';
--   select count(*) from public.cards;              -- expect: 0 (admin-only)
--   select count(*) from public.card_sets;          -- expect: 1 (rules page)
--   select count(*) from public.finance_entries;    -- expect: 0, always
--   select * from public.my_pack_status();          -- expect: their own hours
--   select * from public.open_card_pack();          -- expect: 7 rows
--   select count(*) from public.my_cards();         -- expect: 7
--   select public.employee_hours_total('devonsd311@gmail.com');  -- expect: 42501
--   insert into public.user_cards (email, card_id)
--     values ('snettleton2005@gmail.com', 'special-cow');        -- expect: 42501
--   select count(*) from storage.objects where bucket_id = 'cards';
--                                                   -- expect: 7 (their art only)
--   rollback;
