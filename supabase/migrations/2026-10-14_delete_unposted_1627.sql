-- 9/15 $16.27 Chase debit-card alert that never posted (not on the Sep statement; Devon: delete).
-- Backed up to finance_entries_deleted_backup first.
begin;
insert into public.finance_entries_deleted_backup
select * from public.finance_entries
where id = 'f872d2fd-a192-4610-8f01-74ac4240c95b'
  and not exists (select 1 from public.finance_entries_deleted_backup b where b.id = 'f872d2fd-a192-4610-8f01-74ac4240c95b');
delete from public.finance_entries where id = 'f872d2fd-a192-4610-8f01-74ac4240c95b';
commit;
