-- Migration 2: per-job document uploads (signed contracts, permits, etc.)
-- Run in Supabase dashboard → SQL Editor, same as the first migration. Re-runnable.

create table if not exists public.job_documents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  company text not null default 'dc-solar',
  job_id uuid not null references public.jobs(id),
  doc_type text not null default 'contract' check (doc_type in ('contract','estimate','invoice','permit','photo_report','other')),
  storage_path text not null,
  file_name text not null,
  content_type text,
  size_bytes bigint,
  uploaded_by text not null
);
create index if not exists job_documents_job_idx on public.job_documents (job_id, created_at desc);

alter table public.job_documents enable row level security;
-- Contracts contain pricing → admin-only (owner/operator) for now.
drop policy if exists jd_select on public.job_documents;
create policy jd_select on public.job_documents for select using (public.is_company_admin(company));
drop policy if exists jd_insert on public.job_documents;
create policy jd_insert on public.job_documents for insert
  with check (uploaded_by = public.jwt_email() and public.is_company_admin(company));
drop policy if exists jd_delete on public.job_documents;
create policy jd_delete on public.job_documents for delete using (public.is_company_admin(company));

insert into storage.buckets (id, name, public) values ('contracts', 'contracts', false)
on conflict (id) do nothing;

drop policy if exists "contracts read" on storage.objects;
create policy "contracts read" on storage.objects for select
  using (bucket_id = 'contracts' and public.is_company_admin('dc-solar'));
drop policy if exists "contracts upload" on storage.objects;
create policy "contracts upload" on storage.objects for insert
  with check (bucket_id = 'contracts' and public.is_company_admin('dc-solar'));
