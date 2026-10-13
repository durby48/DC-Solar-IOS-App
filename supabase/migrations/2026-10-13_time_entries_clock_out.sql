-- Crew could clock IN but never clock OUT (2026-10-13, Devon: Ben Nettleton
-- "glitched as clocked in for ages").
--
-- te_update had a USING clause and no WITH CHECK, so Postgres checked the
-- UPDATED row against USING too: `employee = me and clock_out is null`.
-- Clocking out sets clock_out, so the new row always failed ("new row violates
-- row-level security policy for table time_entries") for anyone who is not an
-- admin. Admins (Devon, Isaiah) passed via is_company_admin, which hid it; Ben
-- is the only crew member who ever punched in (2026-09-01) and that shift has
-- been open ever since.
--
-- Fix: an explicit WITH CHECK — the row must still be yours, and a clock-out
-- cannot come before the clock-in. USING is unchanged (only your OPEN punch).
--
-- Ben's stuck punch: none of its time is real (Devon; his logged hours are
-- the real ones and payroll already matches them). It is closed AT its own
-- clock-in, so it counts 0 hours everywhere (every reader skips ms <= 0), and
-- kept, with a note, rather than deleted.
-- Idempotent.

begin;

drop policy if exists te_update on public.time_entries;
create policy te_update on public.time_entries for update
  using (
    -- employee may close their own open entry; admins may edit anything
    (employee = public.jwt_email() and clock_out is null)
    or public.is_company_admin(company)
  )
  with check (
    (employee = public.jwt_email() and (clock_out is null or clock_out >= clock_in))
    or public.is_company_admin(company)
  );

update public.time_entries
   set clock_out = clock_in,
       note = concat_ws('; ', nullif(note, ''), 'VOIDED 2026-10-13: stuck open since Sep 1 (crew could not clock out), not real hours (Devon) — closed at 0 h'),
       edited_by = 'devonsd311@gmail.com'
 where id = '2f3d1acc-368d-4e72-9c48-2032b3595728'
   and clock_out is null;

commit;
