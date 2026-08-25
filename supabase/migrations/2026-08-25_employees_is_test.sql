-- Mark the two test accounts so the app can hide them from rosters/pickers.
-- (2026-08-25)
--
-- WHY A COLUMN, NOT AN EMAIL-PATTERN FILTER: `employees` is queried from a
-- dozen call sites (hours picker, Employee of the Month, paystubs, payroll,
-- the admin roster, time-off, sales rep list...). Matching on
-- `email ilike '%test%'` in each of those would be one more place to get
-- wrong, and would also hide a real future employee unlucky enough to have
-- "test" in their name. A single boolean, set once, is the one source of
-- truth every query filters on the same way.
--
-- test-crew@dcsolarkc.com (viewer) and test-operator@dcsolarkc.com (operator)
-- stay fully functional logins for checking role-based views — this only
-- controls whether they show up in lists meant for real staff. See
-- supabase/recovery/test-accounts.md.
--
-- Idempotent: safe to re-run.

begin;

alter table public.employees
  add column if not exists is_test boolean not null default false;

comment on column public.employees.is_test is
  'True for accounts that exist only to test role-based views (test-crew@, '
  'test-operator@). Roster/picker queries filter these out; the accounts '
  'still sign in and behave normally. See supabase/recovery/test-accounts.md.';

update public.employees
   set is_test = true
 where email in ('test-crew@dcsolarkc.com', 'test-operator@dcsolarkc.com');

commit;

-- Verify:
--   select email, is_test from public.employees where is_test;
