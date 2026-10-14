-- Devon, 2026-10-14: delete DC-26007, DC-26022, DC-26044. Their expenses and hours move
-- to company overhead (DC-26026) for him to recategorize; their estimates/invoices are
-- voided (no payments exist on any of them); then the app's own delete_job runs, as Devon.
-- Also: Isaiah's 9/12 $95.24 gas comes off what he is owed (voided, kept for the record).
begin;

update public.finance_entries f set
  job_id = 'd043d832-3267-4c1a-91d8-e92404440f47',
  extracted = coalesce(f.extracted, '{}'::jsonb) || jsonb_build_object('moved_from_job', j.job_number, 'moved_reason', 'job deleted 2026-10-14')
from public.jobs j
where f.job_id = j.id and j.job_number in ('DC-26007', 'DC-26022', 'DC-26044') and f.type = 'expense';

update public.employee_hours h set
  job_id = 'd043d832-3267-4c1a-91d8-e92404440f47',
  description = concat_ws(' · ', h.description, 'was ' || j.job_number || ' (deleted 2026-10-14)')
from public.jobs j
where h.job_id = j.id and j.job_number in ('DC-26007', 'DC-26022', 'DC-26044');

update public.time_entries t set job_id = 'd043d832-3267-4c1a-91d8-e92404440f47'
from public.jobs j
where t.job_id = j.id and j.job_number in ('DC-26007', 'DC-26022', 'DC-26044');

update public.finance_entries f set
  status = 'void',
  extracted = coalesce(f.extracted, '{}'::jsonb) || jsonb_build_object('void_reason', 'job ' || j.job_number || ' deleted 2026-10-14 (Devon)')
from public.jobs j
where f.job_id = j.id and j.job_number in ('DC-26007', 'DC-26022', 'DC-26044')
  and f.type in ('estimate', 'invoice', 'contract') and f.status <> 'void';

update public.finance_entries set
  status = 'void',
  extracted = extracted || jsonb_build_object('void_reason', 'removed from what Isaiah is owed 2026-10-14 (Devon)')
where id = 'e107b8c8-a8e1-4dc8-87d3-c15bd987ac9a';

set local role authenticated;
set local request.jwt.claims = '{"email":"devonsd311@gmail.com","role":"authenticated"}';
select public.delete_job(id, true) from public.jobs where job_number in ('DC-26007', 'DC-26022', 'DC-26044');
reset role;

commit;
