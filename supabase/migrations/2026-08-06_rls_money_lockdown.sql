-- Close the blanket-read hole on money and pay data (2026-08-06).
--
-- PostgreSQL ORs multiple permissive policies together, so a single broad
-- policy defeats every narrow one on the same table. `finance_entries` and
-- `employee_hours` each had an admin policy AND a "company read" policy that
-- allowed ANY employee row in the company. The admin gate in the UI
-- (`role?.isAdmin`) was therefore the only thing hiding this data: any
-- signed-in crew member could read it straight from the REST API.
--
-- Exposure at the time of the fix: 4 viewer accounts could read all 110
-- finance_entries rows (including $56,617.26 of payments) and all 51
-- employee_hours rows, which carry per-person pay rates.
--
-- What remains after this migration:
--   finance_entries — admin only (fin_admin_select/write/update/delete).
--   employee_hours  — your OWN rows (eh_own_*, hours_select) or admin.
--
-- Deliberately KEPT: `jobs company read` and `customers company read`. Crew
-- genuinely need job details and customer contact info to do field work.
--
-- Idempotent: safe to re-run.

drop policy if exists "finance_entries company read" on public.finance_entries;
drop policy if exists "employee_hours company read" on public.employee_hours;
