-- Company value inputs + live Financials (2026-09-12).
--
-- WHY. The Financials screen now opens with a stock-style chart of revenue,
-- profit and COMPANY VALUE since 2026-07-01 (docs/VALUATION.md). Value is a
-- book-value net worth: cash + receivables + contracted backlog + fixed
-- assets − liabilities. Everything but the last two is already derivable from
-- finance_entries / payroll_runs / jobs; the vehicles, tools and loans had no
-- home in the schema. These two tables are that home. The app never stores a
-- computed series — it recomputes from rows on every load — so the tables hold
-- INPUTS only (cost, dates, balances), never derived figures.
--
-- REALTIME. The chart must not go stale: the screen subscribes to
-- postgres_changes on the money tables and refetches (debounced) on any
-- change. Only `messages` was in the `supabase_realtime` publication, so the
-- five money tables are added below. RLS still applies to the change feed —
-- a viewer subscribed to finance_entries receives nothing, exactly as SELECT
-- returns nothing.
--
-- RLS: admin-only on all four verbs via is_company_admin(company), the same
-- shape as voice_routes / comms_settings. Viewers get zero rows.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- Fixed assets at book value (straight-line depreciation is done in the app).
-- ---------------------------------------------------------------------------
create table if not exists public.company_assets (
  id                uuid primary key default gen_random_uuid(),
  company           text not null default 'dc-solar',
  name              text not null,
  category          text not null default 'tool'
                    constraint company_assets_category_check
                    check (category in ('vehicle', 'tool', 'equipment', 'other')),
  purchase_date     date not null,
  cost              numeric(12,2) not null check (cost >= 0),
  /** Years over which the cost is written down. Default set by the app: 5 tools/equipment, 7 vehicles. */
  useful_life_years numeric(4,1) not null default 5 check (useful_life_years > 0),
  salvage_value     numeric(12,2) not null default 0 check (salvage_value >= 0),
  /** Sold / scrapped / lost on this day: contributes nothing from then on. */
  disposed_on       date,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.company_assets is
  'Vehicles, tools and equipment the company owns, at cost. Book value = straight-line '
  'depreciation to the day, computed in the app (lib/valuation.ts). Admin-only.';

drop trigger if exists company_assets_touch on public.company_assets;
create trigger company_assets_touch
  before update on public.company_assets
  for each row execute function public.crm_touch_updated_at();

alter table public.company_assets enable row level security;

drop policy if exists company_assets_admin_select on public.company_assets;
create policy company_assets_admin_select on public.company_assets
  for select using (public.is_company_admin(company));

drop policy if exists company_assets_admin_insert on public.company_assets;
create policy company_assets_admin_insert on public.company_assets
  for insert with check (public.is_company_admin(company));

drop policy if exists company_assets_admin_update on public.company_assets;
create policy company_assets_admin_update on public.company_assets
  for update using (public.is_company_admin(company)) with check (public.is_company_admin(company));

drop policy if exists company_assets_admin_delete on public.company_assets;
create policy company_assets_admin_delete on public.company_assets
  for delete using (public.is_company_admin(company));

-- ---------------------------------------------------------------------------
-- Liabilities: loans, credit lines, anything owed. The balance is a snapshot
-- the owner keeps current; the app subtracts it at face value.
-- ---------------------------------------------------------------------------
create table if not exists public.company_liabilities (
  id              uuid primary key default gen_random_uuid(),
  company         text not null default 'dc-solar',
  name            text not null,
  kind            text not null default 'loan'
                  constraint company_liabilities_kind_check
                  check (kind in ('loan', 'credit', 'other')),
  balance         numeric(12,2) not null check (balance >= 0),
  /** The day `balance` was true. */
  as_of           date not null default current_date,
  monthly_payment numeric(12,2) check (monthly_payment is null or monthly_payment >= 0),
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.company_liabilities is
  'What the company owes (loans, credit). Face-value balance as of a date; subtracted '
  'from company value in the app (lib/valuation.ts). Admin-only.';

drop trigger if exists company_liabilities_touch on public.company_liabilities;
create trigger company_liabilities_touch
  before update on public.company_liabilities
  for each row execute function public.crm_touch_updated_at();

alter table public.company_liabilities enable row level security;

drop policy if exists company_liabilities_admin_select on public.company_liabilities;
create policy company_liabilities_admin_select on public.company_liabilities
  for select using (public.is_company_admin(company));

drop policy if exists company_liabilities_admin_insert on public.company_liabilities;
create policy company_liabilities_admin_insert on public.company_liabilities
  for insert with check (public.is_company_admin(company));

drop policy if exists company_liabilities_admin_update on public.company_liabilities;
create policy company_liabilities_admin_update on public.company_liabilities
  for update using (public.is_company_admin(company)) with check (public.is_company_admin(company));

drop policy if exists company_liabilities_admin_delete on public.company_liabilities;
create policy company_liabilities_admin_delete on public.company_liabilities
  for delete using (public.is_company_admin(company));

-- ---------------------------------------------------------------------------
-- Realtime: the money tables join the publication so the Financials screen
-- can refetch the moment a row changes (lib/financeRealtime.ts).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'finance_entries', 'payroll_runs', 'company_settings',
    'company_assets', 'company_liabilities'
  ] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;

-- Full old-row images so a DELETE reaches subscribers with more than a pk.
alter table public.company_assets replica identity full;
alter table public.company_liabilities replica identity full;

commit;

-- ---------------------------------------------------------------------------
-- PROBE (run separately, rolled back — never as part of the migration):
--
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"email":"<a viewer email>","role":"authenticated"}';
--   select count(*) from public.company_assets;        -- expect 0
--   select count(*) from public.company_liabilities;   -- expect 0
--   insert into public.company_assets (name, purchase_date, cost)
--     values ('probe', current_date, 1);               -- expect 42501
--   rollback;
--
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"email":"<an admin email>","role":"authenticated"}';
--   insert into public.company_assets (name, purchase_date, cost)
--     values ('probe', current_date, 1) returning id;  -- expect a row
--   select count(*) from public.company_assets;        -- expect >= 1
--   rollback;
--
--   select tablename from pg_publication_tables
--    where pubname = 'supabase_realtime' order by 1;   -- expect the five + messages
-- ---------------------------------------------------------------------------
