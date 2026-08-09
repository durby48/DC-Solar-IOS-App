-- Capital invested is neither revenue nor an expense.
--
-- Owner contributions had been recorded as 'expense' with direction 'out'.
-- Both halves of that are wrong: the money came in, not out, and an owner
-- contribution is equity rather than a cost of doing business. Left as
-- expenses they overstate company overhead and make the business look like it
-- spent money it actually received.
--
-- Recording them as 'payment' instead would be wrong in the other direction —
-- payments count as revenue and would inflate every margin. Capital needs its
-- own category.
--
-- The affected rows were corrected by id in a one-off data fix; the specifics
-- are deliberately not recorded here because this repository is public.

begin;

alter table public.finance_entries
  drop constraint if exists finance_entries_type_check;

alter table public.finance_entries
  add constraint finance_entries_type_check
  check (type in ('estimate', 'invoice', 'payment', 'expense', 'investment'));

commit;

-- Convention for capital, relied on by the Financials tab:
--   contribution      type='investment', direction='in'
--   returned to owner type='investment', direction='out'
-- Amounts are always positive, so direction is the only thing separating them.
-- Net them when reporting, or the capital figure double-reports.
