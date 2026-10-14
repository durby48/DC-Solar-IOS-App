-- The 9/18 $2,930.14 CED Greentech payment belongs to DC-26042, not DC-26040 (Devon, 2026-10-14).
begin;
update public.finance_entries set
  job_id = (select id from public.jobs where job_number = 'DC-26042'),
  extracted = extracted || jsonb_build_object('book_account', 'job_materials', 'book_account_by', 'review',
    'reviewed_at', now(), 'reviewed_by', 'devonsd311@gmail.com', 'moved_from_job', 'DC-26040'),
  notes = concat_ws(E'\n', notes, '2026-10-14: moved DC-26040 → DC-26042 (Devon).')
where id = '66a5c2ab-1f31-4840-8e0a-5c3e92b7eeb5'
  and job_id = (select id from public.jobs where job_number = 'DC-26040');
commit;
