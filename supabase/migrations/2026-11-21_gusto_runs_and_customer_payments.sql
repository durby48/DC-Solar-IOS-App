-- 2026-11-21 (Devon): Gusto receipts for the 10/30, 11/13 and 11/13 off-cycle runs, and the
-- customer payments the app was missing. Data fix; idempotent; no pushes (app.silent_notify).
--
-- Payroll (from the Chase/Gusto pay receipts Devon uploaded):
--   10/30 regular  64298d52…  Oct 10–23  net 9,842.99 + employee taxes 1,972.26 = gross 11,815.25
--                  (the app had 11,414.00), withdrawn 12,885.70
--   11/13 regular  11b6cf52…  Oct 24–Nov 6  net 10,983.69 + employee taxes 2,329.31 = gross 13,313.00,
--                  withdrawn 14,398.97
--   11/13 off-cycle 71dab78e… Oct 24–Nov 6 "Correction pay" (Devon, Isaiah, Harry)
--                  net 5,468.04 + employee taxes 1,203.96 = gross 6,672.00, wages+taxes withdrawn
--                  7,215.54, plus 690.00 reimbursements = Chase 7,905.54
--   The $690 reimbursement = Isaiah's eight credit-card receipts of 10/22–10/29 ($689.10);
--   the 90¢ over is booked as overhead wages in QuickBooks.
--
-- Payments (all already in the Chase account; nothing here creates bank money twice):
--   11/11 $31,980.89 SunSmart ACH   → DC-26042 (Devon tagged it there in QuickBooks)
--   11/12  $2,100.00 deposit #9040  → DC-26056 (Southern Prosper Construction)
--   11/13 $13,100.00 Cromwell ACH   → DC-26050 $7,000 + DC-26007 $1,600 + DC-26044 $4,500 (Devon)
--   DC-26032 $4,500 (10/15), DC-26038 $5,600 (10/23), DC-26035 $3,220 (10/27): paid in QuickBooks
--   (Payments 367 / 381 / 395) but never recorded in the app.
begin;
set local app.silent_notify = 'on';

-- ---------------------------------------------------------------- payroll runs
update public.payroll_runs
   set gross_wages = 11815.25,
       receipt_id = '64298d52-4be5-4217-84ea-4d1aaa092c23',
       notes = 'Gusto regular run, 7 people, run 10/12, period Oct 10 – 23. Net 9,842.99 + employee taxes 1,972.26 = gross 11,815.25; withdrawn 12,885.70 (receipt uploaded 2026-11-21).'
 where id = '7b02b7e2-85bc-4421-a5d1-7b5fccef8e70';

insert into public.payroll_runs (company, period_start, period_end, payday, gross_wages, total_withdrawn, receipt_id, notes, kind, reimbursements)
select 'dc-solar', '2026-10-24', '2026-11-06', '2026-11-13', 13313.00, 14398.97, '11b6cf52-bbdb-4fbe-b039-1c52b50f9e5f',
       'Gusto regular run, 8 people, run 10/28, period Oct 24 – Nov 6. Net 10,983.69 + employee taxes 2,329.31 = gross 13,313.00; withdrawn 14,398.97 (Chase 11/12).',
       'regular', 0
 where not exists (select 1 from public.payroll_runs where receipt_id = '11b6cf52-bbdb-4fbe-b039-1c52b50f9e5f');

insert into public.payroll_runs (company, period_start, period_end, payday, gross_wages, total_withdrawn, receipt_id, notes, kind, reimbursements)
select 'dc-solar', '2026-10-24', '2026-11-06', '2026-11-13', 6672.00, 7215.54, '71dab78e-3406-479b-89eb-a514eba38827',
       'Gusto off-cycle "Correction pay", 3 people (Devon, Isaiah, Harry), run 11/11, period Oct 24 – Nov 6. Net 5,468.04 + employee taxes 1,203.96 = gross 6,672.00; wages+taxes 7,215.54 + reimbursements 690.00 = Chase 7,905.54 (11/12).',
       'off_cycle', 690.00
 where not exists (select 1 from public.payroll_runs where receipt_id = '71dab78e-3406-479b-89eb-a514eba38827');

update public.company_settings set payroll_through = '2026-11-06'
 where company = 'dc-solar' and (payroll_through is null or payroll_through < '2026-11-06');

-- Isaiah's receipts reimbursed inside the off-cycle run.
update public.finance_entries
   set extracted = coalesce(extracted, '{}'::jsonb) || jsonb_build_object(
         'paid_via_payroll', '71dab78e-3406-479b-89eb-a514eba38827',
         'reimbursed', true,
         'reimbursement', jsonb_build_object('from', 'bank', 'batch', 'payroll-71dab78e', 'total', 689.10, 'method', 'Gusto payroll', 'paid_on', '2026-11-13'),
         'book_account', coalesce(extracted->>'book_account',
           case when description ~* 'gas' then 'fuel'
                when description ~* 'battery' then 'vehicle_repairs'
                else 'supplies' end),
         'book_account_by', coalesce(extracted->>'book_account_by', 'rules-2026-11-21'))
 where id in ('2a60877b-574e-44d7-8c7e-dda04249a025', 'ad56debb-eabd-4fa5-8ed4-1da76a3b51ff',
              '07f69012-1508-4cd5-b05c-5e5fa72474d8', '9e2ecd3a-ed26-4019-a7c4-f178226e1084',
              '9c37071b-dd1b-4dd5-8f53-f9a55d845599', '11d8b859-29b8-4cc9-9deb-0a0273c825f2',
              '049cfa7a-3280-481a-8e8b-1d46bdfd5624', '66ee441b-3994-4655-9249-e1314398649a')
   and extracted->>'paid_via_payroll' is null;

-- ---------------------------------------------------------------- customer payments
-- SunSmart $31,980.89: the scanner's row on DC-26026 moves to DC-26042.
update public.finance_entries f
   set job_id = j.id, customer_id = j.customer_id, counterparty = 'SunSmart',
       description = 'ACH payment — DC-26042 (SunSmart) $31,980.89',
       extracted = coalesce(f.extracted, '{}'::jsonb) || '{"bank_ref":"2026-11-11|31980.89|SUNSMART ACH","bank_desc":"Sunsmart Technol ACH","placed_by":"devon-2026-11-21"}'::jsonb
  from public.jobs j
 where f.id = 'dce098f9-17df-4b1d-8a14-610f853f8148' and j.job_number = 'DC-26042' and j.company = 'dc-solar';

-- Cromwell $13,100: the scanner's row becomes DC-26050 $7,000; two rows added for DC-26007 / DC-26044.
update public.finance_entries f
   set job_id = j.id, customer_id = j.customer_id, counterparty = 'Cromwell Environmental', amount = 7000,
       description = 'ACH payment — split to DC-26050',
       extracted = coalesce(f.extracted, '{}'::jsonb) || '{"bank_ref":"2026-11-13|13100.00|CROMWELL ACH","placed_by":"devon-2026-11-21"}'::jsonb
  from public.jobs j
 where f.id = '5ebdfc0c-dee0-407d-91f8-ab00573a7aec' and j.job_number = 'DC-26050' and j.company = 'dc-solar'
   and f.amount = 13100;

insert into public.finance_entries (company, type, direction, amount, counterparty, description, occurred_on, status, job_id, customer_id, paid_from_bank, extracted)
select 'dc-solar', 'payment', 'in', v.amount, 'Cromwell Environmental', 'ACH payment — split to ' || v.job, '2026-11-13', 'recorded', j.id, j.customer_id, true,
       '{"bank_ref":"2026-11-13|13100.00|CROMWELL ACH","placed_by":"devon-2026-11-21","source":"devon-2026-11-21"}'::jsonb
  from (values ('DC-26007', 1600.00), ('DC-26044', 4500.00)) v(job, amount)
  join public.jobs j on j.job_number = v.job and j.company = 'dc-solar'
 where not exists (select 1 from public.finance_entries p where p.job_id = j.id and p.type = 'payment'
                     and p.extracted->>'bank_ref' = '2026-11-13|13100.00|CROMWELL ACH');

-- Southern Prosper Construction $2,100 (deposit #9040, 11/12).
insert into public.finance_entries (company, type, direction, amount, counterparty, description, occurred_on, status, job_id, customer_id, paid_from_bank, extracted)
select 'dc-solar', 'payment', 'in', 2100.00, 'Southern Prosper Construction', 'Check deposit — DC-26056 invoice $2,100', '2026-11-12', 'recorded', j.id, j.customer_id, true,
       '{"bank_ref":"2026-11-12|2100.00|DEPOSIT 9040","source":"devon-2026-11-21"}'::jsonb
  from public.jobs j
 where j.job_number = 'DC-26056' and j.company = 'dc-solar'
   and not exists (select 1 from public.finance_entries p where p.job_id = j.id and p.type = 'payment' and p.status <> 'void');

-- Paid in QuickBooks, missing in the app.
insert into public.finance_entries (company, type, direction, amount, counterparty, description, occurred_on, status, job_id, customer_id, paid_from_bank, extracted)
select 'dc-solar', 'payment', 'in', v.amount, c.name, 'Payment — ' || v.job || ' (recorded in QuickBooks as Payment ' || v.qbo || ')', v.paid_on::date, 'recorded', j.id, j.customer_id, true,
       jsonb_build_object('source', 'qbo-2026-11-21', 'qbo_payment_id', v.qbo)
  from (values ('DC-26032', 4500.00, '2026-10-15', '367'), ('DC-26038', 5600.00, '2026-10-23', '381'), ('DC-26035', 3220.00, '2026-10-27', '395')) v(job, amount, paid_on, qbo)
  join public.jobs j on j.job_number = v.job and j.company = 'dc-solar'
  left join public.customers c on c.id = j.customer_id
 where not exists (select 1 from public.finance_entries p where p.job_id = j.id and p.type = 'payment' and p.status <> 'void');

-- Paid in full → Complete (DC-26042 is a partial payment on a job still being installed).
update public.jobs set stage = 'Complete'
 where company = 'dc-solar' and job_number in ('DC-26050', 'DC-26007', 'DC-26044', 'DC-26056', 'DC-26032', 'DC-26035', 'DC-26038')
   and stage <> 'Complete';

commit;
