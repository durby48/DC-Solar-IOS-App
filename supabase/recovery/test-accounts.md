# Test accounts (for checking the app as a non-admin)

**CREATED**: viewer `test-crew@dcsolarkc.com` 2026-08-18, operator
`test-operator@dcsolarkc.com` 2026-08-25. Credentials live in
`secrets/test-accounts.txt` on Carson's PC (never in this repo). The operator
account is an ADMIN (`is_company_admin()` covers owner + operator) and therefore
sees all money — that is what it is for. Verified by a
real GoTrue sign-in + REST probes: finance_entries 0, employee_hours 0,
time_entries 0, jobs 30, customers 19, employees = own row only. Purpose: a login
that is a plain `viewer` so we can look at the app the way the crew sees it
(no Financials tab, no money on job cards, no other people's hours) without
ever using an employee's personal account.

Nothing here touches finance data. The account is one more row in
`employees` with `role = 'viewer'`; RLS treats it exactly like Garrett's login.
Columns of `employees` verified 2026-08-18: id, created_at, email, company,
role, display_name, pay_rate — leave pay_rate null.

## Option A — dashboard (2 minutes, no SQL)

1. Supabase → project → **Authentication → Users → Add user → Create new user**
   - Email: `test-crew@dcsolarkc.com` (or any mailbox Devon controls)
   - Password: generate one, store it in `secrets/test-accounts.txt` (outside the repo)
   - Auto-confirm: **on**
2. **Before or right after**, add the roster row so the `handle_new_auth_user`
   trigger classifies it as staff, not a customer (if the auth user was created
   first, the trigger already filed it in `customer_accounts`; delete that row
   after inserting the employee row):

```sql
insert into public.employees (company, display_name, email, role)
values ('dc-solar', 'Test Crew (viewer)', 'test-crew@dcsolarkc.com', 'viewer')
on conflict do nothing;
delete from public.customer_accounts where lower(email) = 'test-crew@dcsolarkc.com';
```

3. Sign in on web / Expo Go with it. Expect: no Financials tab, Pipeline cards
   without page-2 money, Hours shows only its own (empty) rows.

## Option B — SQL only (Management API), if the dashboard is inconvenient

Uses pgcrypto (`crypt` / `gen_salt`) which Supabase ships. Replace `<PASSWORD>`.
Run the employees insert FIRST so the trigger sees a staff match.

```sql
begin;
insert into public.employees (company, display_name, email, role)
values ('dc-solar', 'Test Crew (viewer)', 'test-crew@dcsolarkc.com', 'viewer')
on conflict do nothing;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change)
values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated',
  'authenticated', 'test-crew@dcsolarkc.com', crypt('<PASSWORD>', gen_salt('bf')),
  now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
  '', '', '', '');

insert into auth.identities (id, user_id, provider_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id, u.id::text,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  'email', now(), now(), now()
from auth.users u where u.email = 'test-crew@dcsolarkc.com';
commit;
```

## Removing it

```sql
delete from auth.users where email in ('test-crew@dcsolarkc.com', 'test-operator@dcsolarkc.com');
delete from public.employees where email in ('test-crew@dcsolarkc.com', 'test-operator@dcsolarkc.com');
```

Both roster rows are named so they sort last in the app's people pickers
("Test Crew (viewer)", "ZZ Test (operator)"). `employees` has no `active`
column, so they DO appear in the hours picker, the Everyone chip and the
Employee-of-the-Month picker until deleted.

## Test customer (portal), later

Use the app's own **Invite** button on a CRM customer whose email Devon controls
(the `invite-customer` function links it correctly). Do not hand-insert.
