-- Marketing: reputation + per-platform reach for the Sales tab (2026-08-18).
--
-- WHY THIS EXISTS
--
-- Devon has no idea whether the Google Business Profile, the Facebook page,
-- Instagram, or Yelp are actually bringing work in. Those platforms each have
-- their own dashboard, none of them talk to each other, and none of them are
-- open on a roof. This puts the four of them on one screen next to the sales
-- funnel they feed, so "where did this month's leads come from" has an answer
-- that is not a guess.
--
-- Nothing here is connected yet. Google Business Profile API access has to be
-- requested on a Google Cloud project and approved by Google, and Meta needs a
-- developer app Devon creates — see docs/MARKETING_SETUP.md. The tables land
-- first so the app can be built and tested against them; until a platform is
-- connected the app shows clearly-labelled sample data.
--
-- WHAT IS AND IS NOT SENSITIVE
--
-- Profile views and follower counts are not money. Every company member can
-- read them — the crew hearing "we got 41 calls off Google last month" is a
-- good thing, and unlike finance_entries there is nothing here to leak. Writes
-- are admin-only, because the sync job runs as an admin/service role and a
-- viewer editing review text would be vandalism, not field work.
--
-- OAUTH TOKENS DO NOT LIVE IN marketing_connections. That table is readable by
-- every employee; an access token in it would be readable by every employee
-- too. Tokens go in public.marketing_secrets, which has RLS enabled and ZERO
-- policies — exactly the shape `employees` uses to be structurally
-- write-protected. No client key can read or write it, ever; only the service
-- role (the edge function) can, because the service role bypasses RLS. The
-- alternative is edge-function secrets via the Management API, which is fine
-- for a single fixed location and is what the first GBP connection will use.
--
-- Idempotent: safe to re-run. Seeds nothing.

begin;

-- ---------------------------------------------------------------------------
-- 1. Connections — one row per platform, per company
-- ---------------------------------------------------------------------------
create table if not exists public.marketing_connections (
  company        text not null default 'dc-solar',
  platform       text not null
                   check (platform in ('google_business', 'facebook', 'instagram', 'yelp')),
  status         text not null default 'disconnected'
                   check (status in ('connected', 'disconnected', 'error')),
  -- GBP location resource name ("locations/12345"), Facebook page id,
  -- Instagram business account id, or the Yelp business alias.
  external_id    text,
  -- What to show a human: "DC Solar KC", "@dcsolarkc".
  display_name   text,
  connected_at   timestamptz,
  last_synced_at timestamptz,
  last_error     text,
  primary key (company, platform)
);

comment on table public.marketing_connections is
  'Which marketing platforms are wired up. NO OAuth tokens here — every '
  'company member can read this table. Tokens live in '
  'public.marketing_secrets (service role only) or in edge-function secrets.';

-- ---------------------------------------------------------------------------
-- 2. Secrets — service role ONLY (RLS on, no policies at all)
-- ---------------------------------------------------------------------------
create table if not exists public.marketing_secrets (
  company       text not null default 'dc-solar',
  platform      text not null
                  check (platform in ('google_business', 'facebook', 'instagram', 'yelp')),
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (company, platform)
);

comment on table public.marketing_secrets is
  'OAuth tokens. RLS is enabled with ZERO policies on purpose, the same way '
  'employees is write-protected: no anon or authenticated key can read or '
  'write a row here under any circumstances. Only the service role (the '
  'marketing-sync edge function) touches it.';

-- ---------------------------------------------------------------------------
-- 3. Metrics — daily snapshots, summed over whatever period the app asks for
-- ---------------------------------------------------------------------------
-- Long and thin rather than a column per metric: the platforms keep renaming
-- and retiring metrics (Facebook alone has done it twice), and a new metric
-- should be a new row, not a migration.
create table if not exists public.marketing_metrics (
  company     text not null default 'dc-solar',
  platform    text not null
                check (platform in ('google_business', 'facebook', 'instagram', 'yelp')),
  metric_date date not null,
  metric      text not null,
  value       numeric not null default 0,
  synced_at   timestamptz not null default now(),
  primary key (company, platform, metric_date, metric)
);

create index if not exists marketing_metrics_range_idx
  on public.marketing_metrics (company, platform, metric_date desc);

comment on column public.marketing_metrics.metric is
  'Platform-neutral key the app sums: profile_views_search, profile_views_maps, '
  'website_clicks, calls, direction_requests, messages, page_reach, followers, '
  'post_engagement, reach, profile_visits, rating, review_count.';

-- ---------------------------------------------------------------------------
-- 4. Reviews
-- ---------------------------------------------------------------------------
create table if not exists public.marketing_reviews (
  company     text not null default 'dc-solar',
  platform    text not null
                check (platform in ('google_business', 'facebook', 'instagram', 'yelp')),
  -- The platform's own review id, so a re-sync updates instead of duplicating.
  external_id text not null,
  author_name text,
  rating      int check (rating between 1 and 5),
  comment     text,
  created_at  timestamptz,
  reply       text,
  replied_at  timestamptz,
  synced_at   timestamptz not null default now(),
  primary key (company, platform, external_id)
);

create index if not exists marketing_reviews_recent_idx
  on public.marketing_reviews (company, created_at desc);

-- ---------------------------------------------------------------------------
-- 5. Access
-- ---------------------------------------------------------------------------
-- Read predicate is deliberately the same one `jobs` uses for the crew
-- (jobs_member_select / "jobs company read"): public.is_company_member(company).
-- Reach numbers are not money, and Postgres ORs permissive policies, so keeping
-- to one well-understood predicate is how this stays reviewable.

alter table public.marketing_connections enable row level security;

drop policy if exists marketing_connections_member_select on public.marketing_connections;
create policy marketing_connections_member_select on public.marketing_connections
  for select using (public.is_company_member(company));

drop policy if exists marketing_connections_admin_write on public.marketing_connections;
create policy marketing_connections_admin_write on public.marketing_connections
  for all
  using (public.is_company_admin(company))
  with check (public.is_company_admin(company));

alter table public.marketing_metrics enable row level security;

drop policy if exists marketing_metrics_member_select on public.marketing_metrics;
create policy marketing_metrics_member_select on public.marketing_metrics
  for select using (public.is_company_member(company));

drop policy if exists marketing_metrics_admin_write on public.marketing_metrics;
create policy marketing_metrics_admin_write on public.marketing_metrics
  for all
  using (public.is_company_admin(company))
  with check (public.is_company_admin(company));

alter table public.marketing_reviews enable row level security;

drop policy if exists marketing_reviews_member_select on public.marketing_reviews;
create policy marketing_reviews_member_select on public.marketing_reviews
  for select using (public.is_company_member(company));

drop policy if exists marketing_reviews_admin_write on public.marketing_reviews;
create policy marketing_reviews_admin_write on public.marketing_reviews
  for all
  using (public.is_company_admin(company))
  with check (public.is_company_admin(company));

-- Tokens: RLS on, and NOT ONE POLICY. Do not add one. If a future feature
-- seems to need client access to a token, it needs an edge function instead.
alter table public.marketing_secrets enable row level security;

commit;

-- Verify (expect 6 policies across the three readable tables, 0 on secrets):
--   select tablename, policyname, cmd
--     from pg_policies
--    where schemaname = 'public' and tablename like 'marketing_%'
--    order by tablename, policyname;
--
-- Verify the barrier by SIMULATING a viewer, not by reading the policy above:
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"email":"snettleton2005@gmail.com","role":"authenticated"}';
--   select count(*) from public.marketing_metrics;   -- expect: readable
--   select count(*) from public.marketing_secrets;   -- expect: 0, always
--   insert into public.marketing_connections (platform) values ('yelp'); -- expect: denied
--   rollback;
