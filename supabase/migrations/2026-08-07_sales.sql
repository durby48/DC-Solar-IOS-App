-- Sales: contracted value, lead pipeline, and per-rep visibility (2026-08-07).
--
-- Three things:
--
--   1. A 'contract' finance type. Estimate is what we quoted, Contracted is
--      what they signed for, Invoiced is what we billed. Those are three
--      different numbers and the middle one had nowhere to live, so
--      estimate→contract conversion was unmeasurable.
--
--   2. jobs.sales_rep_email — who sold the job. Backfilled below.
--
--   3. public.leads — the top of the funnel. Empty for now by design.
--
-- ACCESS, and why it is narrow:
--
-- finance_entries was locked to admin-only on 2026-08-06 after a real leak —
-- four viewer accounts could read every money row, including $56,617 of
-- payments and per-person pay rates. Nothing here reopens that. A sales rep
-- gains read on ESTIMATE and CONTRACT rows, and only for jobs where they are
-- the assigned rep. Payments, invoices, expenses and investments stay
-- admin-only, as do any entries not tied to a job.
--
-- Postgres ORs permissive policies together, which is exactly how the original
-- leak happened: one broad policy defeated every narrow one. The policy added
-- here is therefore written to be additive-but-bounded, and it is the only new
-- read path on this table.
--
-- Admins today are Devon (owner), Isaiah and Clark (operator) — which is
-- already what is_company_admin() returns. Ben, Tyler, Garrett and Simon are
-- viewers. No new role concept was needed.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. Contracted value as a finance entry type
-- ---------------------------------------------------------------------------
alter table public.finance_entries
  drop constraint if exists finance_entries_type_check;

alter table public.finance_entries
  add constraint finance_entries_type_check
  check (type in (
    'estimate', 'contract', 'invoice', 'payment', 'expense', 'investment'
  ));

-- ---------------------------------------------------------------------------
-- 2. Who sold the job
-- ---------------------------------------------------------------------------
alter table public.jobs
  add column if not exists sales_rep_email text;

create index if not exists jobs_sales_rep_idx
  on public.jobs (company, sales_rep_email);

comment on column public.jobs.sales_rep_email is
  'employees.email of the rep who sold this job. Drives the Sales tab and the '
  'per-rep read policy on finance_entries. Null = unattributed (e.g. the '
  'internal Company container).';

-- ---------------------------------------------------------------------------
-- 3. Leads — the top of the funnel
-- ---------------------------------------------------------------------------
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  company text not null default 'dc-solar',
  name text not null,
  phone text,
  email text,
  address text,
  /** Where it came from: referral, website, door knock, roofer, etc. */
  source text,
  status text not null default 'new'
    check (status in ('new', 'contacted', 'estimating', 'won', 'lost')),
  /** employees.email of the rep who owns it. Set by an admin. */
  assigned_to text,
  /** Rough value, for pipeline weighting before an estimate exists. */
  estimated_value numeric(12, 2),
  notes text,
  /** Set when the lead becomes a job, so conversion is measurable. */
  converted_job_id uuid references public.jobs (id) on delete set null,
  lost_reason text,
  created_by text default (auth.jwt() ->> 'email')
);

create index if not exists leads_company_status_idx
  on public.leads (company, status);
create index if not exists leads_assigned_idx
  on public.leads (company, assigned_to);

create or replace function public.leads_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists leads_touch on public.leads;
create trigger leads_touch before update on public.leads
  for each row execute function public.leads_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Access
-- ---------------------------------------------------------------------------

-- Security definer so the policy can look at jobs without depending on the
-- caller's own read access to that row, matching is_company_admin's pattern.
create or replace function public.is_sales_rep_for_job(job uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from jobs j
    where j.id = job
      and j.sales_rep_email is not null
      and lower(j.sales_rep_email) = lower(auth.jwt() ->> 'email')
  );
$$;

alter table public.leads enable row level security;

-- Admins: everything.
drop policy if exists leads_admin_all on public.leads;
create policy leads_admin_all on public.leads for all
  using (public.is_company_admin(company))
  with check (public.is_company_admin(company));

-- Reps: read only the leads assigned to them.
drop policy if exists leads_own_select on public.leads;
create policy leads_own_select on public.leads for select
  using (
    public.is_company_member(company)
    and assigned_to is not null
    and lower(assigned_to) = lower(public.jwt_email())
  );

-- Reps: work their own leads (status, notes) but never reassign one. The WITH
-- CHECK re-asserts ownership on the NEW row, so a rep cannot hand a lead to
-- someone else or take one that isn't theirs.
drop policy if exists leads_own_update on public.leads;
create policy leads_own_update on public.leads for update
  using (
    public.is_company_member(company)
    and assigned_to is not null
    and lower(assigned_to) = lower(public.jwt_email())
  )
  with check (
    public.is_company_member(company)
    and assigned_to is not null
    and lower(assigned_to) = lower(public.jwt_email())
  );

-- Reps: read the estimate and contract on jobs they sold. Nothing else.
drop policy if exists fin_sales_rep_select on public.finance_entries;
create policy fin_sales_rep_select on public.finance_entries for select
  using (
    type in ('estimate', 'contract')
    and job_id is not null
    and public.is_company_member(company)
    and public.is_sales_rep_for_job(job_id)
  );

-- ---------------------------------------------------------------------------
-- 5. Backfill: who sold what
-- ---------------------------------------------------------------------------
-- Isaiah owns the Your Neighborhood Roofer work (DC-26008, DC-26009, DC-26016).
update public.jobs j
   set sales_rep_email = 'inettleton18@gmail.com'
  from public.customers c
 where j.customer_id = c.id
   and j.company = 'dc-solar'
   and c.name = 'Your Neighborhood Roofer';

-- Devon owns everything else that is a real project. The internal Company
-- container is left unattributed — it is overhead, not a sale.
update public.jobs
   set sales_rep_email = 'devonsd311@gmail.com'
 where company = 'dc-solar'
   and sales_rep_email is null
   and coalesce(is_internal, false) = false;

commit;

-- Verify:
--   select coalesce(sales_rep_email,'(unassigned)') as rep, count(*)
--     from public.jobs where company = 'dc-solar'
--    group by 1 order by 2 desc;
-- Expect: devonsd311@ 23, inettleton18@ 3, (unassigned) 1 (the Company job).
