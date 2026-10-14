-- The $2,500 DC-26030 cash payment was kept by Devon personally: an owner draw (Devon, 2026-10-14).
-- Shaped like the 2026-07-02 $800 critter-guard cash returned to Devon.
begin;
insert into public.finance_entries (company, type, direction, amount, currency, counterparty, description, occurred_on, status, job_id, paid_from_bank, extracted, notes)
select 'dc-solar', 'investment', 'out', 2500, 'USD', 'Devon Durbin', 'Owner draw — DC-26030 cash payment kept by Devon', '2026-09-12', 'recorded',
       'd043d832-3267-4c1a-91d8-e92404440f47', false,
       '{"method":"Cash","owner_draw":true,"of_payment_job":"DC-26030","source":"devon-2026-10-14"}'::jsonb,
       'Buffalo Bill paid DC-26030 in cash; Devon kept the cash (owner draw), never deposited.'
where not exists (
  select 1 from public.finance_entries where type = 'investment' and extracted->>'of_payment_job' = 'DC-26030' and status <> 'void'
);
commit;
