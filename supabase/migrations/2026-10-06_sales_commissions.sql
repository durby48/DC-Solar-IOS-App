-- Sales commission (2026-10-06, S4).
--
-- THE RULE (Carson): 30% of the full amount charged — the first year AND every
-- renewal — credited to the rep who sold the plan while they work here (an
-- admin can move a customer to another rep by changing the visit's rep), and
-- paid in the payroll period the money came in. A refund is deducted in the
-- period of the REFUND. Pay periods: every 14 days from Mon 2026-08-04 (matches
-- Gusto). The app works out what is owed; payroll still pays it.
--
-- ONE ROW PER MONEY EVENT, written only by stripe-webhook (service role):
--   invoice.paid     → kind 'first' (billing_reason subscription_create) or
--                      'renewal' (subscription_cycle), +amount
--   charge.refunded  → kind 'refund', −the newly refunded amount
-- Keyed by stripe_ref so Stripe's retries never double-count. The rate is
-- copied onto each row, so changing it later never rewrites history.
--
-- WHO SEES IT. A rep: their own rows. Admins: all rows, and they mark a rep's
-- period paid. Nobody inserts or deletes from the app.
--
-- Idempotent: safe to re-run.

begin;

alter table public.company_settings
  add column if not exists commission_rate   numeric(5,4) not null default 0.30,
  add column if not exists pay_period_anchor date         not null default date '2026-08-04',
  add column if not exists pay_period_days   integer      not null default 14;
alter table public.company_settings drop constraint if exists company_settings_commission_check;
alter table public.company_settings add constraint company_settings_commission_check
  check (commission_rate >= 0 and commission_rate <= 1 and pay_period_days between 7 and 31);

create table if not exists public.sales_commissions (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  company           text not null default 'dc-solar',
  rep_email         text not null,
  customer_id       uuid references public.customers(id),
  kind              text not null check (kind in ('first', 'renewal', 'refund')),
  stripe_ref        text not null unique,
  stripe_invoice_id text,
  amount_cents      integer not null,
  rate              numeric(5,4) not null,
  commission_cents  integer not null,
  occurred_on       date not null,
  period_start      date not null,
  period_end        date not null,
  paid_at           timestamptz,
  paid_by           text
);
create index if not exists sales_commissions_rep_idx on public.sales_commissions (company, lower(rep_email), period_start);
create index if not exists sales_commissions_invoice_idx on public.sales_commissions (stripe_invoice_id);

alter table public.sales_commissions enable row level security;

drop policy if exists sc_select on public.sales_commissions;
create policy sc_select on public.sales_commissions for select
  using (
    public.is_company_admin(company)
    or (public.is_company_staff(company) and lower(rep_email) = lower(public.jwt_email()))
  );
drop policy if exists sc_admin_update on public.sales_commissions;
create policy sc_admin_update on public.sales_commissions for update
  using (public.is_company_admin(company)) with check (public.is_company_admin(company));

-- ---------------------------------------------------------------------------
-- Pay periods
-- ---------------------------------------------------------------------------
create or replace function public.pay_period_of(p_company text, p_day date)
returns table (period_start date, period_end date)
language sql stable security definer set search_path = public as $$
  select s.pay_period_anchor + (floor((p_day - s.pay_period_anchor)::numeric / s.pay_period_days)::integer * s.pay_period_days),
         s.pay_period_anchor + (floor((p_day - s.pay_period_anchor)::numeric / s.pay_period_days)::integer * s.pay_period_days) + s.pay_period_days - 1
    from public.company_settings s
   where s.company = p_company;
$$;

-- The current period, for any employee (a rep's Home and commission screen).
create or replace function public.current_pay_period()
returns table (period_start date, period_end date)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_company_staff('dc-solar') then
    raise exception 'staff only' using errcode = '42501';
  end if;
  return query select * from public.pay_period_of('dc-solar', (now() at time zone 'America/Chicago')::date);
end;
$$;

-- ---------------------------------------------------------------------------
-- Recording (stripe-webhook only)
-- ---------------------------------------------------------------------------
-- The rep is whoever sold the customer's most recent service visit, if they
-- are still a sales employee; otherwise nobody earns it (returns null).
create or replace function public.record_sales_commission(
  p_customer_id uuid,
  p_kind        text,
  p_stripe_ref  text,
  p_invoice_id  text,
  p_amount      integer,
  p_occurred_on date
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_company text;
  v_rep     text;
  v_rate    numeric(5,4);
  v_start   date;
  v_end     date;
  v_id      uuid;
begin
  select company into v_company from public.customers where id = p_customer_id;
  if v_company is null or coalesce(p_amount, 0) = 0 then
    return null;
  end if;

  if p_kind = 'refund' then
    -- Same rep and rate as the payment being refunded.
    select rep_email, rate into v_rep, v_rate
      from public.sales_commissions
     where stripe_invoice_id = p_invoice_id and kind in ('first', 'renewal')
     order by created_at limit 1;
  else
    select lower(j.sales_rep_email) into v_rep
      from public.jobs j
      join public.employees e on lower(e.email) = lower(j.sales_rep_email) and e.role = 'sales'
     where j.customer_id = p_customer_id
       and j.job_type in ('Cleaning', 'Inspection')
     order by j.created_at desc
     limit 1;
    select commission_rate into v_rate from public.company_settings where company = v_company;
  end if;
  if v_rep is null or v_rate is null then
    return null;
  end if;

  select period_start, period_end into v_start, v_end from public.pay_period_of(v_company, p_occurred_on);

  insert into public.sales_commissions
    (company, rep_email, customer_id, kind, stripe_ref, stripe_invoice_id, amount_cents, rate,
     commission_cents, occurred_on, period_start, period_end)
  values
    (v_company, v_rep, p_customer_id, p_kind, p_stripe_ref, p_invoice_id, p_amount, v_rate,
     round(p_amount * v_rate)::integer, p_occurred_on, v_start, v_end)
  on conflict (stripe_ref) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.pay_period_of(text, date) from public, anon, authenticated;
revoke all on function public.record_sales_commission(uuid, text, text, text, integer, date) from public, anon, authenticated;
grant execute on function public.record_sales_commission(uuid, text, text, text, integer, date) to service_role;
revoke all on function public.current_pay_period() from public, anon;
grant execute on function public.current_pay_period() to authenticated;

commit;
