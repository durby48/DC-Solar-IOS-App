-- CRM Phase 4 (2026-09-07): history for jobs.stage and leads.status.
--
-- WHY. Both columns hold only the CURRENT value. The CRM's Activity view
-- could show "Estimate sent" and "Called them" but not "Pending Estimate →
-- Pending Contract, Devon, Sep 4" — the one event a sales pipeline is about.
--
-- WHY TRIGGERS, NOT APP CODE. The app changes stage through
-- `lib/jobs.ts::updateJobStage`, but the dcsolarkc.com ops console writes
-- `jobs.stage` too, and edge functions run as the service role. A log written
-- by the client would miss two of the three writers. An AFTER UPDATE trigger
-- cannot miss a change, whoever makes it.
--
-- WHO. `changed_by` is the caller's JWT email (public.jwt_email()) — the same
-- identity `customer_notes.author_email`, `messages.sent_by` and
-- `leads.assigned_to` use. Service-role writes carry no JWT and record NULL,
-- which the app shows as "system".
--
-- RLS. Read a history row iff you can read the record it belongs to: the
-- policy is `exists (select 1 from jobs …)` / `… from leads …`, and RLS on
-- those tables applies inside the subquery for the calling user — so crew
-- see job history (jobs are member-readable) and only their own leads'
-- history, exactly as today. No client INSERT/UPDATE/DELETE policy at all:
-- the trigger functions are SECURITY DEFINER and are the only writers. A
-- client cannot forge a "Devon moved this to Won" row.
--
-- No backfill. There is no record of past transitions; inventing "created
-- in stage X" rows would be fiction, and the Activity view already shows the
-- job's creation from jobs.created_at.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. job_stage_history
-- ---------------------------------------------------------------------------
create table if not exists public.job_stage_history (
  id         uuid primary key default gen_random_uuid(),
  company    text not null default 'dc-solar',
  job_id     uuid not null references public.jobs(id) on delete cascade,
  from_stage text,
  to_stage   text,
  changed_by text,
  changed_at timestamptz not null default now()
);

create index if not exists job_stage_history_job_idx
  on public.job_stage_history (job_id, changed_at desc);

comment on table public.job_stage_history is
  'Every change to jobs.stage, written by trigger only. changed_by is the '
  'JWT email or NULL for service-role/ops-console writes. See '
  '2026-09-07_stage_history.sql.';

create or replace function public.log_job_stage_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.stage is not null then
      insert into public.job_stage_history (company, job_id, from_stage, to_stage, changed_by)
      values (coalesce(new.company, 'dc-solar'), new.id, null, new.stage, public.jwt_email());
    end if;
    return new;
  end if;
  if new.stage is distinct from old.stage then
    insert into public.job_stage_history (company, job_id, from_stage, to_stage, changed_by)
    values (coalesce(new.company, 'dc-solar'), new.id, old.stage, new.stage, public.jwt_email());
  end if;
  return new;
end;
$$;

revoke all on function public.log_job_stage_change() from public, anon, authenticated;

drop trigger if exists jobs_log_stage_change on public.jobs;
create trigger jobs_log_stage_change
  after insert or update of stage on public.jobs
  for each row execute function public.log_job_stage_change();

alter table public.job_stage_history enable row level security;

drop policy if exists jsh_read_with_job on public.job_stage_history;
create policy jsh_read_with_job on public.job_stage_history
  for select using (
    exists (select 1 from public.jobs j where j.id = job_stage_history.job_id)
  );

-- ---------------------------------------------------------------------------
-- 2. lead_status_history
-- ---------------------------------------------------------------------------
create table if not exists public.lead_status_history (
  id          uuid primary key default gen_random_uuid(),
  company     text not null default 'dc-solar',
  lead_id     uuid not null references public.leads(id) on delete cascade,
  from_status text,
  to_status   text,
  changed_by  text,
  changed_at  timestamptz not null default now()
);

create index if not exists lead_status_history_lead_idx
  on public.lead_status_history (lead_id, changed_at desc);

comment on table public.lead_status_history is
  'Every change to leads.status, written by trigger only. Readable iff the '
  'lead is readable (leads RLS applies inside the policy subquery).';

create or replace function public.log_lead_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.lead_status_history (company, lead_id, from_status, to_status, changed_by)
    values (coalesce(new.company, 'dc-solar'), new.id, null, new.status, public.jwt_email());
    return new;
  end if;
  if new.status is distinct from old.status then
    insert into public.lead_status_history (company, lead_id, from_status, to_status, changed_by)
    values (coalesce(new.company, 'dc-solar'), new.id, old.status, new.status, public.jwt_email());
  end if;
  return new;
end;
$$;

revoke all on function public.log_lead_status_change() from public, anon, authenticated;

drop trigger if exists leads_log_status_change on public.leads;
create trigger leads_log_status_change
  after insert or update of status on public.leads
  for each row execute function public.log_lead_status_change();

alter table public.lead_status_history enable row level security;

drop policy if exists lsh_read_with_lead on public.lead_status_history;
create policy lsh_read_with_lead on public.lead_status_history
  for select using (
    exists (select 1 from public.leads l where l.id = lead_status_history.lead_id)
  );

commit;

-- Verify (rolled-back impersonation, both directions — see CLAUDE.md):
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"email":"devonsd311@gmail.com","role":"authenticated"}';
--   update public.jobs set stage = stage where id = (select id from public.jobs limit 1); -- no-op: no row
--   select count(*) from public.job_stage_history;                 -- admin: readable
--   insert into public.job_stage_history (job_id) values (gen_random_uuid()); -- expect: denied
--   set local request.jwt.claims = '{"email":"test-crew@dcsolarkc.com","role":"authenticated"}';
--   select count(*) from public.lead_status_history;               -- viewer: only own leads (0 today)
--   rollback;
