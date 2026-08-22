-- Dropbox photo folders, one way into the app.
-- (2026-08-22, Workstream H of the 2026-08 overhaul)
--
-- WHY THIS EXISTS
--
-- Employee of the Month photos and marketing shots live on phones and in
-- Dropbox; the app can only show a picture somebody remembered to upload
-- through the EOM screen. Devon drops files in Dropbox already. This lets a
-- scheduled function walk two Dropbox folders and mirror what it finds into
-- the existing private `job-photos` bucket, so the app has a photo library
-- without anyone changing how they work.
--
-- ONE WAY ONLY. Nothing here ever writes back to Dropbox, and the sync never
-- deletes a storage object: a file that disappears from Dropbox gets
-- archived_at stamped on its media_assets row and the bytes stay put. Losing
-- a marketing photo because someone tidied a Dropbox folder is not a failure
-- mode worth having.
--
-- THE TOKENS TABLE HAS RLS ON AND ZERO POLICIES. READ THIS BEFORE ADDING ONE.
--
-- integration_secrets holds a Dropbox refresh token, which is a permanent key
-- to Devon's files. It is protected exactly the way `employees` and
-- `marketing_secrets` are protected: row level security is enabled and there
-- is not a single policy, so no anon key and no authenticated key can read or
-- write a row under any circumstances. Only the service role — the
-- dropbox-sync edge function — can touch it, because the service role bypasses
-- RLS. This is deliberate and it is not an oversight to fix. If a future
-- feature appears to need a token on the client, it needs an edge function
-- instead. Verified by impersonating the OWNER and expecting zero rows.
--
-- Edge-function secrets were the alternative and are wrong here: the access
-- token expires every four hours and the function has to store the refreshed
-- one, which means writing it back — the Management API secrets endpoint is
-- not a runtime store. Same reasoning as marketing_secrets.
--
-- WHY job-photos AND NOT A NEW BUCKET. `job-photos` is already private and
-- already holds three unrelated prefixes (<jobId>/, customers/, eom/). Files
-- land under eom/library/<id>.<ext> and marketing/<YYYY>/<id>.<ext>. The
-- bucket has no UPDATE policy, so a stable path can only be written by the
-- service role — which is exactly who writes these. Never upload to these
-- prefixes from the client.
--
-- Idempotent: safe to re-run. Seeds the two Dropbox folder rows.

begin;

-- ---------------------------------------------------------------------------
-- 1. integration_secrets — service role ONLY (RLS on, no policies at all)
-- ---------------------------------------------------------------------------
create table if not exists public.integration_secrets (
  company       text not null default 'dc-solar',
  provider      text not null check (provider in ('dropbox')),
  client_id     text,
  client_secret text,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,
  metadata      jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  primary key (company, provider)
);

comment on table public.integration_secrets is
  'OAuth app credentials and refresh tokens for third-party integrations. '
  'RLS IS ENABLED WITH ZERO POLICIES ON PURPOSE — the same shape that makes '
  '`employees` and `marketing_secrets` structurally unreachable. No client '
  'key can read or write this table, not even the owner''s. Only the service '
  'role (the dropbox-sync edge function) can. DO NOT ADD A POLICY HERE.';

-- Not one policy. See the comment above.
alter table public.integration_secrets enable row level security;

-- ---------------------------------------------------------------------------
-- 2. dropbox_folders — what to sync, and where the cursor got to
-- ---------------------------------------------------------------------------
create table if not exists public.dropbox_folders (
  company        text not null default 'dc-solar',
  usage          text not null check (usage in ('eom', 'marketing')),
  -- Dropbox paths are case-preserving but case-insensitive; the API's
  -- path_lower is the stable identifier.
  path_lower     text not null,
  -- Dropbox list_folder cursor. Null means the next sync is a full rescan.
  cursor         text,
  last_synced_at timestamptz,
  last_error     text,
  file_count     int not null default 0,
  primary key (company, usage)
);

insert into public.dropbox_folders (company, usage, path_lower) values
  ('dc-solar', 'eom', '/eom'),
  ('dc-solar', 'marketing', '/marketing')
on conflict (company, usage) do nothing;

comment on table public.dropbox_folders is
  'Sync state per Dropbox folder. Member readable so the crew can see when '
  'photos last came in; admin writable because "Sync now" and cursor '
  'bookkeeping are not field work. Contains no credentials.';

alter table public.dropbox_folders enable row level security;

drop policy if exists df_member_select on public.dropbox_folders;
create policy df_member_select on public.dropbox_folders
  for select using (public.is_company_member(company));

drop policy if exists df_admin_all on public.dropbox_folders;
create policy df_admin_all on public.dropbox_folders
  for all
  using (public.is_company_admin(company))
  with check (public.is_company_admin(company));

-- ---------------------------------------------------------------------------
-- 3. media_assets — the photo library
-- ---------------------------------------------------------------------------
create table if not exists public.media_assets (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  company        text not null default 'dc-solar',
  source         text not null default 'dropbox' check (source in ('dropbox', 'upload')),
  usage          text not null check (usage in ('eom', 'marketing')),
  storage_bucket text not null default 'job-photos',
  storage_path   text not null,
  file_name      text,
  content_type   text,
  size_bytes     bigint,
  width          int,
  height         int,
  -- EXIF capture time when Dropbox reports one, else the client modified
  -- time. Marketing browses by "when was this taken", not "when did we sync".
  taken_at       timestamptz,
  dropbox_id     text,
  dropbox_rev    text,
  dropbox_path   text,
  -- Dropbox's content_hash: the same photo re-uploaded under a new name is
  -- skipped instead of downloaded again.
  content_hash   text,
  caption        text,
  tags           text[] not null default '{}',
  job_id         uuid references public.jobs(id) on delete set null,
  featured       boolean not null default false,
  archived_at    timestamptz,
  uploaded_by    text,
  unique (company, storage_path)
);

-- One row per Dropbox file. Partial because uploads have no dropbox_id and
-- a plain unique constraint would collapse them all onto one null.
create unique index if not exists media_assets_dropbox_id_uq
  on public.media_assets (company, dropbox_id) where dropbox_id is not null;

-- The browse query: this usage, newest first, nothing archived.
create index if not exists media_assets_browse_idx
  on public.media_assets (company, usage, taken_at desc) where archived_at is null;

comment on table public.media_assets is
  'Photo library mirrored from Dropbox (or uploaded in-app). Member SELECT — '
  'these are marketing shots and Employee of the Month photos, not money. '
  'Admin INSERT/UPDATE/DELETE, split per verb; the sync itself runs as the '
  'service role and bypasses all of it.';

alter table public.media_assets enable row level security;

drop policy if exists ma_member_select on public.media_assets;
create policy ma_member_select on public.media_assets
  for select using (public.is_company_member(company));

drop policy if exists ma_admin_insert on public.media_assets;
create policy ma_admin_insert on public.media_assets
  for insert with check (public.is_company_admin(company));

drop policy if exists ma_admin_update on public.media_assets;
create policy ma_admin_update on public.media_assets
  for update
  using (public.is_company_admin(company))
  with check (public.is_company_admin(company));

drop policy if exists ma_admin_delete on public.media_assets;
create policy ma_admin_delete on public.media_assets
  for delete using (public.is_company_admin(company));

commit;

-- Verify (expect 0 policies on integration_secrets — that is the point):
--   select tablename, count(*) from pg_policies
--    where schemaname = 'public'
--      and tablename in ('integration_secrets','dropbox_folders','media_assets')
--    group by tablename;
--
-- Verify the barrier by SIMULATING both a viewer AND the owner:
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"email":"devonsd311@gmail.com","role":"authenticated"}';
--   select count(*) from public.integration_secrets;   -- expect: 0, even here
--   set local request.jwt.claims =
--     '{"email":"snettleton2005@gmail.com","role":"authenticated"}';
--   select count(*) from public.media_assets;          -- expect: readable
--   insert into public.media_assets (usage, storage_path)
--     values ('marketing', 'x');                       -- expect: denied
--   rollback;
--
-- Scheduling: pg_cron is NOT installed on this project (checked 2026-08-22;
-- pg_available_extensions lists 1.6.4, installed_version null). Either
-- `create extension pg_cron` first (it must live in the postgres database and
-- Supabase allows it) or drive dropbox-sync from a Vercel cron hitting the
-- function with x-sync-secret. pg_net 0.20.3 IS installed, so the http POST
-- half of the pg_cron approach already works.
