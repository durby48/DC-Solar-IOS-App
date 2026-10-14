-- Devon, 2026-10-14:
-- 1. Ethan Carson's hours for last week (Mon 10/5 – Sun 10/11) match Garrett Nimsgern's exactly
--    (same days, jobs, hours) at Ethan's own rate. Ethan had nothing logged that week.
-- 2. DC-26042 scheduled every work day (Mon–Sat, the schedule has never used Sundays) of last
--    week and this week. Days already past go in without crew pushes; 10/15–10/17 notify as usual.
begin;

insert into public.employee_hours (company, employee, email, customer_id, job_id, occurred_on, hours, rate, description)
select g.company, 'Ethan Carson', 'ethan@warrensburgroofer.com', g.customer_id, g.job_id, g.occurred_on, g.hours,
       (select pay_rate from public.employees where email = 'ethan@warrensburgroofer.com'),
       'Matched to Garrett Nimsgern''s hours (Devon, 2026-10-14)'
from public.employee_hours g
where g.email = 'gnimsgern.2022@gmail.com' and g.occurred_on between '2026-10-05' and '2026-10-11'
  and not exists (
    select 1 from public.employee_hours e
    where e.email = 'ethan@warrensburgroofer.com' and e.occurred_on between '2026-10-05' and '2026-10-11'
  );

-- Past days + today: no push to the crew for days already worked.
set local session_replication_role = replica;
insert into public.job_schedule_dates (company, job_id, work_date, start_time)
select 'dc-solar', j.id, d::date, '08:00'
from public.jobs j, generate_series('2026-10-05'::date, '2026-10-14'::date, '1 day') d
where j.job_number = 'DC-26042' and extract(isodow from d) <> 7
  and not exists (select 1 from public.job_schedule_dates s where s.job_id = j.id and s.work_date = d::date);
set local session_replication_role = origin;

-- The rest of this week: the crew gets the usual "Job scheduled" push.
insert into public.job_schedule_dates (company, job_id, work_date, start_time)
select 'dc-solar', j.id, d::date, '08:00'
from public.jobs j, generate_series('2026-10-15'::date, '2026-10-18'::date, '1 day') d
where j.job_number = 'DC-26042' and extract(isodow from d) <> 7
  and not exists (select 1 from public.job_schedule_dates s where s.job_id = j.id and s.work_date = d::date);

commit;
