-- Migration 15: admins (owner/operator) manage ALL employee hours.
-- Applied directly via the Supabase Management API on 2026-07-28. Re-runnable.
--
-- Complements migration 14's own-row policies: Devon + Isaiah can add,
-- edit, and delete any employee_hours row (including P&L-import rows with
-- no email). Admin-added rows carry the target employee's email, so the
-- fill trigger still stamps roster display name + pay rate and the entry
-- shows up in that member's own "My hours".

drop policy if exists eh_admin_insert on public.employee_hours;
create policy eh_admin_insert on public.employee_hours for insert
  with check (public.is_company_admin(company));
drop policy if exists eh_admin_update on public.employee_hours;
create policy eh_admin_update on public.employee_hours for update
  using (public.is_company_admin(company))
  with check (public.is_company_admin(company));
drop policy if exists eh_admin_delete on public.employee_hours;
create policy eh_admin_delete on public.employee_hours for delete
  using (public.is_company_admin(company));
