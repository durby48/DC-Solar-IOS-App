-- Time off for sales (2026-10-08, Carson): sales reps get Time off and
-- Paystubs in their Settings. Paystubs already read by employee (self) under
-- ed_self_select; time-off requests were insertable only by is_company_member
-- (crew + admins), which excludes sales roles. Any employee may now ask for
-- time off for themselves. Reading stays own-or-admin; approving stays admin.
-- Idempotent.

begin;

drop policy if exists tor_insert on public.time_off_requests;
create policy tor_insert on public.time_off_requests for insert
  with check (employee = public.jwt_email() and public.is_company_staff(company));

commit;
