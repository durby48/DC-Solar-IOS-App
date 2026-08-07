-- Customer portal foundation: invite → link → read your own paperwork.
-- (2026-08-06)
--
-- Devon invites a customer from the Customers screen. That calls the
-- `invite-customer` edge function, which uses Supabase's admin invite and
-- stamps `customer_id` into the new user's metadata. The auth.users trigger
-- below reads that metadata, so the account arrives already linked to the CRM
-- record — no manual matching, and no way for a customer to claim someone
-- else's jobs by typing an email.
--
-- WHAT A CUSTOMER MAY SEE, and nothing else:
--   * their own jobs (a safe subset of columns)
--   * invoice / estimate / PAYMENT entries on those jobs
-- Explicitly NOT expenses, labour, hours, pay rates, profit, or any other
-- customer's anything. Expenses are our cost base — showing a homeowner what
-- we paid for their materials is not something to leave to a UI filter.
--
-- Enforcement is via SECURITY DEFINER functions rather than table policies:
-- RLS is row-level, and here we need COLUMN-level limits too. A function
-- returns exactly the columns we choose, so a customer cannot select more by
-- crafting their own query.
--
-- Idempotent: safe to re-run.

-- 1. Link an invited account to its CRM record ------------------------------

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  invited_customer uuid;
begin
  if exists (select 1 from public.employees e where lower(e.email) = lower(new.email)) then
    return new;  -- staff are managed by hand; never auto-file them
  end if;

  begin
    invited_customer := nullif(new.raw_user_meta_data ->> 'customer_id', '')::uuid;
  exception when others then
    invited_customer := null;  -- malformed metadata must not block signup
  end;

  insert into public.customer_accounts (user_id, email, full_name, customer_id, status)
  values (
    new.id,
    new.email,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    invited_customer,
    case when invited_customer is null then 'pending' else 'invited' end
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- 2. The customer's own record ----------------------------------------------

/** The CRM customer id linked to the signed-in account, or null. */
create or replace function public.my_customer_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select ca.customer_id
    from public.customer_accounts ca
   where ca.user_id = auth.uid()
   limit 1;
$$;

-- 3. What the customer may read ---------------------------------------------

/** The signed-in customer's projects. Safe columns only. */
create or replace function public.my_projects()
returns table (
  job_id uuid,
  job_number text,
  name text,
  address text,
  stage text,
  scheduled_for date,
  completed_on date
)
language sql
stable
security definer
set search_path = public
as $$
  select j.id, j.job_number, j.name, j.address, j.stage, j.scheduled_for, j.completed_on
    from public.jobs j
   where j.customer_id is not null
     and j.customer_id = public.my_customer_id()
   order by j.job_number desc;
$$;

/**
 * The signed-in customer's paperwork: their estimates, invoices and payments.
 * Expenses are deliberately excluded — that is our cost base, not theirs.
 */
create or replace function public.my_documents()
returns table (
  entry_id uuid,
  job_id uuid,
  job_number text,
  type text,
  amount numeric,
  occurred_on date,
  status text,
  document_number text,
  document_path text
)
language sql
stable
security definer
set search_path = public
as $$
  select f.id, f.job_id, j.job_number, f.type, f.amount, f.occurred_on,
         f.status, f.document_number, f.document_path
    from public.finance_entries f
    join public.jobs j on j.id = f.job_id
   where j.customer_id is not null
     and j.customer_id = public.my_customer_id()
     and f.type in ('invoice', 'estimate', 'payment')
   order by f.occurred_on desc nulls last;
$$;

/** Balance summary for the customer's own account. */
create or replace function public.my_balance()
returns table (invoiced numeric, paid numeric, balance numeric)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(sum(f.amount) filter (where f.type = 'invoice'), 0),
    coalesce(sum(f.amount) filter (where f.type = 'payment'), 0),
    coalesce(sum(f.amount) filter (where f.type = 'invoice'), 0)
      - coalesce(sum(f.amount) filter (where f.type = 'payment'), 0)
    from public.finance_entries f
    join public.jobs j on j.id = f.job_id
   where j.customer_id is not null
     and j.customer_id = public.my_customer_id();
$$;

-- These run as definer, so lock execution to signed-in users only.
revoke all on function public.my_customer_id() from public, anon;
revoke all on function public.my_projects() from public, anon;
revoke all on function public.my_documents() from public, anon;
revoke all on function public.my_balance() from public, anon;
grant execute on function public.my_customer_id() to authenticated;
grant execute on function public.my_projects() to authenticated;
grant execute on function public.my_documents() to authenticated;
grant execute on function public.my_balance() to authenticated;
