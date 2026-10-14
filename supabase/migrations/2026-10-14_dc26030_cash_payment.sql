-- DC-26030 (Buffalo Bill) was paid in cash, and the cash was not deposited (Devon, 2026-10-14).
-- Dated the job's completion day (2026-09-12) until Devon gives the real date.
begin;
insert into public.finance_entries (company, type, direction, amount, currency, counterparty, description, occurred_on, status, customer_id, job_id, paid_from_bank, extracted, notes)
select 'dc-solar', 'payment', 'in', 2500, 'USD', 'Buffalo Bill', 'Cash payment — not deposited', '2026-09-12', 'recorded',
       '105df840-b1b7-43d6-8ddc-0063288500fa', 'da248f05-82b1-4541-b6d8-b4fa96376666', false,
       '{"method":"Cash","cash_on_hand":true,"source":"devon-2026-10-14"}'::jsonb,
       'Paid in cash; the cash was not deposited to Chase (Devon, 2026-10-14). Date = job completion; confirm.'
where not exists (
  select 1 from public.finance_entries
  where job_id = 'da248f05-82b1-4541-b6d8-b4fa96376666' and type = 'payment' and status <> 'void'
);
commit;
