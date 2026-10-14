-- Hours vs the 10/16 Gusto stubs (Devon, 2026-10-14). Stubs (period Sep 26 – Oct 9): Ben 80, Devon 80,
-- Ethan 49, Garrett 68, Isaiah 80, Simon 68, Tyler 59 → gross 15,413.00 = the receipt.
-- 1. Devon's unlogged 46 h and Isaiah's 12 h go to company overhead (DC-26026) in 8-hour days on the
--    weekdays each had nothing logged.
-- 2. Ben worked 40 h in the week of Oct 5 (Devon): 2.5 h off the 10/5 Pittsburg day (DC-26046), 11 → 8.5.
begin;

insert into public.employee_hours (company, employee, email, job_id, occurred_on, hours, rate, description)
select 'dc-solar', v.employee, v.email, 'd043d832-3267-4c1a-91d8-e92404440f47', v.d::date, v.h, v.rate,
       'Paid on the 10/16 Gusto run, not logged — company overhead (Devon, 2026-10-14)'
from (values
  ('Devon Durbin', 'devonsd311@gmail.com', '2026-09-28', 8, 35),
  ('Devon Durbin', 'devonsd311@gmail.com', '2026-10-01', 8, 35),
  ('Devon Durbin', 'devonsd311@gmail.com', '2026-10-06', 8, 35),
  ('Devon Durbin', 'devonsd311@gmail.com', '2026-10-07', 8, 35),
  ('Devon Durbin', 'devonsd311@gmail.com', '2026-10-08', 8, 35),
  ('Devon Durbin', 'devonsd311@gmail.com', '2026-10-09', 6, 35),
  ('Isaiah Nettleton', 'inettleton18@gmail.com', '2026-09-30', 8, 33),
  ('Isaiah Nettleton', 'inettleton18@gmail.com', '2026-10-01', 4, 33)
) as v(employee, email, d, h, rate)
where not exists (
  select 1 from public.employee_hours e
  where e.email = v.email and e.occurred_on = v.d::date and e.description like 'Paid on the 10/16 Gusto run%'
);

update public.employee_hours set
  hours = 8.5,
  description = concat_ws(' · ', description, '2.5 h overtime removed — Ben worked 40 h that week (Devon, 2026-10-14)')
where id = '849b0462-33d9-4dc5-ab2c-45de82f5d0bd' and hours = 11;

commit;
