-- Ledger corrections from the Chase statement cross-check (Devon, 2026-10-14).
begin;

-- Backup of every row this deletes, kept in the database.
create table if not exists public.finance_entries_deleted_backup (like public.finance_entries);
insert into public.finance_entries_deleted_backup
select * from public.finance_entries
where id in ('c75990f7-2c30-4bbe-92ae-30b17288ce0f', 'a9e00f99-f1ca-4313-94fb-1c0e7a1630c9', '5b75d463-b510-44f3-b25b-e781aae0003b')
  and not exists (select 1 from public.finance_entries_deleted_backup b where b.id = finance_entries.id);
alter table public.finance_entries_deleted_backup enable row level security;
revoke all on public.finance_entries_deleted_backup from anon, authenticated;

-- 1. QT fuel recorded twice: keep the Chase-email entry, move the receipt photo onto it, delete the receipt's entry.
update public.receipts set finance_entry_id = 'bfd8557a-b729-4253-9d2e-ec83501cb4a7' where id = 'fd896f9c-8b33-48e5-bb49-400e6c29e8c5';
update public.receipts set finance_entry_id = '1e8108af-cb99-4d8a-bc40-5d0358e10fc4' where id = 'b465eba8-16b8-4ff2-8b86-6edba10706ce';
update public.finance_entries
   set extracted = coalesce(extracted, '{}'::jsonb) || jsonb_build_object('category', 'fuel', 'receipt_id', 'fd896f9c-8b33-48e5-bb49-400e6c29e8c5', 'bank_ref', '2026-09-23|91.38|QT 201 Independence', 'reconciled', '2026-10-14'),
       description = 'Fuel — QT 201 Independence MO',
       notes = concat_ws(E'\n', notes, '2026-10-14: duplicate receipt entry c75990f7 deleted (Devon); its receipt photo now points here.')
 where id = 'bfd8557a-b729-4253-9d2e-ec83501cb4a7';
update public.finance_entries
   set extracted = coalesce(extracted, '{}'::jsonb) || jsonb_build_object('category', 'fuel', 'receipt_id', 'b465eba8-16b8-4ff2-8b86-6edba10706ce', 'bank_ref', '2026-09-17|92.86|QT 151 Liberty', 'reconciled', '2026-10-14'),
       description = 'Fuel — QT 151 Liberty MO',
       notes = concat_ws(E'\n', notes, '2026-10-14: duplicate receipt entry a9e00f99 deleted (Devon); its receipt photo now points here.')
 where id = '1e8108af-cb99-4d8a-bc40-5d0358e10fc4';
delete from public.finance_entries where id in ('c75990f7-2c30-4bbe-92ae-30b17288ce0f', 'a9e00f99-f1ca-4313-94fb-1c0e7a1630c9');

-- 2. Chase Sapphire $25 card payment: personal, not business — removed.
delete from public.finance_entries where id = '5b75d463-b510-44f3-b25b-e781aae0003b';

-- 3. DC-26002 critter guard $800 cash payment and the $800 cash handed back: never touched the bank.
update public.finance_entries
   set paid_from_bank = false,
       extracted = coalesce(extracted, '{}'::jsonb) || '{"method":"Cash","reconciled":"2026-10-14"}'::jsonb,
       notes = concat_ws(E'\n', notes, '2026-10-14: cash, never deposited — not on the Chase statement.')
 where id in ('3ec57115-5738-4393-b40f-022052b9e443', 'cd9b53bf-cfe1-4c47-b379-9e463539cb03');

-- 4. $95.24 gas 9/12: Isaiah paid it himself.
update public.finance_entries
   set paid_from_bank = false,
       extracted = coalesce(extracted, '{}'::jsonb) || '{"method":"Isaiah personal","reconciled":"2026-10-14"}'::jsonb,
       notes = concat_ws(E'\n', notes, '2026-10-14: paid by Isaiah personally (not on the Chase statement); owed to him.')
 where id = 'e107b8c8-a8e1-4dc8-87d3-c15bd987ac9a';

-- 5. Missing from the app (Chase September statement).
insert into public.finance_entries (company, type, direction, amount, currency, counterparty, description, occurred_on, status, customer_id, job_id, paid_from_bank, extracted, notes)
select 'dc-solar', 'payment', 'in', 6466.31, 'USD', 'Matthew Luck KSS', 'Check deposit', '2026-09-16', 'recorded',
       'c99d3ac7-19bc-46da-84e1-88acb08f4039', 'af5ed7c2-901f-455a-a5fd-2a161ae92cfd', true,
       '{"source":"chase-statement-2026-09","bank_ref":"2026-09-16|6466.31|DEPOSIT 6250017173","reconciled":"2026-10-14"}'::jsonb,
       'Branch check deposit; job confirmed by Devon 2026-10-14.'
where not exists (select 1 from public.finance_entries where extracted->>'bank_ref' = '2026-09-16|6466.31|DEPOSIT 6250017173');

insert into public.finance_entries (company, type, direction, amount, currency, counterparty, description, occurred_on, status, job_id, paid_from_bank, extracted, notes)
select 'dc-solar', 'expense', 'out', 2930.14, 'USD', 'CED Greentech', 'Materials — online vendor payment to CED Greentech', '2026-09-18', 'recorded',
       '60c9908f-fb00-4f34-8f27-fca419a61931', true,
       '{"source":"chase-statement-2026-09","category":"materials","bank_ref":"2026-09-18|-2930.14|ONLINE REALTIME VENDOR PAYMENT CED 9730","reconciled":"2026-10-14"}'::jsonb,
       'Job confirmed by Devon 2026-10-14.'
where not exists (select 1 from public.finance_entries where extracted->>'bank_ref' = '2026-09-18|-2930.14|ONLINE REALTIME VENDOR PAYMENT CED 9730');

insert into public.finance_entries (company, type, direction, amount, currency, counterparty, description, occurred_on, status, job_id, paid_from_bank, extracted, notes)
select 'dc-solar', 'expense', 'out', 21.27, 'USD', 'Summit Grill', 'Meal — DC Solar LLC members meeting', '2026-09-16', 'recorded',
       'd043d832-3267-4c1a-91d8-e92404440f47', true,
       '{"source":"chase-statement-2026-09","category":"meals","bank_ref":"2026-09-16|-21.27|TST* SUMMIT GRILL LEES SUMMIT","reconciled":"2026-10-14"}'::jsonb,
       'Members meeting meal, confirmed by Devon 2026-10-14.'
where not exists (select 1 from public.finance_entries where extracted->>'bank_ref' = '2026-09-16|-21.27|TST* SUMMIT GRILL LEES SUMMIT');

-- 6. Gusto runs (receipts fac77c1c, 07f64415). Dates are the app's pay periods, as the Hours tab records them;
--    gross = net pay + employee taxes, as on the earlier runs.
insert into public.payroll_runs (company, period_start, period_end, payday, gross_wages, total_withdrawn, receipt_id, kind, notes) values
 ('dc-solar', '2026-08-31', '2026-09-13', '2026-09-18', 8452.50, 9333.76, 'fac77c1c-f471-4c98-8eb7-ff58efe97b9e', 'regular',
  'Gusto regular run, 6 people, run 09/03, Gusto period Aug 29 – Sep 11. Net pay 7,153.50 + employee taxes 1,299.00 = gross 8,452.50; Chase withdrawal 9/17 9,333.76.'),
 ('dc-solar', '2026-09-14', '2026-09-27', '2026-10-02', 8114.00, 8963.65, '07f64415-af7e-4d6d-a65a-8f2b199c6216', 'regular',
  'Gusto regular run, 6 people, run 09/12, Gusto period Sep 12 – 25. Net pay 6,819.87 + employee taxes 1,294.13 = gross 8,114.00; withdrawn 8,963.65 (October statement).')
on conflict (company, period_end, receipt_id) do nothing;

update public.company_settings set payroll_through = '2026-09-27'
 where company = 'dc-solar' and (payroll_through is null or payroll_through < '2026-09-27');

commit;
