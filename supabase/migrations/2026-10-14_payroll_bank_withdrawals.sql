-- Devon, 2026-10-14:
-- 1. Ben worked and was paid 80 h straight time on the 10/16 run: his 10/5 Pittsburg day goes back to 11 h.
-- 2. Devon's 31 h paid on the 9/18 run (Gusto Aug 29 – Sep 11: paid 50, logged 9) → company overhead,
--    8-hour days on the weekdays he had nothing logged.
-- 3. payroll_runs record the Chase withdrawal each run actually made (date + amount, from the Chase
--    activity export), so the Hours tab shows every period's total company cost as it left the bank.
--    reimbursements = non-wage money in the same withdrawal (Devon's S-5 brackets on the 10/16 run).
begin;

update public.employee_hours set
  hours = 11,
  description = regexp_replace(coalesce(description, ''), '\s*·?\s*2\.5 h overtime removed[^·]*', '')
where id = '849b0462-33d9-4dc5-ab2c-45de82f5d0bd' and hours = 8.5;

insert into public.employee_hours (company, employee, email, job_id, occurred_on, hours, rate, description)
select 'dc-solar', 'Devon Durbin', 'devonsd311@gmail.com', 'd043d832-3267-4c1a-91d8-e92404440f47', v.d::date, v.h, 35,
       'Paid on the 9/18 Gusto run, not logged — company overhead (Devon, 2026-10-14)'
from (values ('2026-09-01', 8), ('2026-09-02', 8), ('2026-09-03', 8), ('2026-09-04', 7)) as v(d, h)
where not exists (
  select 1 from public.employee_hours e
  where e.email = 'devonsd311@gmail.com' and e.occurred_on = v.d::date and e.description like 'Paid on the 9/18 Gusto run%'
);

alter table public.payroll_runs add column if not exists bank_withdrawn_on date;
alter table public.payroll_runs add column if not exists reimbursements numeric not null default 0;
comment on column public.payroll_runs.bank_withdrawn_on is 'Date the Chase withdrawal for this run posted (null = not yet).';
comment on column public.payroll_runs.reimbursements is 'Non-wage money paid in the same Gusto withdrawal (expense reimbursements); Chase withdrawal = total_withdrawn + reimbursements.';

update public.payroll_runs r set bank_withdrawn_on = v.d::date
from (values
  ('27758e4f-d570-4b69-8fba-4aec8ab2f65f', '2026-07-09'),
  ('1a4d35ec-e0ca-49af-b990-0d1a3a86dfff', '2026-07-23'),
  ('fc3c6415-b63e-43ea-8036-758c815ad550', '2026-08-07'),
  ('65640bd2-360d-421f-8ada-4c2997c3f66b', '2026-08-21'),
  ('7d114c83-2063-4190-b746-dda94b22ade4', '2026-09-03'),
  ('baee358c-e36a-4d4f-96de-d8a33a6184ab', '2026-09-11'),
  ('fac77c1c-f471-4c98-8eb7-ff58efe97b9e', '2026-09-17'),
  ('07f64415-af7e-4d6d-a65a-8f2b199c6216', '2026-10-01')
) as v(receipt, d)
where r.receipt_id = v.receipt;

update public.payroll_runs set reimbursements = 1015.30
 where receipt_id = 'f3298472-cf61-4ac0-b17d-2bc63a76fee5';

commit;
