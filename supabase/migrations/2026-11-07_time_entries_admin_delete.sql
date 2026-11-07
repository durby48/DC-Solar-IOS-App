-- Admins can DELETE clock-in shifts (2026-11-07, Devon: "as the admin, I need
-- to be able to remove his hours, edit them, etc.").
--
-- time_entries has had select / insert / update policies since 2026-07-24 but
-- never a delete policy, so with RLS on, nobody could remove a wrong punch —
-- the 2026-10-13 fix had to "close it at its own clock-in" instead. The Hours
-- tab now edits every entry in place (logged hours AND clock shifts), so an
-- admin needs delete too. Crew still cannot delete anything, including their
-- own punches.
--
-- Location pings cascade with their time entry (on delete cascade, 2026-07-24).
-- Idempotent.

begin;

drop policy if exists te_delete on public.time_entries;
create policy te_delete on public.time_entries for delete
  using (public.is_company_admin(company));

commit;
