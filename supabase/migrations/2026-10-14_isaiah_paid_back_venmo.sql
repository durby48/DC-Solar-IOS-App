-- Devon paid Isaiah $1,085.57 by Venmo from the company account on 2026-10-14 (8 receipts).
-- Same shape lib/books.ts payBackOutOfPocket writes (from 'bank'): the rows become one bank
-- line; the Chase "You sent" alert is voided on arrival by finance_entries_void_reimbursement_alert.
begin;
update public.finance_entries set
  paid_from_bank = true,
  description = regexp_replace(description, 'NOT yet reimbursed', 'paid back 2026-10-14 (Venmo)', 'i'),
  extracted = coalesce(extracted, '{}'::jsonb) || jsonb_build_object(
    'reimbursed', true,
    'bank_ref', '2026-10-14|-1085.57|REIMBURSEMENT VENMO',
    'reimbursement', jsonb_build_object('paid_on', '2026-10-14', 'from', 'bank', 'method', 'Venmo', 'total', 1085.57, 'batch', '2026-10-14-isaiah'))
where type = 'expense' and status <> 'void' and not paid_from_bank and not (extracted ? 'reimbursement')
  and occurred_on >= '2026-06-26'
  and (select round(sum(amount), 2) from public.finance_entries
       where type = 'expense' and status <> 'void' and not paid_from_bank and not (extracted ? 'reimbursement')
         and occurred_on >= '2026-06-26') = 1085.57;
commit;
