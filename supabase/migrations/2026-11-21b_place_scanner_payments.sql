-- 2026-11-21 follow-up: DC-26032 / DC-26038 / DC-26035 payments were already in the app as
-- bank-alert rows parked on DC-26026 (10/15 $4,500, 10/23 $5,600, 10/27 $3,220). The rows
-- 2026-11-21_gusto_runs_and_customer_payments.sql inserted for them duplicated that money:
-- delete those (backup first) and move the alert rows onto their jobs instead.
begin;
set local app.silent_notify = 'on';

insert into public.finance_entries_deleted_backup
select * from public.finance_entries
 where extracted->>'source' = 'qbo-2026-11-21'
   and not exists (select 1 from public.finance_entries_deleted_backup b where b.id = finance_entries.id);
delete from public.finance_entries where extracted->>'source' = 'qbo-2026-11-21';

update public.finance_entries f
   set job_id = j.id, customer_id = j.customer_id, counterparty = coalesce(c.name, f.counterparty),
       description = 'Payment — ' || v.job || ' $' || to_char(f.amount, 'FM999,990.00'),
       extracted = coalesce(f.extracted, '{}'::jsonb) || jsonb_build_object('placed_by', 'devon-2026-11-21', 'qbo_payment_id', v.qbo)
  from (values ('f78993fd-c4d5-413c-9bd1-5becb1085833'::uuid, 'DC-26032', '367'),
               ('a8a4c17b-e4e3-4e2f-b101-2238e093890e'::uuid, 'DC-26038', '381'),
               ('fa4b88fa-c04f-465b-bebf-d3463f86a6b6'::uuid, 'DC-26035', '395')) v(id, job, qbo)
  join public.jobs j on j.job_number = v.job and j.company = 'dc-solar'
  left join public.customers c on c.id = j.customer_id
 where f.id = v.id;

commit;
