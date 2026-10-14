-- Devon, 2026-10-14: trim Simon, Tyler, Isaiah and Garrett to what Gusto paid. Over Aug 18 – Oct 9 they had
-- logged more than their stubs (Simon +8.5, Tyler +5.5, Isaiah +6, Garrett +2.5), all from the Aug 29 –
-- Sep 11 period (paid 9/18). Trimmed from the entries that looked mis-entered; each keeps a note.
begin;

-- Tyler −5.5: the 5.5 h entry on Sat 8/29 (DC-26005).
delete from public.employee_hours
 where lower(coalesce(email, employee)) = 'tylersisson99@yahoo.com' and occurred_on = '2026-08-29' and hours = 5.5
   and job_id = (select id from public.jobs where job_number = 'DC-26005');

-- Simon −8.5: Sunday 9/6 Oberlin 4 h removed; Fri 9/11 Basehor 8 → 3.5.
delete from public.employee_hours
 where lower(coalesce(email, employee)) = 'snettleton2005@gmail.com' and occurred_on = '2026-09-06' and hours = 4
   and job_id = (select id from public.jobs where job_number = 'DC-26019');
update public.employee_hours set hours = 3.5,
  description = concat_ws(' · ', nullif(description, ''), 'trimmed 8 → 3.5 h to match Gusto (Devon, 2026-10-14)')
 where lower(coalesce(email, employee)) = 'snettleton2005@gmail.com' and occurred_on = '2026-09-11' and hours = 8
   and job_id = (select id from public.jobs where job_number = 'DC-26006');

-- Isaiah −6: the second of his two Mon 8/31 DC-26016 entries, 9.5 → 3.5.
update public.employee_hours set hours = 3.5,
  description = concat_ws(' · ', nullif(description, ''), 'trimmed 9.5 → 3.5 h to match Gusto (Devon, 2026-10-14)')
 where lower(coalesce(email, employee)) = 'inettleton18@gmail.com' and occurred_on = '2026-08-31' and hours = 9.5
   and job_id = (select id from public.jobs where job_number = 'DC-26016');

-- Garrett −2.5: 8/31 9.5 → 8.5, 9/2 14.5 → 13.5 (the crew's hours those days), 9/10 Osage 3 → 2.5.
update public.employee_hours set hours = 8.5,
  description = concat_ws(' · ', nullif(description, ''), 'trimmed 9.5 → 8.5 h to match Gusto (Devon, 2026-10-14)')
 where lower(coalesce(email, employee)) = 'gnimsgern.2022@gmail.com' and occurred_on = '2026-08-31' and hours = 9.5;
update public.employee_hours set hours = 13.5,
  description = concat_ws(' · ', nullif(description, ''), 'trimmed 14.5 → 13.5 h to match Gusto (Devon, 2026-10-14)')
 where lower(coalesce(email, employee)) = 'gnimsgern.2022@gmail.com' and occurred_on = '2026-09-02' and hours = 14.5;
update public.employee_hours set hours = 2.5,
  description = concat_ws(' · ', nullif(description, ''), 'trimmed 3 → 2.5 h to match Gusto (Devon, 2026-10-14)')
 where lower(coalesce(email, employee)) = 'gnimsgern.2022@gmail.com' and occurred_on = '2026-09-10' and hours = 3;

commit;
