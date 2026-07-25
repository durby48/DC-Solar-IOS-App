-- DC Solar KC field app — new tables extending the existing website/ops schema.
-- Run this in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Safe to re-run: everything is IF NOT EXISTS / ON CONFLICT DO NOTHING.

-- ---------------------------------------------------------------------------
-- Helpers: membership checks based on the existing `employees` table
-- (keyed by login email, with role owner|operator|viewer).
-- ---------------------------------------------------------------------------
create or replace function public.is_company_member(comp text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from employees e
    where e.email = (auth.jwt() ->> 'email') and e.company = comp
  );
$$;

create or replace function public.is_company_admin(comp text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from employees e
    where e.email = (auth.jwt() ->> 'email') and e.company = comp
      and e.role in ('owner', 'operator')
  );
$$;

create or replace function public.jwt_email()
returns text language sql stable as $$ select auth.jwt() ->> 'email' $$;

-- ---------------------------------------------------------------------------
-- Time clock
-- ---------------------------------------------------------------------------
create table if not exists public.time_entries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  company text not null default 'dc-solar',
  employee text not null,                -- login email, matches employees.email
  job_id uuid references public.jobs(id),
  clock_in timestamptz not null,
  clock_in_lat double precision,
  clock_in_lng double precision,
  clock_in_accuracy double precision,
  clock_out timestamptz,
  clock_out_lat double precision,
  clock_out_lng double precision,
  clock_out_accuracy double precision,
  note text,
  edited_by text                          -- admin email when manually adjusted
);
create index if not exists time_entries_employee_idx on public.time_entries (company, employee, clock_in desc);

alter table public.time_entries enable row level security;
drop policy if exists te_select on public.time_entries;
create policy te_select on public.time_entries for select
  using (employee = public.jwt_email() or public.is_company_admin(company));
drop policy if exists te_insert on public.time_entries;
create policy te_insert on public.time_entries for insert
  with check (employee = public.jwt_email() and public.is_company_member(company));
drop policy if exists te_update on public.time_entries;
create policy te_update on public.time_entries for update
  using (
    -- employee may close their own open entry; admins may edit anything
    (employee = public.jwt_email() and clock_out is null)
    or public.is_company_admin(company)
  );

-- ---------------------------------------------------------------------------
-- Location pings (recorded ONLY while clocked in; tied to a time entry)
-- ---------------------------------------------------------------------------
create table if not exists public.location_pings (
  id uuid primary key default gen_random_uuid(),
  company text not null default 'dc-solar',
  employee text not null,
  time_entry_id uuid references public.time_entries(id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  accuracy double precision,
  recorded_at timestamptz not null default now()
);
create index if not exists location_pings_idx on public.location_pings (company, employee, recorded_at desc);

alter table public.location_pings enable row level security;
drop policy if exists lp_select on public.location_pings;
create policy lp_select on public.location_pings for select
  using (employee = public.jwt_email() or public.is_company_admin(company));
drop policy if exists lp_insert on public.location_pings;
create policy lp_insert on public.location_pings for insert
  with check (employee = public.jwt_email() and public.is_company_member(company));

-- ---------------------------------------------------------------------------
-- Job photos (files live in the `job-photos` storage bucket)
-- ---------------------------------------------------------------------------
create table if not exists public.job_photos (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  company text not null default 'dc-solar',
  job_id uuid not null references public.jobs(id),
  storage_path text not null,
  caption text,
  uploaded_by text not null
);
create index if not exists job_photos_job_idx on public.job_photos (job_id, created_at desc);

alter table public.job_photos enable row level security;
drop policy if exists jp_select on public.job_photos;
create policy jp_select on public.job_photos for select using (public.is_company_member(company));
drop policy if exists jp_insert on public.job_photos;
create policy jp_insert on public.job_photos for insert
  with check (uploaded_by = public.jwt_email() and public.is_company_member(company));
drop policy if exists jp_delete on public.job_photos;
create policy jp_delete on public.job_photos for delete using (public.is_company_admin(company));

-- ---------------------------------------------------------------------------
-- Time off
-- ---------------------------------------------------------------------------
create table if not exists public.time_off_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  company text not null default 'dc-solar',
  employee text not null,
  start_date date not null,
  end_date date not null,
  kind text not null default 'unpaid' check (kind in ('unpaid','paid','sick','other')),
  reason text,
  status text not null default 'pending' check (status in ('pending','approved','denied')),
  reviewed_by text,
  reviewed_at timestamptz
);

alter table public.time_off_requests enable row level security;
drop policy if exists tor_select on public.time_off_requests;
create policy tor_select on public.time_off_requests for select
  using (employee = public.jwt_email() or public.is_company_admin(company));
drop policy if exists tor_insert on public.time_off_requests;
create policy tor_insert on public.time_off_requests for insert
  with check (employee = public.jwt_email() and public.is_company_member(company));
drop policy if exists tor_update on public.time_off_requests;
create policy tor_update on public.time_off_requests for update
  using (public.is_company_admin(company));

-- ---------------------------------------------------------------------------
-- Inventory (solar materials)
-- ---------------------------------------------------------------------------
create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  company text not null default 'dc-solar',
  name text not null,
  sku text,
  unit text not null default 'each',
  qty_on_hand numeric not null default 0,
  min_qty numeric,
  notes text
);

create table if not exists public.inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  company text not null default 'dc-solar',
  item_id uuid not null references public.inventory_items(id),
  delta numeric not null,                -- +restock, -used/checked out
  reason text not null check (reason in ('restock','used_on_job','checkout','return','adjustment')),
  job_id uuid references public.jobs(id),
  employee text not null
);
create index if not exists inv_tx_item_idx on public.inventory_transactions (item_id, created_at desc);

alter table public.inventory_items enable row level security;
alter table public.inventory_transactions enable row level security;
drop policy if exists ii_select on public.inventory_items;
create policy ii_select on public.inventory_items for select using (public.is_company_member(company));
drop policy if exists ii_write on public.inventory_items;
create policy ii_write on public.inventory_items for all
  using (public.is_company_admin(company)) with check (public.is_company_admin(company));
drop policy if exists it_select on public.inventory_transactions;
create policy it_select on public.inventory_transactions for select using (public.is_company_member(company));
drop policy if exists it_insert on public.inventory_transactions;
create policy it_insert on public.inventory_transactions for insert
  with check (employee = public.jwt_email() and public.is_company_member(company));

-- Keep qty_on_hand in sync with transactions
create or replace function public.apply_inventory_tx()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update inventory_items set qty_on_hand = qty_on_hand + new.delta where id = new.item_id;
  return new;
end;
$$;
drop trigger if exists inventory_tx_apply on public.inventory_transactions;
create trigger inventory_tx_apply after insert on public.inventory_transactions
  for each row execute function public.apply_inventory_tx();

-- ---------------------------------------------------------------------------
-- Vehicles + tool checklists (1 truck, 1 van)
-- ---------------------------------------------------------------------------
create table if not exists public.vehicles (
  id uuid primary key default gen_random_uuid(),
  company text not null default 'dc-solar',
  name text not null,
  kind text not null check (kind in ('truck','van','other'))
);

create table if not exists public.tool_checklist_items (
  id uuid primary key default gen_random_uuid(),
  company text not null default 'dc-solar',
  vehicle_id uuid not null references public.vehicles(id),
  name text not null,
  sort_order int not null default 0,
  active boolean not null default true
);

create table if not exists public.checklist_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  company text not null default 'dc-solar',
  vehicle_id uuid not null references public.vehicles(id),
  employee text not null,
  run_date date not null default current_date,
  results jsonb not null default '{}'::jsonb,   -- {item_id: true|false}
  missing_count int not null default 0,
  note text
);

alter table public.vehicles enable row level security;
alter table public.tool_checklist_items enable row level security;
alter table public.checklist_runs enable row level security;
drop policy if exists v_select on public.vehicles;
create policy v_select on public.vehicles for select using (public.is_company_member(company));
drop policy if exists v_write on public.vehicles;
create policy v_write on public.vehicles for all
  using (public.is_company_admin(company)) with check (public.is_company_admin(company));
drop policy if exists tci_select on public.tool_checklist_items;
create policy tci_select on public.tool_checklist_items for select using (public.is_company_member(company));
drop policy if exists tci_write on public.tool_checklist_items;
create policy tci_write on public.tool_checklist_items for all
  using (public.is_company_admin(company)) with check (public.is_company_admin(company));
drop policy if exists cr_select on public.checklist_runs;
create policy cr_select on public.checklist_runs for select using (public.is_company_member(company));
drop policy if exists cr_insert on public.checklist_runs;
create policy cr_insert on public.checklist_runs for insert
  with check (employee = public.jwt_email() and public.is_company_member(company));

insert into public.vehicles (company, name, kind) values
  ('dc-solar', 'Truck (2010 Dodge Ram)', 'truck'),
  ('dc-solar', 'Van', 'van')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Storage buckets for photos + receipts (private; app uses signed URLs)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public) values
  ('job-photos', 'job-photos', false),
  ('receipts', 'receipts', false)
on conflict (id) do nothing;

drop policy if exists "field app read media" on storage.objects;
create policy "field app read media" on storage.objects for select
  using (bucket_id in ('job-photos','receipts') and public.is_company_member('dc-solar'));
drop policy if exists "field app upload media" on storage.objects;
create policy "field app upload media" on storage.objects for insert
  with check (bucket_id in ('job-photos','receipts') and public.is_company_member('dc-solar'));
