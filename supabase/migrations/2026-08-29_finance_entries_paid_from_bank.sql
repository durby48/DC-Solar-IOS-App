-- Whether an expense left the company bank account, vs. petty cash / a card
-- that isn't linked / someone's own money pending reimbursement.
--
-- The Cash Position panel's bank balance auto-adjusts for transactions dated
-- after the last reconciliation (see 2026-08-23's Chase-adjustment work), but
-- only ones tagged as Chase — a manually-recorded expense (a check, a wire, a
-- commission payout) had no way to say "this hit the bank too" and silently
-- never moved the balance. `owedOutOfPocket` on the Financials tab used to
-- infer the opposite case from "NOT yet reimbursed" / "not yet cleared" text
-- in the description; backfilling from that same text preserves today's
-- numbers while this column becomes the source of truth going forward.

begin;

alter table public.finance_entries
  add column if not exists paid_from_bank boolean not null default true;

update public.finance_entries
set paid_from_bank = false
where type = 'expense'
  and description ~* 'NOT yet reimbursed|not yet cleared';

commit;
