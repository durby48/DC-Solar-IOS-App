-- Google / Apple sign-in is for CUSTOMERS. Staff can never get in that way.
-- (2026-08-22, Workstream D of the 2026-08 overhaul)
--
-- WHY THIS EXISTS
--
-- The App Store requires Sign in with Apple wherever a third-party login is
-- offered (4.8), and new customers should be able to reach the portal with one
-- tap instead of a temporary password. Staff must not: the crew app is gated
-- by `employees.role`, staff accounts carry TOTP, and a Google login would
-- route around the password + 6-digit code that protect the money screens.
--
-- TWO GATES, AND THE SECOND ONE IS THE REAL ONE.
--
-- Gate 1 — handle_new_auth_user() on auth.users. It already exists and files
-- non-staff signups into customer_accounts. It now also refuses a NEW staff
-- account created through google/apple. Everything else about it is byte-for-
-- byte what it did before; provider 'email' behaves exactly as it always has.
--
-- Gate 2 — a BEFORE INSERT trigger on auth.identities. This is the
-- authoritative one. When a Google account matches an EXISTING verified
-- auth.users row, GoTrue does identity auto-linking: it inserts a row in
-- auth.identities and never touches auth.users, so the auth.users trigger
-- never fires. Every staff member's account already exists and is verified.
-- Without this trigger, Devon tapping "Continue with Google" would silently
-- link his Google identity to his staff account and sign him straight in.
--
-- BOTH ARE WRITTEN NOT TO BREAK SIGN-IN. The identity trigger returns NEW
-- untouched for every provider except google and apple, and the auth.users
-- lookup is wrapped in an exception block that also returns NEW — a failure to
-- answer "is this staff?" must never lock the whole company out of the app.
-- The only path that raises is the one we mean to raise on.
--
-- Idempotent: safe to re-run. Seeds nothing.

begin;

-- ---------------------------------------------------------------------------
-- 1. Is this address on the roster?
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because both callers are triggers that run as
-- supabase_auth_admin, which has no business reading public.employees, and
-- because `employees` is RLS-protected. Case-insensitive: the roster holds
-- what Devon typed, GoTrue holds what the provider sent.
create or replace function public.oauth_is_staff_email(addr text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.employees e
     where addr is not null
       and e.email is not null
       and lower(e.email) = lower(addr)
  );
$$;

comment on function public.oauth_is_staff_email(text) is
  'True when the address belongs to an employee. Used by the two OAuth gates. '
  'Not granted to anon: it would otherwise be an employee-roster oracle.';

revoke all on function public.oauth_is_staff_email(text) from public, anon;
grant execute on function public.oauth_is_staff_email(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Gate 1 — new auth.users rows
-- ---------------------------------------------------------------------------
-- This is 2026-08-06_customer_portal.sql's function with ONE addition: the
-- provider check inside the existing staff branch. The customer branch
-- (raw_user_meta_data -> customer_id, full_name, invited/pending, on conflict
-- do nothing) is unchanged, and so is the plain-email staff behaviour of
-- returning NEW without filing anything.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  invited_customer uuid;
  v_provider       text;
begin
  if exists (select 1 from public.employees e where lower(e.email) = lower(new.email)) then
    -- Staff. Never auto-filed as a customer — and never created by a social
    -- login. raw_app_meta_data.provider is what GoTrue stamps for the account
    -- as a whole; a missing value means the ordinary email/password flow.
    v_provider := coalesce(new.raw_app_meta_data ->> 'provider', 'email');
    if v_provider in ('google', 'apple') then
      raise exception 'Staff accounts sign in with a password and a 6-digit code, not %', v_provider
        using errcode = '42501';
    end if;
    return new;  -- staff are managed by hand; never auto-file them
  end if;

  begin
    invited_customer := nullif(new.raw_user_meta_data ->> 'customer_id', '')::uuid;
  exception when others then
    invited_customer := null;  -- malformed metadata must not block signup
  end;

  insert into public.customer_accounts (user_id, email, full_name, customer_id, status)
  values (
    new.id,
    new.email,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    invited_customer,
    case when invited_customer is null then 'pending' else 'invited' end
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Gate 2 — auth.identities, where auto-linking actually happens
-- ---------------------------------------------------------------------------
create or replace function public.block_staff_oauth_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  -- Everything that is not a social provider goes straight through: the
  -- 'email' identity written for every ordinary signup, plus anything GoTrue
  -- adds later. A bug in here must not be able to stop people signing in.
  if new.provider is null or new.provider not in ('google', 'apple') then
    return new;
  end if;

  begin
    select u.email into v_email from auth.users u where u.id = new.user_id;
  exception when others then
    return new;  -- cannot answer the question; do not break the login
  end;

  -- Check both the account address and the address the provider asserted.
  -- For auto-linking they are the same by definition, but a staff member
  -- attaching a work Google account to some other user is the case worth
  -- catching.
  if public.oauth_is_staff_email(v_email)
     or public.oauth_is_staff_email(new.identity_data ->> 'email') then
    raise exception 'Staff accounts sign in with a password and a 6-digit code, not %', new.provider
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.block_staff_oauth_identity() is
  'BEFORE INSERT on auth.identities. The authoritative half of the staff '
  'OAuth block: GoTrue auto-links a verified same-email account by inserting '
  'here WITHOUT touching auth.users, so the auth.users trigger never fires.';

drop trigger if exists block_staff_oauth_identity_trg on auth.identities;
create trigger block_staff_oauth_identity_trg
  before insert on auth.identities
  for each row execute function public.block_staff_oauth_identity();

commit;

-- Verify:
--   select tgname, tgrelid::regclass::text from pg_trigger
--    where tgname in ('on_auth_user_created', 'block_staff_oauth_identity_trg');
--
-- Probe BOTH directions inside a rolled-back transaction:
--   begin;
--   -- staff email + google  -> expect 42501
--   insert into auth.identities (user_id, provider_id, identity_data, provider)
--   select u.id, 'g-probe', jsonb_build_object('sub','g-probe','email',u.email), 'google'
--     from auth.users u where u.email = 'devonsd311@gmail.com';
--   rollback;
--
--   begin;
--   -- customer email + google -> expect success
--   insert into auth.identities (user_id, provider_id, identity_data, provider)
--   select u.id, 'g-probe', jsonb_build_object('sub','g-probe','email',u.email), 'google'
--     from auth.users u where u.email = 'isaiah.nettleton@dcsolarkc.com';
--   rollback;
