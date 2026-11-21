-- 2026-11-21 (Devon): the two "We've received your Chase Sapphire Preferred Visa payment"
-- alerts are Devon's personal card payments, not customer income (same as the $25 deleted
-- 2026-10-14). Backed up, then deleted. Neither was ever sent to QuickBooks.
begin;
set local app.silent_notify = 'on';
insert into public.finance_entries_deleted_backup
select * from public.finance_entries
 where id in ('4f5c680b-7fd9-432a-ac36-da864e515df9', '69acfe72-3865-42d5-b30f-e6af016465d3')
   and not exists (select 1 from public.finance_entries_deleted_backup b where b.id = finance_entries.id);
delete from public.finance_entries
 where id in ('4f5c680b-7fd9-432a-ac36-da864e515df9', '69acfe72-3865-42d5-b30f-e6af016465d3')
   and description ilike '%Chase Sapphire%';
commit;
