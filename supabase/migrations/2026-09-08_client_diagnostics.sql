-- Client diagnostics (2026-09-08): what a phone could not tell us.
--
-- WHY. Devon's iPhone does not ring for incoming calls and crashes on a
-- missed-call notification tap, and nothing on the server can say why:
-- `registerForIncomingCalls()` returned its failure to a Home effect that
-- threw it away, and a JS crash on a phone in Kansas City leaves no trace
-- here. This table is the trace: small, structured, self-written, admin-read.
--
-- WHAT GOES IN. One row per event: `kind` ('voice_register',
-- 'voice_invite', 'notification_tap', 'js_error' …), ok/not, a jsonb `detail`
-- the app keeps short (error code/message, identity, target type, route,
-- build/runtime). NEVER a token, a secret, a message body or a customer
-- record — the app's helper enforces the shape and this file documents it.
--
-- RLS. A signed-in company member may insert rows under their own email;
-- admins may read; nothing else. Rows are cheap and disposable — prune with
-- `delete … where created_at < now() - interval '30 days'` when it matters.
--
-- Idempotent: safe to re-run.

begin;

create table if not exists public.client_diagnostics (
  id          uuid primary key default gen_random_uuid(),
  company     text not null default 'dc-solar',
  email       text not null default public.jwt_email(),
  kind        text not null,
  ok          boolean,
  detail      jsonb,
  app_version text,
  runtime     text,
  platform    text,
  created_at  timestamptz not null default now(),
  constraint client_diagnostics_kind_check check (length(kind) between 1 and 40),
  constraint client_diagnostics_detail_size check (detail is null or pg_column_size(detail) < 8192)
);

create index if not exists client_diagnostics_email_idx
  on public.client_diagnostics (email, created_at desc);

comment on table public.client_diagnostics is
  'Structured, non-secret events reported by the app (voice registration, '
  'notification taps, JS errors). Self-insert, admin-read. See '
  '2026-09-08_client_diagnostics.sql.';

alter table public.client_diagnostics enable row level security;

drop policy if exists cd_member_insert on public.client_diagnostics;
create policy cd_member_insert on public.client_diagnostics
  for insert with check (
    public.is_company_member(company)
    and lower(email) = lower(public.jwt_email())
  );

drop policy if exists cd_admin_select on public.client_diagnostics;
create policy cd_admin_select on public.client_diagnostics
  for select using (public.is_company_admin(company));

commit;
