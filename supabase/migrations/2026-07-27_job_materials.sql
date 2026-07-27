-- Migration 11: per-job materials list + 'materials' document type.
-- Applied directly via the Supabase Management API on 2026-07-27. Re-runnable.
--
-- Materials rows are the itemized list on a job's Materials section —
-- entered manually or extracted from an uploaded supplier PDF by the
-- extract-materials edge function (name + qty only; no pricing).

create table if not exists public.job_materials (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  company text not null default 'dc-solar',
  job_id uuid not null references public.jobs(id),
  name text not null,
  qty numeric not null default 1,
  -- The uploaded PDF the row was extracted from (null = entered manually).
  source_document_id uuid references public.job_documents(id),
  added_by text
);
create index if not exists job_materials_job_idx on public.job_materials (job_id, created_at);

alter table public.job_materials enable row level security;

-- Whole crew can see what materials a job needs; admins manage the list.
drop policy if exists jm_select on public.job_materials;
create policy jm_select on public.job_materials for select
  using (public.is_company_member(company));
drop policy if exists jm_insert on public.job_materials;
create policy jm_insert on public.job_materials for insert
  with check (public.is_company_admin(company));
drop policy if exists jm_update on public.job_materials;
create policy jm_update on public.job_materials for update
  using (public.is_company_admin(company))
  with check (public.is_company_admin(company));
drop policy if exists jm_delete on public.job_materials;
create policy jm_delete on public.job_materials for delete
  using (public.is_company_admin(company));

-- Allow materials PDFs in job_documents.
alter table public.job_documents drop constraint if exists job_documents_doc_type_check;
alter table public.job_documents add constraint job_documents_doc_type_check
  check (doc_type in ('contract','estimate','invoice','permit','photo_report','materials','other'));
