-- Customer accounts + self-signup classification (2026-08-06).
--
-- Rule set by Devon: `public.employees` is granted EXCLUSIVELY by Devon or
-- Isaiah. Every account that creates itself is a CUSTOMER, and customers get
-- no access to anything for now — their portal is a later project.
--
-- Why this is safe: `employees` has RLS enabled and ZERO insert/update/delete
-- policies, so no client key can ever write to it — only the service role
-- (dashboard / edge function) can. Signing up therefore cannot grant staff
-- access no matter what the client sends.
--
-- Idempotent: safe to re-run.

create table if not exists public.customer_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  -- Set by an admin later to tie this login to a CRM customer record.
  customer_id uuid references public.customers(id) on delete set null,
  -- pending = signed up, not yet linked/approved by an admin.
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customer_accounts_email_idx on public.customer_accounts (lower(email));

alter table public.customer_accounts enable row level security;

-- A customer may read ONLY their own row. Nothing else in the schema grants
-- them anything, which is the intended "no access to a single thing".
drop policy if exists ca_self_select on public.customer_accounts;
create policy ca_self_select on public.customer_accounts for select
  using (user_id = auth.uid());

drop policy if exists ca_admin_select on public.customer_accounts;
create policy ca_admin_select on public.customer_accounts for select
  using (public.is_company_admin('dc-solar'));

drop policy if exists ca_admin_update on public.customer_accounts;
create policy ca_admin_update on public.customer_accounts for update
  using (public.is_company_admin('dc-solar'))
  with check (public.is_company_admin('dc-solar'));

drop policy if exists ca_admin_delete on public.customer_accounts;
create policy ca_admin_delete on public.customer_accounts for delete
  using (public.is_company_admin('dc-solar'));

-- NOTE: no INSERT policy on purpose. Rows are created by the trigger below,
-- which runs as the definer — a client cannot insert its own row.

/**
 * Classify every new auth user. Anyone who is not already on the staff roster
 * becomes a customer. Runs SECURITY DEFINER because auth.users triggers fire
 * outside the caller's RLS context.
 */
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.employees e where lower(e.email) = lower(new.email)
  ) then
    insert into public.customer_accounts (user_id, email, full_name)
    values (
      new.id,
      new.email,
      nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '')
    )
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Backfill: any existing auth user who isn't staff is a customer.
insert into public.customer_accounts (user_id, email)
select u.id, u.email
  from auth.users u
 where u.email is not null
   and not exists (select 1 from public.employees e where lower(e.email) = lower(u.email))
on conflict (user_id) do nothing;
