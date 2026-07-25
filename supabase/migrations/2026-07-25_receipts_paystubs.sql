-- Migration 4: receipt review queue + paystub access for the field app.
-- Run in Supabase dashboard → SQL Editor. Re-runnable.

-- ---------------------------------------------------------------------------
-- 1. Receipts: crew submits, admin reviews, approval becomes a finance entry.
--    (Keeps crew from writing directly into finance_entries.)
-- ---------------------------------------------------------------------------
create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  company text not null default 'dc-solar',
  employee text not null,                 -- login email of submitter
  job_id uuid references public.jobs(id),
  amount numeric not null,
  description text not null,
  category text not null default 'materials'
    check (category in ('materials','fuel','tools','supplies','vehicle','meals','other')),
  method text,                            -- how it was paid (debit card, cash, ...)
  needs_reimbursed boolean not null default false,
  storage_path text,                      -- photo/PDF in the 'receipts' bucket
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by text,
  reviewed_at timestamptz,
  finance_entry_id uuid references public.finance_entries(id)
);
create index if not exists receipts_status_idx on public.receipts (company, status, created_at desc);

alter table public.receipts enable row level security;
drop policy if exists rc_select on public.receipts;
create policy rc_select on public.receipts for select
  using (employee = public.jwt_email() or public.is_company_admin(company));
drop policy if exists rc_insert on public.receipts;
create policy rc_insert on public.receipts for insert
  with check (employee = public.jwt_email() and public.is_company_member(company));
drop policy if exists rc_update on public.receipts;
create policy rc_update on public.receipts for update
  using (public.is_company_admin(company));

-- ---------------------------------------------------------------------------
-- 2. Paystubs: each employee sees only their own documents; admins manage all.
--    (employee_documents previously service-role only.)
-- ---------------------------------------------------------------------------
alter table public.employees enable row level security;
drop policy if exists emp_self_select on public.employees;
create policy emp_self_select on public.employees for select
  using (email = public.jwt_email());

alter table public.employee_documents enable row level security;
drop policy if exists ed_self_select on public.employee_documents;
create policy ed_self_select on public.employee_documents for select
  using (
    employee_id in (select id from public.employees where email = public.jwt_email())
    or public.is_company_admin(company)
  );
drop policy if exists ed_admin_write on public.employee_documents;
create policy ed_admin_write on public.employee_documents for insert
  with check (public.is_company_admin(company));
drop policy if exists ed_admin_delete on public.employee_documents;
create policy ed_admin_delete on public.employee_documents for delete
  using (public.is_company_admin(company));

-- Storage: employees read their own folder (<employees.id>/...) in employee-docs;
-- admins read/write everything. App uploads paystubs to '<employee_id>/<file>'.
insert into storage.buckets (id, name, public) values ('employee-docs', 'employee-docs', false)
on conflict (id) do nothing;

drop policy if exists "employee docs read" on storage.objects;
create policy "employee docs read" on storage.objects for select
  using (
    bucket_id = 'employee-docs'
    and (
      public.is_company_admin('dc-solar')
      or (storage.foldername(name))[1] in
         (select id::text from public.employees where email = public.jwt_email())
    )
  );
drop policy if exists "employee docs upload" on storage.objects;
create policy "employee docs upload" on storage.objects for insert
  with check (bucket_id = 'employee-docs' and public.is_company_admin('dc-solar'));
