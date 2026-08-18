-- Employee of the Month (2026-08-18).
--
-- WHY A TABLE AND NOT A CONSTANT: Devon's rule today is "Garrett Nimsgern,
-- every month, until further notice — with a DIFFERENT photo each month". The
-- winner is stable but the PHOTO is not, and "until further notice" is exactly
-- the kind of rule that changes without a release. Hard-coding a name in the
-- app would mean an App Store build (or at best an OTA) every time the photo
-- changes, and a lie in the code the day somebody else wins. So the rule is
-- DATA: one row per month, added by an admin along with that month's photo.
--
-- Fallback is deliberate too. If nobody has filed a row for the current month
-- yet, the app shows the most recent row that DOES exist, still labelled with
-- the current month, so the card on the Today screen never goes blank in front
-- of the whole crew. That is a client-side read choice (lib/eom.ts) — the table
-- just needs to be orderable by month, which the primary key already gives us.
--
-- NO MONEY LIVES HERE. Name, email, photo path and a caption, nothing else.
-- This table is readable by every employee (see the select policy below), so
-- anything sensitive put in it would be company-wide readable. Do not add a
-- pay, bonus or hours column — those belong in the admin-only tables.
--
-- STORAGE: photos go in the EXISTING private `job-photos` bucket under an
-- `eom/` prefix, exactly like customer avatars use `customers/`. That bucket
-- already has everything needed and this migration adds NO storage policies:
--   "field app read media"   — select, bucket in (job-photos, receipts) and
--                              public.is_company_member('dc-solar')
--   "field app upload media" — insert, same buckets + is_company_member
--   "field app delete media" — delete, same buckets + is_company_admin
-- (from 2026-07-24_field_app.sql and 2026-07-27_media_delete.sql).
-- Members, not just admins, may INSERT into that bucket — that is pre-existing
-- and cannot be narrowed by ADDING a policy anyway, because PostgreSQL ORs
-- permissive policies together. It is harmless here: an object nobody can
-- reference is invisible, and only an admin can write the row that points at
-- it. Narrowing bucket writes would be its own migration touching job photos,
-- receipts and customer avatars, and is out of scope for this feature.
--
-- Idempotent: safe to re-run.

begin;

create table if not exists public.employee_of_month (
  company        text not null default 'dc-solar',
  -- First day of the month this award covers. Enforced below.
  month          date not null,
  employee_email text not null,
  -- Filled from the employees roster by trigger, same pattern as
  -- job_assignments.employee. Nullable so a not-yet-hired email still saves.
  employee_name  text,
  -- Object path inside the job-photos bucket, e.g. eom/2026-08-1755500000.jpg.
  photo_path     text,
  caption        text,
  created_at     timestamptz not null default now(),
  created_by     text,
  primary key (company, month)
);

-- `month` must be the first of the month, so "one award per month" is a real
-- constraint and not a convention. The cast to timestamp is deliberate:
-- date_trunc(text, date) resolves to the timestamptz overload, which is only
-- STABLE and therefore rejected in a check constraint. The timestamp overload
-- is IMMUTABLE.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.employee_of_month'::regclass
      and conname = 'employee_of_month_month_is_first'
  ) then
    alter table public.employee_of_month
      add constraint employee_of_month_month_is_first
      check (month = date_trunc('month', month::timestamp)::date);
  end if;
end
$$;

comment on table public.employee_of_month is
  'One row per company per month: who is Employee of the Month and which photo to show. Readable by every employee — never add money columns.';
comment on column public.employee_of_month.photo_path is
  'Object path in the private job-photos bucket under the eom/ prefix. Displayed via a signed URL.';

-- Newest-first lookups (the current month, else the latest row that exists).
create index if not exists employee_of_month_recent_idx
  on public.employee_of_month (company, month desc);

-- Fill the display name from the roster, mirroring public.job_assignments_fill.
-- SECURITY DEFINER because `employees` is admin-select-only and the writer may
-- be reading a row for somebody else.
create or replace function public.employee_of_month_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  select display_name into v_name
    from public.employees
    where lower(email) = lower(new.employee_email)
    limit 1;
  if v_name is not null then
    new.employee_name := v_name;
  end if;
  return new;
end;
$$;

drop trigger if exists employee_of_month_fill_trg on public.employee_of_month;
create trigger employee_of_month_fill_trg
  before insert or update on public.employee_of_month
  for each row
  execute function public.employee_of_month_fill();

alter table public.employee_of_month enable row level security;

-- READ: every employee in the company, using the SAME predicate as the jobs
-- read policy (`jobs_member_select` in 2026-07-24_scheduling_and_access.sql).
-- The whole point of the card is that the crew sees it, and the row carries
-- nothing more sensitive than a name and a photo.
drop policy if exists eom_select on public.employee_of_month;
create policy eom_select on public.employee_of_month for select
  using (public.is_company_member(company));

-- WRITE: admins only (owner/operator), the same gate the rest of the app's
-- curated content uses. Split per-command rather than FOR ALL so a future
-- change to one verb can't silently widen the others.
drop policy if exists eom_insert on public.employee_of_month;
create policy eom_insert on public.employee_of_month for insert
  with check (public.is_company_admin(company));

drop policy if exists eom_update on public.employee_of_month;
create policy eom_update on public.employee_of_month for update
  using (public.is_company_admin(company))
  with check (public.is_company_admin(company));

drop policy if exists eom_delete on public.employee_of_month;
create policy eom_delete on public.employee_of_month for delete
  using (public.is_company_admin(company));

-- Seed the current month so the card is live the moment this lands. The photo
-- is left null on purpose — the app falls back to coloured initials, and Devon
-- attaches August's photo from More → Employee of the Month.
insert into public.employee_of_month (company, month, employee_email, caption, created_by)
values (
  'dc-solar',
  date_trunc('month', current_date::timestamp)::date,
  'gnimsgern.2022@gmail.com',
  null,
  'migration-2026-08-18'
)
on conflict (company, month) do nothing;

commit;
