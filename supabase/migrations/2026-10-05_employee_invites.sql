-- Employee invite links: an admin invites someone, they set their own
-- password from a link (2026-10-05).
--
-- WHY NOT SUPABASE'S INVITE EMAIL. The project has no custom SMTP, so Auth
-- emails only reach the project's own team (2 an hour), and its sign-in links
-- expire in 10 minutes (mailer_otp_exp = 600) — too short to text a new rep.
-- So DC Solar issues its own links: 7 days, single use.
--
-- THE FLOW (edge functions `employee-access` and `accept-invite`):
--   1. An admin invites name + email + role (sales / viewer / operator —
--      operator only by the owner). `employee-access` writes the employees
--      row (so the account is staff from its first second — see
--      handle_new_auth_user), optional cell / DC Solar number / pay rate, and
--      a row here holding the SHA-256 of a random 32-byte code.
--   2. The admin texts / copies / emails `https://app.dcsolarkc.com/join?code=…`.
--   3. The person opens it, picks a password; `accept-invite` checks the code
--      (unused, unexpired, not revoked), creates the Auth user with that
--      password (or sets it, for a reset), marks the row used, and the page
--      signs them in.
-- "New link" revokes any open link for the email and issues a fresh one —
-- kind 'reset' when they already have a login (the forgot-password path,
-- which email cannot serve today).
--
-- ONLY HASHES ARE STORED; the code itself exists in the link alone. Nobody
-- reads or writes this table from the app: admins see invite status through
-- `employee-access`, which uses the service role. RLS is on with an admin
-- read policy only, so a leaked anon key gets nothing.
--
-- Idempotent: safe to re-run.

begin;

create table if not exists public.employee_invites (
  id           uuid primary key default gen_random_uuid(),
  company      text not null default 'dc-solar',
  email        text not null,
  display_name text,
  kind         text not null default 'invite' check (kind in ('invite', 'reset')),
  token_hash   text not null unique,
  created_by   text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default (now() + interval '7 days'),
  used_at      timestamptz,
  revoked_at   timestamptz
);

create index if not exists employee_invites_email_idx on public.employee_invites (company, lower(email));

comment on table public.employee_invites is
  'DC Solar''s own account-setup / password-reset links (7 days, single use). '
  'token_hash = SHA-256 hex of the code in the link. Written and read only by '
  'the employee-access / accept-invite edge functions.';

alter table public.employee_invites enable row level security;

drop policy if exists employee_invites_admin_select on public.employee_invites;
create policy employee_invites_admin_select on public.employee_invites
  for select using (public.is_company_admin(company));

commit;
