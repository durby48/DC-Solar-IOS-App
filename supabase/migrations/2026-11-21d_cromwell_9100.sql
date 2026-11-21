-- 2026-11-21 (Devon): $9,100 deposit today pays DC-26025 ($6,300) + DC-26049 ($2,800).
-- The scanner's row on DC-26026 becomes DC-26025's payment; DC-26049's is added. Silent.
begin;
set local app.silent_notify = 'on';
update public.finance_entries f
   set job_id = j.id, customer_id = j.customer_id, counterparty = 'Cromwell Environmental', amount = 6300,
       description = 'ACH payment — split to DC-26025',
       extracted = coalesce(f.extracted, '{}'::jsonb) || '{"bank_ref":"2026-11-21|9100.00|CROMWELL ACH","placed_by":"devon-2026-11-21"}'::jsonb
  from public.jobs j
 where f.id = 'b8548d10-18d8-401c-9450-8daf30aedc52' and f.amount = 9100 and j.job_number = 'DC-26025' and j.company = 'dc-solar';
insert into public.finance_entries (company, type, direction, amount, counterparty, description, occurred_on, status, job_id, customer_id, paid_from_bank, extracted)
select 'dc-solar', 'payment', 'in', 2800.00, 'Cromwell Environmental', 'ACH payment — split to DC-26049', '2026-11-21', 'recorded', j.id, j.customer_id, true,
       '{"bank_ref":"2026-11-21|9100.00|CROMWELL ACH","source":"devon-2026-11-21"}'::jsonb
  from public.jobs j
 where j.job_number = 'DC-26049' and j.company = 'dc-solar'
   and not exists (select 1 from public.finance_entries p where p.job_id = j.id and p.type = 'payment' and p.status <> 'void');
update public.jobs set stage = 'Complete' where company = 'dc-solar' and job_number in ('DC-26025', 'DC-26049') and stage <> 'Complete';
commit;
