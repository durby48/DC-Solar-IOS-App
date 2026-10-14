-- Gusto run f3298472 (payday Fri 2026-10-16, status Processing; Gusto period Sep 26 – Oct 9 =
-- the app's Sep 28 – Oct 11): net pay 12,579.67 + employee taxes 2,833.33 = gross 15,413.00;
-- Chase withdrawal 17,883.09 = wages + taxes 16,867.79 + Devon's reimbursement 1,015.30.
-- The run's total_withdrawn excludes the reimbursement (it is not labor); the reimbursement is
-- the S-5 bracket expense below, and the QBO sync puts both on the one payroll journal entry so
-- the single 17,883.09 bank line matches one transaction.
begin;

insert into public.payroll_runs (company, period_start, period_end, payday, gross_wages, total_withdrawn, receipt_id, kind, notes)
values ('dc-solar', '2026-09-28', '2026-10-11', '2026-10-16', 15413.00, 16867.79, 'f3298472-cf61-4ac0-b17d-2bc63a76fee5', 'regular',
  'Gusto regular run, 7 people, run 09/30, Gusto period Sep 26 – Oct 9. Net 12,579.67 + employee taxes 2,833.33 = gross 15,413.00; taxes withdrawn 4,288.12 (employer 1,463.65 on the receipt). Chase withdrawal 17,883.09 includes Devon''s 1,015.30 S-5 reimbursement (finance_entries, paid_via_payroll).')
on conflict (company, period_end, receipt_id) do nothing;

update public.company_settings set payroll_through = '2026-10-11'
 where company = 'dc-solar' and (payroll_through is null or payroll_through < '2026-10-11');

insert into public.finance_entries (company, type, direction, amount, currency, counterparty, description, occurred_on, status, job_id, paid_from_bank, extracted, notes)
select 'dc-solar', 'expense', 'out', 1015.30, 'USD', 'Greentech Renewables',
       'S-5! ProteaBracket ×80 — paid by Devon personally, reimbursed on the 10/16 payroll', '2026-09-28', 'recorded',
       (select id from public.jobs where job_number = 'DC-26006'), true,
       jsonb_build_object(
         'source', 'devon-2026-10-14', 'invoice', '3584-1061501', 'book_account', 'job_materials',
         'book_account_by', 'review', 'reviewed_at', now(), 'reviewed_by', 'devonsd311@gmail.com',
         'bank_desc', 'Greentech Renewables (via Gusto payroll reimbursement)',
         'paid_via_payroll', 'f3298472-cf61-4ac0-b17d-2bc63a76fee5', 'reimbursed', true,
         'reimbursement', jsonb_build_object('paid_on', '2026-10-16', 'from', 'bank', 'method', 'Gusto payroll', 'total', 1015.30, 'batch', 'payroll-f3298472')),
       'Greentech invoice 3584-1061501 (9/28, COD, paid in full by Devon): 80 × S-5! ProteaBracket @ 11.63 = 930.40 + 84.90 = 1,015.30. Reimbursed to Devon in full on the Gusto run paid 10/16.'
where not exists (select 1 from public.finance_entries where extracted->>'invoice' = '3584-1061501');

commit;
