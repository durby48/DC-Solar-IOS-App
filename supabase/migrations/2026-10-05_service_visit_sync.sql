-- Keep a booked lead in step with its service visit when an admin moves the
-- visit's stage by hand (2026-10-05, B1).
--
-- mark_service_visit_done() moves the lead to 'visit_done' itself, but an
-- admin can also move a service job between 'Service Call' and 'Complete'
-- with the Pipeline's ‹ › arrows or a stage picker. Without this the lead
-- would still say "Visit booked" for a visit that is done (or the reverse).
--
-- Idempotent: safe to re-run.

begin;

create or replace function public.service_visit_stage_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.job_type, '') not in ('Cleaning', 'Inspection') then
    return new;
  end if;
  if new.stage = 'Complete' and old.stage is distinct from 'Complete' then
    update public.leads set status = 'visit_done'
     where converted_job_id = new.id and status = 'scheduled';
  elsif new.stage = 'Service Call' and old.stage = 'Complete' then
    update public.leads set status = 'scheduled'
     where converted_job_id = new.id and status = 'visit_done';
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_service_visit_stage_sync on public.jobs;
create trigger jobs_service_visit_stage_sync
  after update of stage on public.jobs
  for each row execute function public.service_visit_stage_sync();

commit;
