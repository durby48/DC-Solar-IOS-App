-- CRM: archive, dialable phone numbers, per-customer notes, money summaries.
-- (2026-08-22, Workstream F of the 2026-08 overhaul)
--
-- WHY THIS EXISTS
--
-- more/customers.tsx is a flat contact book: a name, three tappable links and
-- an inline edit form. It cannot tell Devon how many jobs a customer has, what
-- they owe, when we last did anything for them, or what was said on the phone
-- last Tuesday. This is the data layer for a real customer record.
--
-- FOUR THINGS, AND WHY EACH ONE IS SHAPED THE WAY IT IS
--
-- 1. ARCHIVE, NOT DELETE. `customers` has no DELETE policy and is not getting
--    one: jobs, invoices and payments point at these rows, and money that
--    loses its counterparty is worse than a cluttered list. archived_at is a
--    soft hide. The partial index keeps the default list (archived_at is
--    null) ordered by name without paying for the archived rows.
--
-- 2. phone_e164 IS GENERATED, NOT WRITTEN. Twilio needs +1XXXXXXXXXX; the
--    table holds "8165506413", "785-831-4612" and whatever gets typed next.
--    A generated column means the app never has to remember to normalise, and
--    — crucially — the raw `phone` is never rewritten. A 10-digit number
--    becomes +1…, an 11-digit number starting with 1 becomes +…, and ANYTHING
--    ELSE BECOMES NULL rather than a guess. Extensions, "call the office",
--    international numbers and typos land as null on purpose: a wrong +1 is a
--    text message to a stranger. Audit the nulls and fix the source data by
--    hand.
--
-- 3. NOTES ARE THEIR OWN TABLE. customers.notes is one text blob that the last
--    person to save the edit form overwrites. A timeline needs an author, a
--    date, an optional job and a pin. Every member can read and add notes —
--    the crew knowing "gate code is 4417, dog is friendly" is the point —
--    but you may only write your own name on a note, and only edit your own.
--
-- 4. THE SUMMARY FUNCTION IS THE DANGEROUS ONE. crm_customer_summary returns
--    invoiced / paid / balance per customer. finance_entries is admin-only
--    (it leaked $56,617 to four viewer accounts once), and a SECURITY DEFINER
--    function bypasses those policies by definition. So the admin check sits
--    INSIDE the first CTE: a non-admin does not get an error, they get zero
--    rows, and there is no code path in which this function reads money for
--    someone who could not already read it directly. Probe it by simulating a
--    viewer, not by reading it.
--
-- Idempotent: safe to re-run. Seeds nothing. Rewrites no existing data.

begin;

-- ---------------------------------------------------------------------------
-- 1. customers — archive, dialable number, SMS consent
-- ---------------------------------------------------------------------------
alter table public.customers
  add column if not exists archived_at        timestamptz,
  add column if not exists sms_opt_out_at     timestamptz,
  add column if not exists sms_opt_in_source  text;

comment on column public.customers.archived_at is
  'Soft hide. There is no DELETE policy on this table and there should not be '
  'one — jobs and finance_entries reference these rows.';

comment on column public.customers.sms_opt_out_at is
  'Set when the customer replies STOP. twilio-send-sms must refuse to send to '
  'a customer with this set; Twilio Advanced Opt-Out will block it anyway, '
  'but a message we never attempted is a message that cannot be billed or '
  'complained about.';

comment on column public.customers.sms_opt_in_source is
  'How consent was captured, for the A2P 10DLC record: e.g. '
  '"estimate-form-2026-09-01", "verbal-devon", "web-quote-request".';

-- 10 digits -> +1XXXXXXXXXX; 11 digits starting with 1 -> +1XXXXXXXXXX;
-- anything else -> NULL. Never a guess.
alter table public.customers
  add column if not exists phone_e164 text generated always as (
    case
      when phone is null then null
      when length(regexp_replace(phone, '[^0-9]', '', 'g')) = 10
        then '+1' || regexp_replace(phone, '[^0-9]', '', 'g')
      when length(regexp_replace(phone, '[^0-9]', '', 'g')) = 11
       and left(regexp_replace(phone, '[^0-9]', '', 'g'), 1) = '1'
        then '+' || regexp_replace(phone, '[^0-9]', '', 'g')
      else null
    end
  ) stored;

alter table public.leads
  add column if not exists phone_e164 text generated always as (
    case
      when phone is null then null
      when length(regexp_replace(phone, '[^0-9]', '', 'g')) = 10
        then '+1' || regexp_replace(phone, '[^0-9]', '', 'g')
      when length(regexp_replace(phone, '[^0-9]', '', 'g')) = 11
       and left(regexp_replace(phone, '[^0-9]', '', 'g'), 1) = '1'
        then '+' || regexp_replace(phone, '[^0-9]', '', 'g')
      else null
    end
  ) stored;

-- Inbound SMS arrives with a number and nothing else; this is the lookup.
create index if not exists customers_phone_e164_idx
  on public.customers (company, phone_e164) where phone_e164 is not null;

create index if not exists leads_phone_e164_idx
  on public.leads (company, phone_e164) where phone_e164 is not null;

-- The default Customers list: not archived, ordered by name.
create index if not exists customers_active_name_idx
  on public.customers (company, name) where archived_at is null;

-- ---------------------------------------------------------------------------
-- 2. customer_notes — the timeline
-- ---------------------------------------------------------------------------
create table if not exists public.customer_notes (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  company      text not null default 'dc-solar',
  customer_id  uuid not null references public.customers(id) on delete cascade,
  -- Optional: "talked to him about the Osawatomie reinstall" belongs to a job.
  job_id       uuid references public.jobs(id) on delete set null,
  body         text not null,
  author_email text not null default (auth.jwt() ->> 'email'),
  pinned       boolean not null default false
);

create index if not exists customer_notes_customer_idx
  on public.customer_notes (company, customer_id, created_at desc);

comment on table public.customer_notes is
  'Per-customer note timeline. Readable by every company member (the crew '
  'needs the gate code); you may only insert a note under your own email and '
  'only edit your own. Admins may fix or remove anything.';

create or replace function public.crm_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists customer_notes_touch on public.customer_notes;
create trigger customer_notes_touch
  before update on public.customer_notes
  for each row execute function public.crm_touch_updated_at();

alter table public.customer_notes enable row level security;

drop policy if exists cn_member_select on public.customer_notes;
create policy cn_member_select on public.customer_notes
  for select using (public.is_company_member(company));

-- You may add a note. You may not sign someone else's name to it.
drop policy if exists cn_member_insert on public.customer_notes;
create policy cn_member_insert on public.customer_notes
  for insert with check (
    public.is_company_member(company)
    and author_email is not null
    and lower(author_email) = lower(public.jwt_email())
  );

drop policy if exists cn_author_update on public.customer_notes;
create policy cn_author_update on public.customer_notes
  for update
  using (
    public.is_company_member(company)
    and lower(author_email) = lower(public.jwt_email())
  )
  with check (
    public.is_company_member(company)
    and lower(author_email) = lower(public.jwt_email())
  );

drop policy if exists cn_admin_all on public.customer_notes;
create policy cn_admin_all on public.customer_notes
  for all
  using (public.is_company_admin(company))
  with check (public.is_company_admin(company));

-- ---------------------------------------------------------------------------
-- 3. crm_customer_summary — money per customer, admin-only by construction
-- ---------------------------------------------------------------------------
-- Matched by customer_id OR by the customer's jobs, because both linkages
-- exist in the wild: documents created in the app stamp customer_id, rows
-- imported from the ops console and the email scanner often only have job_id.
create or replace function public.crm_customer_summary(customer_ids uuid[])
returns table (
  customer_id      uuid,
  invoiced         numeric,
  paid             numeric,
  balance          numeric,
  estimated        numeric,
  contracted       numeric,
  open_jobs        int,
  total_jobs       int,
  last_activity_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with allowed as (
    -- THE GATE. This function is SECURITY DEFINER and therefore bypasses
    -- fin_admin_select; without this predicate every viewer could read every
    -- customer's balance through one rpc() call. A non-admin gets zero rows,
    -- not an error, so the CRM list simply renders without the money strip.
    select c.id as cid
      from public.customers c
     where public.is_company_admin('dc-solar')
       and c.company = 'dc-solar'
       and c.id = any (coalesce(customer_ids, '{}'::uuid[]))
  ),
  cjobs as (
    select a.cid, j.id as jid, j.stage, j.created_at
      from allowed a
      join public.jobs j
        on j.company = 'dc-solar'
       and j.customer_id = a.cid
  ),
  money as (
    select a.cid,
           coalesce(sum(f.amount) filter (where f.type = 'invoice'),  0) as inv,
           coalesce(sum(f.amount) filter (where f.type = 'payment'),  0) as pd,
           coalesce(sum(f.amount) filter (where f.type = 'estimate'), 0) as est,
           coalesce(sum(f.amount) filter (where f.type = 'contract'), 0) as con,
           max(f.created_at) as last_money
      from allowed a
      left join public.finance_entries f
        on f.company = 'dc-solar'
       and (
             f.customer_id = a.cid
             or f.job_id in (select cj.jid from cjobs cj where cj.cid = a.cid)
           )
     group by a.cid
  ),
  work as (
    select a.cid,
           (count(cj.jid))::int as n_total,
           (count(cj.jid) filter (where coalesce(cj.stage, '') <> 'Complete'))::int as n_open,
           max(cj.created_at) as last_job
      from allowed a
      left join cjobs cj on cj.cid = a.cid
     group by a.cid
  ),
  noted as (
    select a.cid, max(n.created_at) as last_note
      from allowed a
      left join public.customer_notes n
        on n.company = 'dc-solar' and n.customer_id = a.cid
     group by a.cid
  )
  select a.cid,
         m.inv,
         m.pd,
         m.inv - m.pd,
         m.est,
         m.con,
         w.n_open,
         w.n_total,
         greatest(m.last_money, w.last_job, nt.last_note)
    from allowed a
    join money m on m.cid = a.cid
    join work  w on w.cid = a.cid
    join noted nt on nt.cid = a.cid;
$$;

comment on function public.crm_customer_summary(uuid[]) is
  'Invoiced / paid / balance / estimated / contracted / job counts / last '
  'activity for a batch of customers. SECURITY DEFINER with the admin check '
  'inside the first CTE: non-admins get ZERO ROWS, never an error and never a '
  'number. Verify by impersonating a viewer.';

revoke all on function public.crm_customer_summary(uuid[]) from public, anon;
grant execute on function public.crm_customer_summary(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. crm_merge_customers — the same person entered twice
-- ---------------------------------------------------------------------------
-- Repointing rows one table at a time from the client would leave a customer
-- half-merged the first time the network dropped, and `customers` has no
-- DELETE policy anyway. One definer function, one transaction.
create or replace function public.crm_merge_customers(keep_id uuid, merge_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_keep    public.customers%rowtype;
  v_merge   public.customers%rowtype;
  v_jobs    int := 0;
  v_fin     int := 0;
  v_docs    int := 0;
  v_notes   int := 0;
  v_accts   int := 0;
begin
  if keep_id is null or merge_id is null then
    raise exception 'crm_merge_customers: both ids are required'
      using errcode = '22023';
  end if;

  if keep_id = merge_id then
    return jsonb_build_object('merged', false, 'reason', 'same customer');
  end if;

  select * into v_keep  from public.customers c where c.id = keep_id;
  select * into v_merge from public.customers c where c.id = merge_id;

  -- Authorisation first, and answer the same way whether or not the ids exist.
  if not public.is_company_admin(coalesce(v_keep.company, v_merge.company, 'dc-solar')) then
    raise exception 'crm_merge_customers: only owners and operators can merge customers'
      using errcode = '42501';
  end if;

  if v_keep.id is null or v_merge.id is null then
    raise exception 'crm_merge_customers: customer not found'
      using errcode = 'P0002';
  end if;

  if v_keep.company <> v_merge.company then
    raise exception 'crm_merge_customers: refusing to merge across companies'
      using errcode = '22023';
  end if;

  update public.jobs j set customer_id = keep_id where j.customer_id = merge_id;
  get diagnostics v_jobs = row_count;

  update public.finance_entries f set customer_id = keep_id where f.customer_id = merge_id;
  get diagnostics v_fin = row_count;

  update public.customer_documents d set customer_id = keep_id where d.customer_id = merge_id;
  get diagnostics v_docs = row_count;

  update public.customer_notes n set customer_id = keep_id where n.customer_id = merge_id;
  get diagnostics v_notes = row_count;

  -- Not in the original plan, added deliberately: a portal login left pointing
  -- at the merged (now archived) record would show the customer an empty
  -- portal, and customer_accounts.customer_id has no unique constraint, so
  -- moving it is safe.
  update public.customer_accounts a set customer_id = keep_id where a.customer_id = merge_id;
  get diagnostics v_accts = row_count;

  update public.customers c
     set archived_at = coalesce(c.archived_at, now())
   where c.id = merge_id;

  return jsonb_build_object(
    'merged', true,
    'keep_id', keep_id,
    'merge_id', merge_id,
    'jobs', v_jobs,
    'finance_entries', v_fin,
    'customer_documents', v_docs,
    'customer_notes', v_notes,
    'customer_accounts', v_accts
  );
end;
$$;

comment on function public.crm_merge_customers(uuid, uuid) is
  'Repoint every child row from merge_id to keep_id and archive the loser. '
  'Admin only (42501). Returns a jsonb count of what moved.';

revoke all on function public.crm_merge_customers(uuid, uuid) from public, anon;
grant execute on function public.crm_merge_customers(uuid, uuid) to authenticated;

commit;

-- Verify (expect 4 policies on customer_notes):
--   select policyname, cmd from pg_policies
--    where schemaname = 'public' and tablename = 'customer_notes'
--    order by policyname;
--
-- Audit the numbers that could not be normalised — fix them by hand in the
-- app, never with an UPDATE here:
--   select name, phone from public.customers
--    where phone is not null and phone_e164 is null order by name;
--   select name, phone from public.leads
--    where phone is not null and phone_e164 is null order by name;
--
-- Verify the barrier by SIMULATING a viewer:
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"email":"snettleton2005@gmail.com","role":"authenticated"}';
--   select count(*) from public.crm_customer_summary(
--     array(select id from public.customers));          -- expect: 0 rows
--   insert into public.customer_notes (customer_id, body, author_email)
--     values ('<id>', 'x', 'devonsd311@gmail.com');     -- expect: denied
--   rollback;
