-- Out-of-pocket pay-backs (2026-10-14): when Devon records "paid back $X from Chase"
-- in Financials → Profit → cash, the expense rows themselves become the bank line
-- (extracted.reimbursement + bank_ref). The Chase "You sent $X" alert the email
-- scanner logs afterwards would count the same money a second time, so it is voided
-- on arrival when a pay-back of the same total was recorded within 3 days before /
-- 5 days after. (An alert that arrived first is voided by the app when the pay-back
-- is recorded — lib/books.ts payBackOutOfPocket.)
begin;

create or replace function public.void_reimbursement_alert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.type = 'expense'
     and coalesce(new.status, '') <> 'void'
     and new.extracted->>'source' = 'email-scanner'
     and exists (
       select 1 from public.finance_entries r
       where r.company = new.company
         and r.status <> 'void'
         and r.extracted ? 'reimbursement'
         and r.extracted->'reimbursement'->>'from' = 'bank'
         and (r.extracted->'reimbursement'->>'total')::numeric = new.amount
         and new.occurred_on between ((r.extracted->'reimbursement'->>'paid_on')::date - 3)
                                 and ((r.extracted->'reimbursement'->>'paid_on')::date + 5)
     )
  then
    new.status := 'void';
    new.extracted := coalesce(new.extracted, '{}'::jsonb)
      || jsonb_build_object('void_reason', 'bank side of an out-of-pocket pay-back already recorded');
  end if;
  return new;
end;
$$;

drop trigger if exists finance_entries_void_reimbursement_alert on public.finance_entries;
create trigger finance_entries_void_reimbursement_alert
  before insert on public.finance_entries
  for each row execute function public.void_reimbursement_alert();

commit;
