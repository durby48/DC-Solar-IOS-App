-- Capital invested is neither revenue nor an expense.
--
-- Three finance_entries were recorded as 'expense' when they are money the
-- owners put INTO the business:
--
--   21b9d365…  2023-08-04  $1,000.00  "Devon's investment"   (counterparty: Cash deposit)
--   2ad077bd…  2023-08-04  $1,000.00  "Clark's Investment"   (counterparty: Cash deposit)
--   420f780b…  2026-07-02  $2,200.00  "Devon's investment"   (counterparty: Deposit ID 45775)
--
-- $4,200 total, all tagged to the DC Solar Company container job (DC-26026),
-- all with direction 'out'. Two things are wrong with that. The sign is
-- backwards — this money came in, not out. And an owner contribution is
-- equity, not a cost of doing business: left as expenses they overstate
-- company overhead by $4,200 and make the business look like it spent money
-- it actually received.
--
-- Recording them as 'payment' instead would be just as wrong in the other
-- direction — payments are counted as revenue and would inflate every margin.
-- Capital needs its own category, which is what this adds.
--
-- The $2,200 arrived inside a $2,650 bank deposit. The other $450 of that
-- deposit is the Steve Lane panel replacement and is ALREADY recorded
-- correctly against job DC-26001 (invoice f8dddf89… on 2026-06-22, payment
-- 9c219d8d… on 2026-06-26). There is no $2,650 row to split — the deposit was
-- already entered as its two parts. Nothing below touches that $450.
--
-- Run this in the Supabase SQL Editor.

begin;

-- 1. Allow the new category alongside the four the app already uses.
alter table public.finance_entries
  drop constraint if exists finance_entries_type_check;

alter table public.finance_entries
  add constraint finance_entries_type_check
  check (type in ('estimate', 'invoice', 'payment', 'expense', 'investment'));

-- 2. Recategorise exactly those three rows, by id, so nothing else can be
--    caught by accident. `counterparty` becomes who the money came from —
--    it currently says how it arrived, which the description already implies.
update public.finance_entries
   set type = 'investment',
       direction = 'in',
       counterparty = 'Devon Durbin',
       description = 'Owner investment — Devon'
 where id = '21b9d365-797c-4f86-a79d-4abb05e0386f'
   and company = 'dc-solar'
   and amount = 1000;

update public.finance_entries
   set type = 'investment',
       direction = 'in',
       counterparty = 'Clark',
       description = 'Owner investment — Clark'
 where id = '2ad077bd-d008-412e-85da-5ced220f5696'
   and company = 'dc-solar'
   and amount = 1000;

update public.finance_entries
   set type = 'investment',
       direction = 'in',
       counterparty = 'Devon Durbin',
       description = 'Owner investment — Devon (part of $2,650 deposit; the other $450 is DC-26001)'
 where id = '420f780b-d50a-4d6d-8ce1-399af330acbb'
   and company = 'dc-solar'
   and amount = 2200;

commit;

-- Verify: should return exactly 3 rows totalling $4,200, all type=investment
-- and direction=in.
--
--   select occurred_on, type, direction, amount, counterparty, description
--     from public.finance_entries
--    where company = 'dc-solar' and type = 'investment'
--    order by occurred_on;
--
-- And company overhead should drop from $16,766.53 to $12,566.53:
--
--   select sum(amount) from public.finance_entries
--    where company = 'dc-solar' and type = 'expense'
--      and job_id = 'd043d832-3267-4c1a-91d8-e92404440f47';
