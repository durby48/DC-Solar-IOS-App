-- Devon's answers to the books review (2026-10-14).
begin;

-- 1. DC-26019: the invoice was reduced as a favour, the customer paid in full ($6,646 + $6,466.31).
--    Invoice total → $13,112.31. The old revision used the first payment as a "discount"
--    (amount 12,646 vs totals.total 6,000); the payment rows already record what was paid.
set local role authenticated;
set local request.jwt.claims = '{"email":"devonsd311@gmail.com","role":"authenticated"}';
select * from public.revise_document(
  p_entry_id          => 'a8717564-fd2e-45f3-99ae-657d4e9d2e63',
  p_line_items        => '[{"qty":1,"name":"Install of 23.4kWDC System with travel","rate":13112.31}]'::jsonb,
  p_amount            => 13112.31,
  p_notes             => null,
  p_occurred_on       => null,
  p_description       => null,
  p_document_meta     => '{"tax":null,"discount":null,"totals":{"tax":0,"total":13112.31,"discount":0,"subtotal":13112.31}}'::jsonb,
  p_document_path     => null,
  p_archive_path      => null,
  p_pdf_state         => 'stale',
  p_file_size         => null,
  p_client_token      => '7a3c1d52-9e04-4b8f-8f21-26019a466310',
  p_expected_revision => null
);
reset role;

-- 2. VAN Meter electrical supply ($1,299.13 + $4,531.63) → DC-26042 job materials.
update public.finance_entries set
  job_id = (select id from public.jobs where job_number = 'DC-26042'),
  extracted = extracted || jsonb_build_object('book_account', 'job_materials', 'book_account_by', 'review',
    'reviewed_at', now(), 'reviewed_by', 'devonsd311@gmail.com', 'moved_from_job', 'DC-26026'),
  notes = concat_ws(E'\n', notes, '2026-10-14: VAN Meter materials for DC-26042 (Devon).')
where id in ('e8995e20-3d1a-4c82-9039-5d4156d42113', 'f94c6045-8d6d-4683-a44f-3d87ca898908');

-- 3. Confirmed as they are: Ken Crum commission (DC-26020), the van ($5,800, part of check #8089).
update public.finance_entries set
  extracted = extracted || jsonb_build_object('reviewed_at', now(), 'reviewed_by', 'devonsd311@gmail.com')
where id in ('d8c925e3-c975-48f1-8d21-85c7403abc9d', '1860140f-e75c-4608-8006-5a68220a671b');

-- 4. HP laptop: kept by the company.
update public.finance_entries set
  description = replace(description, 'Office HP Laptop NEEDS RETURNED', 'Office HP laptop (kept)'),
  extracted = extracted || jsonb_build_object('book_account', 'office', 'book_account_by', 'review',
    'reviewed_at', now(), 'reviewed_by', 'devonsd311@gmail.com'),
  notes = concat_ws(E'\n', notes, '2026-10-14: not being returned — the company keeps it (Devon).')
where id = '830ff71c-b76b-4fc9-bf99-a53360c2fdd7';

-- 5. The 9/14 $4,387 Venmo reimbursed Isaiah's 15 out-of-pocket receipts of 8/20 – 9/11
--    ($4,386.90, rounded up 10¢). Those rows now carry the Venmo's bank_ref (like check #8089),
--    and the $4,387 row becomes the 10¢ rounding so the group equals the bank line.
update public.finance_entries set
  paid_from_bank = true,
  description = replace(description, 'NOT yet reimbursed', 'reimbursed via Venmo 2026-09-14'),
  extracted = extracted || jsonb_build_object('bank_ref', '2026-09-14|-4387.00|VENMO', 'reimbursed', true,
    'reimbursed_via', 'Venmo 2026-09-14 $4,387.00', 'reconciled', '2026-10-14')
where type = 'expense' and status <> 'void'
  and extracted->>'bank_ref' like 'none|%'
  and occurred_on between '2026-08-20' and '2026-09-11'
  and description ilike '%NOT yet reimbursed%';

update public.finance_entries set
  amount = 0.10,
  description = 'Rounding on Venmo reimbursement to Isaiah ($4,387.00 for $4,386.90 of receipts)',
  extracted = extracted || jsonb_build_object('book_account', 'other', 'book_account_by', 'review',
    'reviewed_at', now(), 'reviewed_by', 'devonsd311@gmail.com', 'original_amount', 4387),
  notes = concat_ws(E'\n', notes, '2026-10-14: was a $4,387 expense; it repaid 15 receipts already in the ledger (Devon).')
where id = 'bd8f797d-5c06-4a42-b0ad-f0bd49dfc1ad' and amount = 4387;

commit;
