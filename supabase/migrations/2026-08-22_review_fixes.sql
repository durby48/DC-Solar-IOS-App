-- Code-review fixes for the 2026-08 overhaul: five confirmed findings.
-- (2026-08-22, follow-up to Workstreams D / F / I)
--
-- WHY THIS EXISTS
--
-- F1 (HIGH) — SELF-SIGNUP COULD CLAIM SOMEBODY ELSE'S CUSTOMER RECORD.
--   handle_new_auth_user() copied `raw_user_meta_data ->> 'customer_id'` into
--   customer_accounts.customer_id and stamped the row 'invited'. That column
--   is CLIENT-CONTROLLED: supabase.auth.signUp({ options: { data } }) writes
--   whatever the caller sends, and the anon key is public in the shipped web
--   bundle. Anyone who learned a customer UUID (they appear in URLs and in
--   any exported CSV) could sign up with `data: {customer_id: '<uuid>'}` and
--   land already linked — my_customer_id() would then hand them that
--   customer's invoices, estimates, balance and, through
--   my_document_paths(), the actual PDFs in the contracts bucket.
--
--   The trigger now IGNORES that key completely. Every new non-staff user is
--   customer_id = null, status = 'pending', full stop. Linking moves to the
--   only place that was ever entitled to do it: the invite-customer edge
--   function, which runs with the service role AFTER re-checking that the
--   caller is an owner/operator. The staff branch (including the google /
--   apple refusal from 2026-08_oauth_staff_block.sql) and the full_name
--   handling are byte-for-byte unchanged.
--
--   NOTE FOR WHOEVER READS THIS NEXT: an admin invite still links, because
--   invite-customer does the UPDATE itself. Nothing about the metadata
--   round-trip was load-bearing except the linking, and that is now done by
--   code that has already proved who is asking.
--
-- F2 (LOW) — oauth_is_staff_email(text) was granted to `authenticated`, which
--   makes it an employee-roster oracle: any signed-in customer could probe
--   addresses one at a time and learn who works here. Its own comment already
--   said it must not be exposed. The two callers are SECURITY DEFINER trigger
--   functions that run as the owner, so they keep working with no grant at
--   all.
--
-- F3 (LOW) — crm_customer_summary.estimated summed EVERY estimate row. The
--   rest of the app (lib/pipeline.ts::isNewerEstimate) counts only the newest
--   estimate per job, ordered by occurred_on then created_at. A revised
--   estimate therefore showed double in the CRM money strip and single
--   everywhere else. Now it ranks per job and takes rank 1; estimates with no
--   job_id (company-level / imported rows matched by customer_id) have no job
--   to be superseded within, so they each still count.
--
-- F4 (MEDIUM) — revise_document() had a lost-update race on the revision
--   number. The client computes the archive object name
--   revisions/<doc>-r<N>.pdf from the revision it LOADED, uploads the PDF,
--   then calls this RPC, which computes current + 1 independently. Two admins
--   editing the same estimate both upload -r2.pdf (upsert: the second
--   silently overwrites the first) while the RPC hands out r2 and r3 — so the
--   history row for r3 points at bytes that are r2's. The new trailing
--   p_expected_revision lets the client say which revision it based its work
--   on; a mismatch raises 40001 (serialization_failure) so the client can
--   reload and retry instead of quietly corrupting the archive. Passing null
--   keeps the old behaviour, so an older client build is not broken by this.
--   DROP-then-CREATE rather than CREATE OR REPLACE: adding a defaulted
--   argument creates a SECOND function, and `revise_document(uuid, jsonb,
--   numeric)` would then be ambiguous and fail at call time.
--
-- F5 (LOW) — leads had no sms_opt_out_at, so a lead who replied STOP was
--   recorded nowhere and could be texted again. customers has had the column
--   since the CRM migration; this is the matching half. twilio-inbound now
--   stamps it and twilio-send-sms now refuses on it.
--
-- Idempotent: safe to re-run. Seeds nothing. Rewrites no existing data.

begin;

-- ---------------------------------------------------------------------------
-- F1. handle_new_auth_user() — never trust client metadata for the link
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_provider text;
begin
  if exists (select 1 from public.employees e where lower(e.email) = lower(new.email)) then
    -- Staff. Never auto-filed as a customer — and never created by a social
    -- login. raw_app_meta_data.provider is what GoTrue stamps for the account
    -- as a whole; a missing value means the ordinary email/password flow.
    v_provider := coalesce(new.raw_app_meta_data ->> 'provider', 'email');
    if v_provider in ('google', 'apple') then
      raise exception 'Staff accounts sign in with a password and a 6-digit code, not %', v_provider
        using errcode = '42501';
    end if;
    return new;  -- staff are managed by hand; never auto-file them
  end if;

  -- raw_user_meta_data.customer_id IS DELIBERATELY IGNORED. It is whatever the
  -- signup call sent, and the anon key that can make that call ships in the
  -- web bundle. A new account is ALWAYS unlinked and pending; only
  -- invite-customer (service role, admin-checked) may set customer_id.
  -- full_name is cosmetic — the worst a forged one does is misspell a name in
  -- the admin list — so it is still taken from the metadata as before.
  insert into public.customer_accounts (user_id, email, full_name, customer_id, status)
  values (
    new.id,
    new.email,
    nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), ''),
    null,
    'pending'
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

comment on function public.handle_new_auth_user() is
  'Files every new non-staff auth user into customer_accounts as UNLINKED and '
  'pending, and refuses a staff account created through google/apple. Does '
  'NOT read raw_user_meta_data.customer_id: that is client-controlled and was '
  'a way to claim another customer''s invoices. invite-customer links the row '
  'with the service role after checking the caller is an admin.';

-- ---------------------------------------------------------------------------
-- F2. oauth_is_staff_email() — not an oracle for signed-in customers
-- ---------------------------------------------------------------------------
-- Both callers (handle_new_auth_user via the roster EXISTS, and
-- block_staff_oauth_identity) are SECURITY DEFINER and execute as the owner,
-- which needs no grant. Nothing else in the schema calls it.
revoke all on function public.oauth_is_staff_email(text) from public, anon;
revoke execute on function public.oauth_is_staff_email(text) from authenticated;

-- ---------------------------------------------------------------------------
-- F3. crm_customer_summary — `estimated` counts the NEWEST estimate per job
-- ---------------------------------------------------------------------------
-- Same shape, same gate, same everything else; only the estimate arithmetic
-- changes. Keep the admin check inside the first CTE — it is the only thing
-- stopping a viewer reading every customer's balance through one rpc() call.
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
  -- Estimates, ranked newest-first WITHIN each job. This is the SQL twin of
  -- lib/pipeline.ts::isNewerEstimate: occurred_on first, created_at as the
  -- tie-break, a null occurred_on sorting oldest (nulls last on a desc sort).
  -- Rows with no job_id have no job to be superseded within, so they are all
  -- given rank 1 and each counts once.
  est_ranked as (
    select a.cid,
           f.amount,
           case
             when f.job_id is null then 1
             else row_number() over (
                    partition by a.cid, f.job_id
                    order by f.occurred_on desc nulls last, f.created_at desc
                  )
           end as rn
      from allowed a
      join public.finance_entries f
        on f.company = 'dc-solar'
       and f.type = 'estimate'
       and (
             f.customer_id = a.cid
             or f.job_id in (select cj.jid from cjobs cj where cj.cid = a.cid)
           )
  ),
  est as (
    select er.cid, coalesce(sum(er.amount), 0) as est
      from est_ranked er
     where er.rn = 1
     group by er.cid
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
         coalesce(e.est, 0),
         m.con,
         w.n_open,
         w.n_total,
         greatest(m.last_money, w.last_job, nt.last_note)
    from allowed a
    join money m on m.cid = a.cid
    join work  w on w.cid = a.cid
    join noted nt on nt.cid = a.cid
    left join est e on e.cid = a.cid;
$$;

comment on function public.crm_customer_summary(uuid[]) is
  'Invoiced / paid / balance / estimated / contracted / job counts / last '
  'activity for a batch of customers. `estimated` counts only the NEWEST '
  'estimate per job (occurred_on, then created_at), matching '
  'lib/pipeline.ts::isNewerEstimate; estimates with no job_id each count '
  'once. SECURITY DEFINER with the admin check inside the first CTE: '
  'non-admins get ZERO ROWS, never an error and never a number. Verify by '
  'impersonating a viewer.';

revoke all on function public.crm_customer_summary(uuid[]) from public, anon;
grant execute on function public.crm_customer_summary(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- F4. revise_document() — optimistic concurrency on the revision number
-- ---------------------------------------------------------------------------
-- Drop the 12-argument version first. A defaulted 13th argument does not
-- replace it, it creates an OVERLOAD, and every existing 3-to-12-argument
-- call site would then fail with "function is not unique".
drop function if exists public.revise_document(uuid, jsonb, numeric, text, date, text, jsonb, text, text, text, bigint, uuid);

create or replace function public.revise_document(
  p_entry_id          uuid,
  p_line_items        jsonb,
  p_amount            numeric,
  p_notes             text default null,
  p_occurred_on       date default null,
  p_description       text default null,
  p_document_meta     jsonb default '{}'::jsonb,
  p_document_path     text default null,
  p_archive_path      text default null,
  p_pdf_state         text default 'current',
  p_file_size         bigint default null,
  p_client_token      uuid default null,
  p_expected_revision integer default null
)
returns table (revision int, entry_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry     public.finance_entries%rowtype;
  v_cur_rev   int;
  v_next_rev  int;
  v_meta      jsonb;
  v_total_txt text;
  v_total     numeric;
  v_doc_path  text;
  v_email     text;
  v_history   int;
  v_doc_type  text;
begin
  if p_entry_id is null then
    raise exception 'revise_document: p_entry_id is required'
      using errcode = '22023';
  end if;

  -- Lock the living document first: two saves racing must serialise, or both
  -- would compute the same next revision number.
  select * into v_entry
    from public.finance_entries e
   where e.id = p_entry_id
     for update;

  -- Authorisation before anything else. Note the missing-row branch also
  -- answers 42501 to a non-admin, so this cannot be used to probe which ids
  -- exist. This function runs as definer and therefore bypasses the
  -- fin_admin_* policies — the check below IS the gate.
  if not found then
    if not public.is_company_admin('dc-solar') then
      raise exception 'revise_document: only owners and operators can revise documents'
        using errcode = '42501';
    end if;
    raise exception 'revise_document: no finance entry %', p_entry_id
      using errcode = 'P0002';
  end if;

  if not public.is_company_admin(v_entry.company) then
    raise exception 'revise_document: only owners and operators can revise documents'
      using errcode = '42501';
  end if;

  -- Payments, expenses and investments are not documents; they have no line
  -- items and nothing to re-render.
  if v_entry.type not in ('estimate', 'invoice', 'contract') then
    raise exception 'revise_document: a % entry has no document to revise', v_entry.type
      using errcode = '22023';
  end if;

  if p_line_items is null
     or jsonb_typeof(p_line_items) <> 'array'
     or jsonb_array_length(p_line_items) = 0 then
    raise exception 'revise_document: at least one line item is required'
      using errcode = '22023';
  end if;

  -- Idempotency. The builder mints a client token per Save press and reuses it
  -- on Retry, so a double-tap (or a retry after a PDF upload failed) returns
  -- the revision that already happened instead of burning a second one.
  --
  -- THIS RUNS BEFORE THE p_expected_revision CHECK ON PURPOSE. A retry of a
  -- save that already landed carries the OLD expected revision, and the whole
  -- point of the token is that such a retry is a no-op rather than an error.
  if p_client_token is not null
     and coalesce(v_entry.document_meta, '{}'::jsonb) ->> 'last_client_token'
         = p_client_token::text then
    return query select coalesce(v_entry.revision, 1)::int, v_entry.id;
    return;
  end if;

  v_cur_rev  := coalesce(v_entry.revision, 1);
  v_next_rev := v_cur_rev + 1;

  -- Optimistic concurrency. The client uploaded revisions/<doc>-r<N>.pdf using
  -- the revision it loaded; if somebody else revised in between, N is already
  -- taken and the upsert has overwritten their archive. Refuse instead, with
  -- 40001 (serialization_failure) so a retry layer treats it as "reload and
  -- try again" rather than a bug. Null means an older client that cannot say
  -- what it based its edit on — old behaviour, no check.
  if p_expected_revision is not null and p_expected_revision <> v_next_rev then
    raise exception 'This document was revised elsewhere (expected revision %, current is %)',
      p_expected_revision, v_cur_rev
      using errcode = '40001';
  end if;

  -- INVARIANT: amount = totals.total. The PDF and the money row are rendered
  -- from different sides of the client; if they ever disagree the Financials
  -- tiles are wrong and nobody finds out for a month.
  v_total_txt := p_document_meta #>> '{totals,total}';
  if v_total_txt is not null then
    begin
      v_total := v_total_txt::numeric;
    exception when others then
      raise exception 'revise_document: document_meta.totals.total is not a number (%)', v_total_txt
        using errcode = '22023';
    end;
    if abs(v_total - coalesce(p_amount, 0)) > 0.005 then
      raise exception 'revise_document: amount % does not match totals.total %', p_amount, v_total
        using errcode = '22023';
    end if;
  end if;

  v_email := public.jwt_email();

  -- Legacy rows pre-date the history table, so snapshot what the document
  -- looks like NOW as its current revision before overwriting it. Otherwise
  -- rev 1 of every existing estimate would be lost the first time it is
  -- revised.
  select count(*) into v_history
    from public.finance_entry_revisions r
   where r.entry_id = p_entry_id;

  if v_history = 0 then
    insert into public.finance_entry_revisions (
      company, entry_id, revision, type, amount, occurred_on, description,
      notes, line_items, document_meta, document_number, document_path, created_by
    ) values (
      v_entry.company, v_entry.id, v_cur_rev, v_entry.type, v_entry.amount,
      v_entry.occurred_on, v_entry.description, v_entry.notes,
      v_entry.line_items, v_entry.document_meta, v_entry.document_number,
      v_entry.document_path, coalesce(v_entry.revised_by, 'system')
    )
    on conflict on constraint finance_entry_revisions_entry_rev_uq do nothing;
  end if;

  v_meta := coalesce(v_entry.document_meta, '{}'::jsonb)
            || coalesce(p_document_meta, '{}'::jsonb)
            || jsonb_build_object('pdf_state', coalesce(nullif(p_pdf_state, ''), 'current'));
  if p_client_token is not null then
    v_meta := v_meta || jsonb_build_object('last_client_token', p_client_token::text);
  end if;

  v_doc_path := coalesce(p_document_path, v_entry.document_path);

  update public.finance_entries e
     set line_items    = p_line_items,
         amount        = p_amount,
         notes         = coalesce(p_notes, e.notes),
         occurred_on   = coalesce(p_occurred_on, e.occurred_on),
         description   = coalesce(p_description, e.description),
         document_meta = v_meta,
         document_path = v_doc_path,
         revision      = v_next_rev,
         revised_at    = now(),
         revised_by    = v_email
   where e.id = p_entry_id;

  -- document_path on a history row is the ARCHIVE copy
  -- (…/revisions/<docnum>-r<N>.pdf), which is never overwritten. The living
  -- path is upserted in place and would serve the newest bytes to every past
  -- revision if we stored it here.
  insert into public.finance_entry_revisions (
    company, entry_id, revision, type, amount, occurred_on, description,
    notes, line_items, document_meta, document_number, document_path, created_by
  ) values (
    v_entry.company, v_entry.id, v_next_rev, v_entry.type, p_amount,
    coalesce(p_occurred_on, v_entry.occurred_on),
    coalesce(p_description, v_entry.description),
    coalesce(p_notes, v_entry.notes),
    p_line_items, v_meta, v_entry.document_number,
    coalesce(p_archive_path, p_document_path),
    coalesce(v_email, 'system')
  );

  -- Keep the PDF registry pointing at exactly one row per living document.
  if p_document_path is not null then
    v_doc_type := case
                    when v_entry.type in ('estimate', 'invoice', 'contract')
                      then v_entry.type
                    else 'other'
                  end;

    update public.job_documents d
       set finance_entry_id = v_entry.id,
           size_bytes       = coalesce(p_file_size, d.size_bytes),
           doc_type         = v_doc_type
     where d.company = v_entry.company
       and d.storage_path = p_document_path;

    if not found and v_entry.job_id is not null then
      insert into public.job_documents (
        company, job_id, doc_type, storage_path, file_name, content_type,
        size_bytes, uploaded_by, finance_entry_id
      ) values (
        v_entry.company, v_entry.job_id, v_doc_type, p_document_path,
        coalesce(v_entry.document_number, 'document') || '.pdf',
        'application/pdf', p_file_size,
        coalesce(v_email, 'system'), v_entry.id
      )
      on conflict (company, storage_path) do nothing;
    end if;
  end if;

  return query select v_next_rev::int, v_entry.id;
end;
$$;

comment on function public.revise_document(uuid, jsonb, numeric, text, date, text, jsonb, text, text, text, bigint, uuid, integer) is
  'Revise an estimate / invoice / contract in place and append its history. '
  'The only writer of finance_entry_revisions. Admin-only (raises 42501), '
  'idempotent per p_client_token, asserts amount = document_meta.totals.total. '
  'p_expected_revision is optimistic concurrency: pass the revision the '
  'client based its edit on and a concurrent revision raises 40001 instead '
  'of overwriting somebody else''s archived PDF.';

revoke all on function public.revise_document(uuid, jsonb, numeric, text, date, text, jsonb, text, text, text, bigint, uuid, integer) from public, anon;
grant execute on function public.revise_document(uuid, jsonb, numeric, text, date, text, jsonb, text, text, text, bigint, uuid, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- F5. leads.sms_opt_out_at — the missing half of STOP handling
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists sms_opt_out_at timestamptz;

comment on column public.leads.sms_opt_out_at is
  'Set when the lead replies STOP (twilio-inbound), cleared on START. '
  'twilio-send-sms refuses to text a lead with this set. The customers table '
  'has had the same column since the CRM migration; leads did not, so a lead '
  'who opted out could be texted again the next day.';

commit;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- F1 — a forged customer_id must NOT stick. Rolled back, so no user survives:
--   begin;
--   insert into auth.users (id, instance_id, aud, role, email,
--                           encrypted_password, raw_user_meta_data,
--                           raw_app_meta_data, created_at, updated_at)
--   values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
--           'authenticated', 'authenticated', 'f1-probe@example.com', '',
--           jsonb_build_object('customer_id',
--             (select id::text from public.customers where company='dc-solar' limit 1),
--             'full_name', 'Probe'),
--           '{"provider":"email"}'::jsonb, now(), now());
--   select customer_id, status from public.customer_accounts
--    where email = 'f1-probe@example.com';        -- expect: null, 'pending'
--   rollback;
--
-- F2 — as a signed-in customer the roster oracle must be closed:
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"email":"snettleton2005@gmail.com","role":"authenticated"}';
--   select public.oauth_is_staff_email('devonsd311@gmail.com');  -- expect: 42501
--   rollback;
--   (The OAuth gates still work: both trigger functions are SECURITY DEFINER
--   and execute as the owner, which needs no grant. Re-run the two identity
--   probes at the bottom of 2026-08-22_oauth_staff_block.sql.)
--
-- F3 — estimated equals the sum of the newest estimate per job:
--   select (public.crm_customer_summary(array['<customer id>'::uuid])).estimated;
--   -- compare with:
--   select sum(amount) from (
--     select distinct on (f.job_id) f.amount
--       from public.finance_entries f
--      where f.company='dc-solar' and f.type='estimate'
--        and f.job_id in (select id from public.jobs where customer_id='<customer id>')
--      order by f.job_id, f.occurred_on desc nulls last, f.created_at desc
--   ) newest;
--
-- F4 — three cases, all rolled back:
--   begin;
--   select * from public.revise_document('<entry>'::uuid, '[{"n":1}]'::jsonb, 1,
--     null,null,null,'{}'::jsonb,null,null,'current',null,null,
--     <current revision + 1>);                    -- expect: succeeds
--   rollback;
--   begin;
--   select * from public.revise_document('<entry>'::uuid, '[{"n":1}]'::jsonb, 1,
--     null,null,null,'{}'::jsonb,null,null,'current',null,null,
--     99);                                        -- expect: 40001
--   rollback;
