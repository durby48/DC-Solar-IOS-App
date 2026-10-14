-- Customer payments that the Chase-email scanner parked on DC-26026 "DC Solar Company"
-- (9/28 – 10/9), assigned to the invoices they paid (Devon, 2026-10-14). Matched by exact
-- invoice amounts on jobs with money owed. Splits are shaped like the 2026-09-10
-- Elevation deposit (lib/documents.ts::splitPayment): the original row becomes the first
-- leg, the other legs are new rows with the same bank_ref and split_of = original id.
-- Still unassigned (left on DC-26026, asked Devon): the 9/24 $300 check, and $300 of the
-- 10/5 SunSmart ACH above its three invoices. Idempotent.
begin;

-- One job per deposit.
update public.finance_entries f set
  job_id = v.job_id::uuid, customer_id = v.customer_id::uuid, counterparty = v.customer,
  description = v.descr,
  extracted = coalesce(f.extracted, '{}'::jsonb) || jsonb_build_object('reconciled', '2026-10-14', 'assigned_from', 'DC-26026'),
  notes = concat_ws(E'\n', f.notes, v.note)
from (values
  ('59fe02e7-4cc8-442d-ac82-f218ed78947a', '88e37f60-d8c5-4f56-bae9-28e98cc133d1', '371cae67-b889-4a7f-81bd-ae8b6a79747c', 'Cromwell Environmental',
   'ACH payment — DC-26023 invoice $2,100', '2026-10-14: was on DC-26026; equals the DC-26023 invoice.'),
  ('79d46fd2-d52b-47a9-87c6-4e790f2f2f91', 'a9a6624d-10c6-45e7-87d9-37a63367b68c', '0ee6d7f9-90df-42dd-94e9-f8c5402eed7c', 'Ken Crum',
   'Check deposit — DC-26006 invoice $14,700', '2026-10-14: was on DC-26026; equals the DC-26006 invoice.'),
  ('f840bc13-1bb4-45f7-b541-e4effd845151', '4e0e9339-d17e-4547-aa44-81da84d45301', '371cae67-b889-4a7f-81bd-ae8b6a79747c', 'Cromwell Environmental',
   'ACH payment — DC-26041 invoice $15,680', '2026-10-14: was on DC-26026; equals the DC-26041 invoice.'),
  ('ef488384-66ce-44c2-bd79-937304bc722b', '415c1a28-f03f-4f1a-a3c9-3fafe4be153a', '54623110-1265-4ed6-8b77-575da5097001', 'Sunrise Exteriors',
   'Check deposit — DC-26036 invoice $3,600', '2026-10-14: was on DC-26026; equals the DC-26036 invoice.')
) as v(id, job_id, customer_id, customer, descr, note)
where f.id = v.id::uuid and f.job_id = 'd043d832-3267-4c1a-91d8-e92404440f47';

-- Cromwell 10/9 ACH $8,080 = DC-26039 $2,275 + DC-26040 $1,575 + DC-26046 $4,230.
update public.finance_entries set
  amount = 2275, job_id = '5630b7f9-2225-4b24-94b7-5556096d082c', customer_id = '371cae67-b889-4a7f-81bd-ae8b6a79747c',
  counterparty = 'Cromwell Environmental', description = 'ACH payment — split to DC-26039',
  extracted = coalesce(extracted, '{}'::jsonb) || jsonb_build_object(
    'bank_ref', '2026-10-09|8080.00|CROMWELL ACH', 'split_of', '41413aa7-51e1-4e66-b482-40c6cbd6d241', 'split_leg', 'DC-26039',
    'split_note', 'one $8,080 Cromwell ACH 10/9: $2,275 DC-26039 + $1,575 DC-26040 + $4,230 DC-26046 (each = its invoice)',
    'reconciled', '2026-10-14', 'assigned_from', 'DC-26026'),
  notes = concat_ws(E'\n', notes, '2026-10-14: was one $8,080 row on DC-26026; split by invoice.')
where id = '41413aa7-51e1-4e66-b482-40c6cbd6d241' and amount = 8080;

-- SunSmart 10/5 ACH $14,230 = DC-26031 $7,130 + DC-26034 $2,300 + DC-26045 $4,500 (= $13,930) + $300 not yet placed.
update public.finance_entries set
  amount = 7130, job_id = '585e4318-e0f6-463b-8769-86fd83a09fef', customer_id = 'a3686ec1-7f80-431b-8014-e484708c7f09',
  counterparty = 'SunSmart', description = 'ACH payment — split to DC-26031',
  extracted = coalesce(extracted, '{}'::jsonb) || jsonb_build_object(
    'bank_ref', '2026-10-05|14230.00|SUNSMART ACH', 'split_of', '8cce88e0-96fb-4b05-bb42-8862acb6a667', 'split_leg', 'DC-26031',
    'split_note', 'one $14,230 SunSmart ACH 10/5: $7,130 DC-26031 + $2,300 DC-26034 + $4,500 DC-26045 (each = its invoice) + $300 left on DC-26026 until Devon places it',
    'reconciled', '2026-10-14', 'assigned_from', 'DC-26026'),
  notes = concat_ws(E'\n', notes, '2026-10-14: was one $14,230 row on DC-26026; split by invoice.')
where id = '8cce88e0-96fb-4b05-bb42-8862acb6a667' and amount = 14230;

insert into public.finance_entries (company, type, direction, amount, currency, counterparty, description, occurred_on, status, customer_id, job_id, paid_from_bank, extracted, notes)
select 'dc-solar', 'payment', 'in', v.amount, 'USD', v.customer, v.descr, v.occurred_on::date, 'recorded', v.customer_id::uuid, v.job_id::uuid, true,
       jsonb_build_object('bank_ref', v.bank_ref, 'split_of', v.split_of, 'split_leg', v.leg, 'split_note', v.split_note,
                          'reconciled', '2026-10-14', 'assigned_from', 'DC-26026', 'source', 'split-2026-10-14'),
       v.note
from (values
  (1575.00, 'Cromwell Environmental', 'ACH payment — split to DC-26040', '2026-10-09', '371cae67-b889-4a7f-81bd-ae8b6a79747c', '60c9908f-fb00-4f34-8f27-fca419a61931',
   '2026-10-09|8080.00|CROMWELL ACH', '41413aa7-51e1-4e66-b482-40c6cbd6d241', 'DC-26040',
   'one $8,080 Cromwell ACH 10/9: $2,275 DC-26039 + $1,575 DC-26040 + $4,230 DC-26046 (each = its invoice)', null),
  (4230.00, 'Cromwell Environmental', 'ACH payment — split to DC-26046', '2026-10-09', '371cae67-b889-4a7f-81bd-ae8b6a79747c', 'da9c6f44-e6a7-4bee-8f21-88d86b0ba565',
   '2026-10-09|8080.00|CROMWELL ACH', '41413aa7-51e1-4e66-b482-40c6cbd6d241', 'DC-26046',
   'one $8,080 Cromwell ACH 10/9: $2,275 DC-26039 + $1,575 DC-26040 + $4,230 DC-26046 (each = its invoice)', null),
  (2300.00, 'SunSmart', 'ACH payment — split to DC-26034', '2026-10-05', 'a3686ec1-7f80-431b-8014-e484708c7f09', '203e3d31-a5fd-4933-be63-41f15864964c',
   '2026-10-05|14230.00|SUNSMART ACH', '8cce88e0-96fb-4b05-bb42-8862acb6a667', 'DC-26034',
   'one $14,230 SunSmart ACH 10/5: $7,130 DC-26031 + $2,300 DC-26034 + $4,500 DC-26045 + $300 left on DC-26026', null),
  (4500.00, 'SunSmart', 'ACH payment — split to DC-26045', '2026-10-05', 'a3686ec1-7f80-431b-8014-e484708c7f09', '050de8ce-5310-4a56-836a-fe092a5d0873',
   '2026-10-05|14230.00|SUNSMART ACH', '8cce88e0-96fb-4b05-bb42-8862acb6a667', 'DC-26045',
   'one $14,230 SunSmart ACH 10/5: $7,130 DC-26031 + $2,300 DC-26034 + $4,500 DC-26045 + $300 left on DC-26026', null),
  (300.00, 'SunSmart', 'ACH payment — $300 over the three SunSmart invoices (which job?)', '2026-10-05', 'a3686ec1-7f80-431b-8014-e484708c7f09', 'd043d832-3267-4c1a-91d8-e92404440f47',
   '2026-10-05|14230.00|SUNSMART ACH', '8cce88e0-96fb-4b05-bb42-8862acb6a667', 'unplaced',
   'one $14,230 SunSmart ACH 10/5: $7,130 DC-26031 + $2,300 DC-26034 + $4,500 DC-26045 + $300 left on DC-26026',
   '2026-10-14: the SunSmart ACH was $300 more than its three open invoices; parked here until Devon says which job.')
) as v(amount, customer, descr, occurred_on, customer_id, job_id, bank_ref, split_of, leg, split_note, note)
where not exists (
  select 1 from public.finance_entries e where e.extracted->>'split_of' = v.split_of and e.extracted->>'split_leg' = v.leg and e.id <> v.split_of::uuid
);

commit;
