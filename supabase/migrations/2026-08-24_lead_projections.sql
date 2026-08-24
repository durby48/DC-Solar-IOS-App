-- Projections: pre-estimate documents for LEADS in the sales pipeline.
--
-- DELIBERATELY OUTSIDE THE MONEY SYSTEM. A projection never touches
-- finance_entries, never carries a job_id, and appears in no financial
-- rollup — leads have zero financial weight until they are converted and a
-- project (job number) exists. Only then do real estimates begin. The PDF is
-- rendered with the same document pipeline (contracts bucket, admin-only
-- read) but the registry that exposes documents to customers
-- (my_document_paths) never includes these paths.
--
-- Idempotent.

begin;

create table if not exists public.lead_projections (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  company text not null,
  lead_id uuid not null references public.leads(id) on delete cascade,
  -- e.g. DC-P-26001; unique per company.
  number text not null,
  line_items jsonb not null default '[]'::jsonb,
  total numeric not null default 0 check (total >= 0),
  notes text,
  -- contracts/<lead_id>/<number>.pdf once rendered.
  document_path text,
  created_by text,
  unique (company, number)
);

create index if not exists lead_projections_lead_idx
  on public.lead_projections (lead_id);

alter table public.lead_projections enable row level security;

-- Admins do everything. A rep assigned to the lead can READ its projections
-- (same visibility rule as the leads table's own_select policy).
drop policy if exists lead_projections_admin_all on public.lead_projections;
create policy lead_projections_admin_all on public.lead_projections
  for all using (is_company_admin(company)) with check (is_company_admin(company));

drop policy if exists lead_projections_rep_select on public.lead_projections;
create policy lead_projections_rep_select on public.lead_projections
  for select using (
    exists (
      select 1 from public.leads l
      where l.id = lead_projections.lead_id
        and lower(coalesce(l.assigned_to, '')) = lower(coalesce(jwt_email(), ''))
    )
  );

commit;
