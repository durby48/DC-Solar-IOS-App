-- Migration 13: per-customer documents (insurance certificates etc.).
-- Applied directly via the Supabase Management API on 2026-07-27. Re-runnable.
--
-- Files live in the admin-only `contracts` bucket under
-- customers/<customer_id>/… (bucket policies from migrations 2 + 10 cover
-- read/insert/update/delete for admins), so the rows are admin-only too.

create table if not exists public.customer_documents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  company text not null default 'dc-solar',
  customer_id uuid not null references public.customers(id),
  doc_type text not null default 'insurance' check (doc_type in ('insurance','other')),
  storage_path text not null,
  file_name text not null,
  content_type text,
  size_bytes bigint,
  uploaded_by text
);
create index if not exists customer_documents_customer_idx
  on public.customer_documents (customer_id, created_at desc);

alter table public.customer_documents enable row level security;

drop policy if exists cd_select on public.customer_documents;
create policy cd_select on public.customer_documents for select
  using (public.is_company_admin(company));
drop policy if exists cd_insert on public.customer_documents;
create policy cd_insert on public.customer_documents for insert
  with check (public.is_company_admin(company));
drop policy if exists cd_delete on public.customer_documents;
create policy cd_delete on public.customer_documents for delete
  using (public.is_company_admin(company));
