-- Gusto's pay-period dates are the standard (Devon, 2026-10-14). Since Aug 29 every period is two weeks,
-- SATURDAY → FRIDAY, paid the next Friday: Aug 29 – Sep 11 (Sep 18), Sep 12 – 25 (Oct 2), Sep 26 – Oct 9
-- (Oct 16), Oct 10 – 23 (Oct 30), … The app had them Monday → Sunday (Aug 31 anchor); the recorded runs
-- take Gusto's printed periods, and payroll_through follows the last regular run's Gusto period end.
-- The 9/14 off-cycle run keeps its stub's Aug 31 – Sep 13. Sales-commission periods move to the same
-- cycle (no commission rows exist yet).
begin;

update public.payroll_runs set period_start = '2026-08-29', period_end = '2026-09-11'
 where receipt_id = 'fac77c1c-f471-4c98-8eb7-ff58efe97b9e';
update public.payroll_runs set period_start = '2026-09-12', period_end = '2026-09-25'
 where receipt_id = '07f64415-af7e-4d6d-a65a-8f2b199c6216';
update public.payroll_runs set period_start = '2026-09-26', period_end = '2026-10-09'
 where receipt_id = 'f3298472-cf61-4ac0-b17d-2bc63a76fee5';

update public.company_settings set payroll_through = '2026-10-09', pay_period_anchor = '2026-08-29', pay_period_days = 14
 where company = 'dc-solar';

commit;
