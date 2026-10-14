-- The two $300 payments left on DC-26026 after 2026-10-14_assign_overhead_deposits.sql
-- (Devon, 2026-10-14):
--   * 10/5 SunSmart ACH: $300 over the three invoices = a trip fee. Added as a
--     "Trip fee" line on DC-26045 (410 Pine Ridge, Salina) through revise_document,
--     run AS Devon so the revision history and the admin check are the app's own;
--     pdf_state 'stale' so the app offers to re-render the PDF. The $300 leg moves to
--     DC-26045 (paid $4,800 = invoice $4,800).
--   * 9/24 $300 check: an extended solar warranty sold to Fernando Garcia — a new
--     customer record; the payment carries the customer and no job (a warranty is
--     not a job).
begin;

set local role authenticated;
set local request.jwt.claims = '{"email":"devonsd311@gmail.com","role":"authenticated"}';
select * from public.revise_document(
  p_entry_id          => 'e69c5bc6-5e94-4e1e-80ee-d9991c9136ef',
  p_line_items        => '[{"qty":18,"name":"R&R of 18 modules","rate":250},{"qty":1,"name":"Trip fee","rate":300}]'::jsonb,
  p_amount            => 4800,
  p_notes             => null,
  p_occurred_on       => null,
  p_description       => null,
  p_document_meta     => '{"tax":null,"discount":null,"valid_until":null,"totals":{"tax":0,"total":4800,"discount":0,"subtotal":4800},"customer_snapshot":{"name":"SunSmart","email":"austinf@sunsmartusa.com","phone":"8165894310","address":"1280 Liberty St #1FL, Kansas City, MO 64102"}}'::jsonb,
  p_document_path     => null,
  p_archive_path      => null,
  p_pdf_state         => 'stale',
  p_file_size         => null,
  p_client_token      => '5d8f0c1e-2b7a-4c39-9a51-300feeb10045',
  p_expected_revision => null
);
reset role;

update public.finance_entries set
  job_id = '050de8ce-5310-4a56-836a-fe092a5d0873',
  description = 'ACH payment — split to DC-26045 (trip fee)',
  extracted = extracted || '{"split_leg":"DC-26045 trip fee"}'::jsonb,
  notes = concat_ws(E'\n', notes, '2026-10-14: trip fee added to the DC-26045 invoice (Devon); leg moved there.')
where extracted->>'split_of' = '8cce88e0-96fb-4b05-bb42-8862acb6a667' and extracted->>'split_leg' = 'unplaced';

insert into public.customers (company, name, notes)
select 'dc-solar', 'Fernando Garcia', 'Bought an extended solar warranty — $300 check deposited 2026-09-24 (Devon, 2026-10-14).'
where not exists (select 1 from public.customers where company = 'dc-solar' and name = 'Fernando Garcia');

update public.finance_entries set
  job_id = null,
  customer_id = (select id from public.customers where company = 'dc-solar' and name = 'Fernando Garcia'),
  counterparty = 'Fernando Garcia',
  description = 'Extended solar warranty — check deposit',
  extracted = coalesce(extracted, '{}'::jsonb) || '{"reconciled":"2026-10-14","assigned_from":"DC-26026","category":"warranty","bank_ref":"2026-09-24|300.00|REMOTE ONLINE DEPOSIT # 1"}'::jsonb,
  notes = concat_ws(E'\n', notes, '2026-10-14: extended warranty sold to Fernando Garcia (Devon); was on DC-26026.')
where id = '289d1f39-043e-4a63-824d-958cc4f38c53';

commit;
