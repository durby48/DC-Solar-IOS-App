-- Undo the 12 h added for Isaiah in 2026-10-14_hours_match_1016_stubs.sql. Every stub since Aug 18 vs the
-- app's hours shows the 10/16 run paid him for hours already logged in earlier periods (8/31–9/13: logged
-- 77.5, paid 60) — adding overhead hours counted them twice (logged 261 vs paid 243 over 8/18–10/9).
begin;
delete from public.employee_hours
where email = 'inettleton18@gmail.com'
  and occurred_on in ('2026-09-30', '2026-10-01')
  and description like 'Paid on the 10/16 Gusto run, not logged%';
commit;
