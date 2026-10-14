-- Which QuickBooks object each app record became (2026-10-14).
--
-- Written by scripts/qbo/import.mjs and (next) the qbo-sync edge function; both look a
-- record up here before creating anything, so re-runs never duplicate and a later
-- change in the app can UPDATE the same QuickBooks object (Id + SyncToken).
--
--   app_kind  customer | project | item | invoice | payment | sales_receipt |
--             deposit | purchase | journal | cash_move
--   app_key   the app id it came from: customers.id, jobs.id, finance_entries.id,
--             payroll_runs.id, or the bank_ref of a bank-line group
--
-- Admins may read it (the review screen can show "in QuickBooks"); only the service
-- role writes.
begin;

create table if not exists public.qbo_links (
  company     text not null default 'dc-solar',
  app_kind    text not null,
  app_key     text not null,
  qbo_type    text not null,
  qbo_id      text not null,
  sync_token  text,
  app_ids     uuid[] not null default '{}',
  synced_at   timestamptz not null default now(),
  primary key (company, app_kind, app_key)
);
create index if not exists qbo_links_app_ids on public.qbo_links using gin (app_ids);

alter table public.qbo_links enable row level security;
revoke all on public.qbo_links from anon, authenticated;
grant select on public.qbo_links to authenticated;
drop policy if exists qbo_links_admin_read on public.qbo_links;
create policy qbo_links_admin_read on public.qbo_links for select to authenticated
  using (public.is_company_admin(company));

commit;
