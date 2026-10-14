-- 10/6 $5,060 same-day ACH to VGC = Ken Crum's commission on DC-26006 (Basehor R&R) — Devon, 2026-10-14.
begin;
update public.finance_entries set
  job_id = 'a9a6624d-10c6-45e7-87d9-37a63367b68c',
  counterparty = 'Veteran General Contractors (VGC)',
  description = 'Ken Crum sales commission — DC-26006 Basehor R&R (same-day ACH to VGC)',
  extracted = extracted || jsonb_build_object('book_account', 'commissions', 'book_account_by', 'review',
    'reviewed_at', now(), 'reviewed_by', 'devonsd311@gmail.com', 'moved_from_job', 'DC-26026')
where id = '7bae30f7-9425-47ce-89ea-fbf3a4014d51';
commit;
