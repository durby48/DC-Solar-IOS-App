-- Lead map + a rep's recent calls (2026-10-07).
--
-- 1. COORDINATES. leads and customers get lat / lng, filled by the
--    `geocode-addresses` edge function (US Census geocoder, free, no key).
--    `geocoded_address` is the exact address text that was looked up, so an
--    edited address is noticed (address <> geocoded_address) and looked up
--    again — no trigger needed. `geocode_status`: 'ok' | 'no_match'.
--    These columns follow the tables' existing policies: a rep sees pins only
--    for records they can already see.
--
-- 2. A REP'S CALL LOG. msg_sales_select (2026-10-05_rep_numbers.sql) shows a
--    rep calls filed on THEIR records only, so a call from an unknown number to
--    their DC Solar line never appeared anywhere. Now a rep may also read every
--    CALL row to or from their own line (my_phone_line(), which answers only
--    the caller's number). Texts are unchanged. If a number is later moved to
--    another rep, its call history moves with it — it is the company's line.
--
-- Idempotent: safe to re-run.

begin;

alter table public.leads
  add column if not exists lat              double precision,
  add column if not exists lng              double precision,
  add column if not exists geocoded_address text,
  add column if not exists geocode_status   text;
alter table public.customers
  add column if not exists lat              double precision,
  add column if not exists lng              double precision,
  add column if not exists geocoded_address text,
  add column if not exists geocode_status   text;

drop policy if exists msg_sales_line_calls on public.messages;
create policy msg_sales_line_calls on public.messages for select
  using (
    public.is_company_sales(company)
    and channel = 'call'
    and public.my_phone_line() is not null
    and (from_number = public.my_phone_line() or to_number = public.my_phone_line())
  );

commit;
