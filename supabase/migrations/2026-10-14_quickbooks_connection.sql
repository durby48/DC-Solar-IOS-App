-- QuickBooks Online connection (2026-10-14).
--
-- qbo_connections: one row per company — the QuickBooks company ("realm") the
--   books live in and the OAuth tokens that reach it. Tokens are as sensitive
--   as a password to the books, so NO policy grants any role access: only the
--   service role (the `qbo-oauth` edge function) reads or writes them. The app
--   learns the connection state by asking that function, never from this table.
--
-- qbo_oauth_states: the one-time `state` value handed to Intuit when an admin
--   presses Connect, checked and deleted when Intuit redirects back — proves the
--   callback answers a request this app started (CSRF), and remembers who.
--
-- Idempotent.

begin;

create table if not exists public.qbo_connections (
  company            text primary key,
  realm_id           text not null,
  environment        text not null default 'production' check (environment in ('production', 'sandbox')),
  access_token       text not null,
  access_expires_at  timestamptz not null,
  refresh_token      text not null,
  refresh_expires_at timestamptz,
  company_name       text,
  offering_sku       text,
  connected_by       text,
  connected_at       timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.qbo_connections enable row level security;
revoke all on public.qbo_connections from anon, authenticated;

create table if not exists public.qbo_oauth_states (
  state      text primary key,
  company    text not null,
  email      text not null,
  created_at timestamptz not null default now()
);

alter table public.qbo_oauth_states enable row level security;
revoke all on public.qbo_oauth_states from anon, authenticated;

commit;
