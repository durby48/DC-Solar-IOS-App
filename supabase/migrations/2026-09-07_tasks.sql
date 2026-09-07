-- CRM Phase 5 (2026-09-07): follow-up tasks.
--
-- A task is "call George back Thursday", "send the Cromwell invoice",
-- "check on the permit" — a title, an optional due date, an optional owner,
-- optionally pinned to a customer, a lead and/or a job. Done is a timestamp
-- (`done_at`), not a boolean, so "done yesterday" is knowable and un-doing is
-- setting it back to NULL.
--
-- SHAPE adapted from Atomic CRM (marmelab/atomic-crm, MIT):
-- tasks(contact_id, text, due_date, done_date, sales_id). Ours differs where
-- DC Solar differs:
--   * `assigned_to` / `created_by` are EMAILS — the identity every existing
--     table uses (`leads.assigned_to`, `customer_notes.author_email`,
--     `job_assignments.email`, `messages.sent_by`), never a free-text name
--     like the legacy `jobs.project_manager`.
--   * `due_at` is nullable: "some day" tasks are real.
--   * A task may hang off a customer, a lead, a job, or nothing at all.
--   * `created_by` defaults from the JWT the way Atomic's sales_id trigger
--     does, but as a column default (same as customer_notes.author_email).
--
-- RLS — NOT Atomic's (theirs is "any authenticated user may do anything").
--   read    admins: every task. Everyone else: tasks assigned to them or
--           created by them. That mirrors leads, where crew see only their
--           own — a task titled "call George about the estimate" must not
--           leak a lead the crew cannot otherwise see.
--   insert  any company member, signed with their own email.
--   update  admins, the assignee, or the creator.
--   delete  admins or the creator.
-- No finance or customer data is exposed to a role that lacks it today: a
-- task row carries a title and ids, and the ids only resolve through the
-- parent tables' own RLS.
--
-- Idempotent: safe to re-run.

begin;

create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  company     text not null default 'dc-solar',
  title       text not null,
  notes       text,
  due_at      timestamptz,
  done_at     timestamptz,
  assigned_to text,
  customer_id uuid references public.customers(id) on delete cascade,
  lead_id     uuid references public.leads(id) on delete cascade,
  job_id      uuid references public.jobs(id) on delete set null,
  created_by  text not null default public.jwt_email(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint tasks_title_not_blank check (length(btrim(title)) > 0)
);

create index if not exists tasks_open_due_idx on public.tasks (company, due_at) where done_at is null;
create index if not exists tasks_customer_idx on public.tasks (customer_id);
create index if not exists tasks_lead_idx     on public.tasks (lead_id);
create index if not exists tasks_assignee_idx on public.tasks (lower(assigned_to));

comment on table public.tasks is
  'CRM follow-up tasks. done_at NULL = open. assigned_to / created_by are '
  'employee emails. See 2026-09-07_tasks.sql for the RLS reasoning.';

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch
  before update on public.tasks
  for each row execute function public.crm_touch_updated_at();

alter table public.tasks enable row level security;

drop policy if exists tasks_select on public.tasks;
create policy tasks_select on public.tasks
  for select using (
    public.is_company_member(company)
    and (
      public.is_company_admin(company)
      or lower(assigned_to) = lower(public.jwt_email())
      or lower(created_by)  = lower(public.jwt_email())
    )
  );

drop policy if exists tasks_insert on public.tasks;
create policy tasks_insert on public.tasks
  for insert with check (
    public.is_company_member(company)
    and lower(created_by) = lower(public.jwt_email())
  );

drop policy if exists tasks_update on public.tasks;
create policy tasks_update on public.tasks
  for update using (
    public.is_company_member(company)
    and (
      public.is_company_admin(company)
      or lower(assigned_to) = lower(public.jwt_email())
      or lower(created_by)  = lower(public.jwt_email())
    )
  ) with check (
    public.is_company_member(company)
    and (
      public.is_company_admin(company)
      or lower(assigned_to) = lower(public.jwt_email())
      or lower(created_by)  = lower(public.jwt_email())
    )
  );

drop policy if exists tasks_delete on public.tasks;
create policy tasks_delete on public.tasks
  for delete using (
    public.is_company_member(company)
    and (public.is_company_admin(company) or lower(created_by) = lower(public.jwt_email()))
  );

commit;

-- Verify (rolled back, both directions):
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"email":"test-crew@dcsolarkc.com","role":"authenticated"}';
--   insert into public.tasks (title, created_by) values ('mine', 'test-crew@dcsolarkc.com');      -- ok
--   insert into public.tasks (title, created_by) values ('forged', 'devonsd311@gmail.com');       -- denied
--   select count(*) from public.tasks;                                                             -- only own
--   set local request.jwt.claims = '{"email":"devonsd311@gmail.com","role":"authenticated"}';
--   select count(*) from public.tasks;                                                             -- all
--   rollback;
