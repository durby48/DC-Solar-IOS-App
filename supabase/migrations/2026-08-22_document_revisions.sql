-- Seamless estimate / invoice revisions: revise in place, keep the history.
-- (2026-08-22, Workstream I of the 2026-08 overhaul)
--
-- WHY THIS EXISTS
--
-- Today "revising" an estimate means deleting the finance_entries row and
-- running the document builder again. That is the workflow Devon complains
-- about, and it is not a UI problem — the schema has no revision concept at
-- all. Change an estimate's amount in JobInvoices and you get a row saying
-- $9,000 pointing at a PDF that still says $8,000, with line_items that still
-- total $8,000, because the inline editor touches amount/date/description and
-- nothing else.
--
-- THE MODEL: same row, append-only history.
--
-- The revision keeps finance_entries.id. That matters more than it sounds:
--   * six client sites sum invoices per job, and my_balance() sums them for
--     the customer portal — a supersede-with-a-new-row model would double
--     every revised invoice until someone remembered to filter;
--   * isNewerEstimate (newest estimate per job by occurred_on, created_at as
--     tie-break) already flipped the company estimate total between refreshes
--     once. Keeping one row per living document means it never has to learn
--     about revisions;
--   * extracted->>'gmail_message_id' is the email scanner's only dedup key and
--     lives on the row. Replace the row and a re-sent bank alert double-logs;
--   * job_documents stays one row per living document instead of growing a
--     copy per revision.
--
-- History goes in finance_entry_revisions: admin SELECT only, and NO write
-- policy at all. Rows get there exactly one way, through revise_document(),
-- which runs SECURITY DEFINER. An append-only ledger you can UPDATE is not an
-- append-only ledger.
--
-- WHY AN RPC AND NOT FOUR CLIENT WRITES
--
-- Supabase's REST API has no multi-statement transaction, and this codebase
-- already pays for that: document creation is three independent writes whose
-- failures are all downgraded to warnings, leaving orphaned PDFs and rows.
-- A revision has to bump the entry, append the history row and re-point the
-- job_documents registry together or not at all, so it is one plpgsql
-- function called through supabase.rpc() — the pattern my_projects() /
-- my_documents() / my_balance() already established.
--
-- job_documents ALSO gets fixed here. It had no UPDATE policy, so a corrected
-- regeneration could only ever insert a second row; uploadGeneratedPdf() does
-- exactly that unconditionally, and the table already carried a duplicate
-- pair. This de-dupes (keeping the oldest), adds the unique key that stops it
-- happening again, adds the missing admin UPDATE policy, and back-fills the
-- finance_entry_id link that until now was only a naming convention
-- (finance_entries.document_path === job_documents.storage_path).
--
-- Idempotent: safe to re-run. Seeds nothing.

begin;

-- ---------------------------------------------------------------------------
-- 1. finance_entries — the living document
-- ---------------------------------------------------------------------------
alter table public.finance_entries
  add column if not exists notes         text,
  add column if not exists revision      int not null default 1,
  add column if not exists revised_at    timestamptz,
  add column if not exists revised_by    text,
  add column if not exists document_meta jsonb;

comment on column public.finance_entries.notes is
  'The document''s notes / terms block. Until now this was typed into the '
  'builder, rendered into the PDF and then thrown away, so reopening a '
  'document could not show it back.';

comment on column public.finance_entries.revision is
  'Revision counter for the document. 1 = as first created. The document '
  'NUMBER never changes; this is what changes instead.';

comment on column public.finance_entries.document_meta is
  'Everything the PDF needs that is not a line item: customer_snapshot, '
  'valid_until, totals {subtotal, discount, tax, total}, tax, discount, '
  'pdf_state (current|stale) and last_client_token (double-tap guard). '
  'INVARIANT: amount = totals.total — revise_document() asserts it.';

-- ---------------------------------------------------------------------------
-- 2. finance_entry_revisions — the history
-- ---------------------------------------------------------------------------
create table if not exists public.finance_entry_revisions (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  company         text not null default 'dc-solar',
  entry_id        uuid not null references public.finance_entries(id) on delete cascade,
  revision        int not null,
  type            text,
  amount          numeric,
  occurred_on     date,
  description     text,
  notes           text,
  line_items      jsonb,
  document_meta   jsonb,
  document_number text,
  -- The IMMUTABLE archive copy of this revision's PDF
  -- (contracts/<job>/revisions/<docnum>-r<N>.pdf), not the living path.
  document_path   text,
  created_by      text,
  -- Named on purpose: revise_document() has OUT parameters called entry_id
  -- and revision, so `on conflict (entry_id, revision)` inside it is
  -- ambiguous. `on conflict on constraint <name>` is not.
  constraint finance_entry_revisions_entry_rev_uq unique (entry_id, revision)
);

create index if not exists finance_entry_revisions_entry_idx
  on public.finance_entry_revisions (entry_id, revision desc);

comment on table public.finance_entry_revisions is
  'Append-only snapshot of every revision of an estimate / invoice / '
  'contract. Admin SELECT only and deliberately NO insert, update or delete '
  'policy: the only writer is public.revise_document(), which is SECURITY '
  'DEFINER. Do not add a write policy here.';

-- ---------------------------------------------------------------------------
-- 3. job_documents — de-dupe, unique key, UPDATE policy, FK to the entry
-- ---------------------------------------------------------------------------
alter table public.job_documents
  add column if not exists finance_entry_id uuid
    references public.finance_entries(id) on delete set null;

create index if not exists job_documents_finance_entry_idx
  on public.job_documents (finance_entry_id);

-- Re-point anything that referenced a duplicate we are about to remove, so
-- job_materials.source_document_id (FK, NO ACTION) cannot block the delete.
update public.job_materials m
   set source_document_id = keep.id
  from public.job_documents dup
  join lateral (
        select k.id
          from public.job_documents k
         where k.company = dup.company
           and k.storage_path = dup.storage_path
         order by k.created_at, k.id
         limit 1
       ) keep on true
 where m.source_document_id = dup.id
   and keep.id <> dup.id;

-- Keep the OLDEST row per (company, storage_path); the later ones are the
-- duplicate registry rows uploadGeneratedPdf() inserted on regeneration.
delete from public.job_documents d
 using public.job_documents keep
 where d.company = keep.company
   and d.storage_path = keep.storage_path
   and (keep.created_at, keep.id) < (d.created_at, d.id);

create unique index if not exists job_documents_path_uq
  on public.job_documents (company, storage_path);

-- The missing verb. Without it a document row can only be inserted or
-- deleted, never re-pointed — which is why regeneration duplicated rows.
drop policy if exists jd_update on public.job_documents;
create policy jd_update on public.job_documents
  for update
  using (public.is_company_admin(company))
  with check (public.is_company_admin(company));

-- Back-fill the link that was previously only a naming convention.
update public.job_documents d
   set finance_entry_id = f.id
  from public.finance_entries f
 where d.finance_entry_id is null
   and f.company = d.company
   and f.job_id = d.job_id
   and f.document_path = d.storage_path;

-- ---------------------------------------------------------------------------
-- 4. revise_document() — the one and only writer of a revision
-- ---------------------------------------------------------------------------
create or replace function public.revise_document(
  p_entry_id      uuid,
  p_line_items    jsonb,
  p_amount        numeric,
  p_notes         text default null,
  p_occurred_on   date default null,
  p_description   text default null,
  p_document_meta jsonb default '{}'::jsonb,
  p_document_path text default null,
  p_archive_path  text default null,
  p_pdf_state     text default 'current',
  p_file_size     bigint default null,
  p_client_token  uuid default null
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
  if p_client_token is not null
     and coalesce(v_entry.document_meta, '{}'::jsonb) ->> 'last_client_token'
         = p_client_token::text then
    return query select coalesce(v_entry.revision, 1)::int, v_entry.id;
    return;
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

  v_cur_rev := coalesce(v_entry.revision, 1);
  v_email   := public.jwt_email();

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

  v_next_rev := v_cur_rev + 1;

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

comment on function public.revise_document(uuid, jsonb, numeric, text, date, text, jsonb, text, text, text, bigint, uuid) is
  'Revise an estimate / invoice / contract in place and append its history. '
  'The only writer of finance_entry_revisions. Admin-only (raises 42501), '
  'idempotent per p_client_token, asserts amount = document_meta.totals.total.';

revoke all on function public.revise_document(uuid, jsonb, numeric, text, date, text, jsonb, text, text, text, bigint, uuid) from public, anon;
grant execute on function public.revise_document(uuid, jsonb, numeric, text, date, text, jsonb, text, text, text, bigint, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Access on the history table
-- ---------------------------------------------------------------------------
alter table public.finance_entry_revisions enable row level security;

-- Money. Same predicate as fin_admin_select, and only SELECT: there is no
-- insert / update / delete policy on purpose (see the table comment).
drop policy if exists fer_admin_select on public.finance_entry_revisions;
create policy fer_admin_select on public.finance_entry_revisions
  for select using (public.is_company_admin(company));

-- ---------------------------------------------------------------------------
-- 6. my_documents() v2 — the portal learns about revisions
-- ---------------------------------------------------------------------------
-- Postgres will not add columns to an existing function's return type, so
-- this is a drop + recreate rather than a create-or-replace. Same body, same
-- filters, same ordering — two columns wider.
drop function if exists public.my_documents();

/**
 * The signed-in customer's paperwork: their estimates, invoices and payments.
 * Expenses are deliberately excluded — that is our cost base, not theirs.
 * v2 (2026-08-22) adds revision + pdf_state so the portal can label "Rev 3"
 * and hide a View PDF button whose bytes are known to be out of date.
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
  document_path text,
  revision integer,
  pdf_state text
)
language sql
stable
security definer
set search_path = public
as $$
  select f.id, f.job_id, j.job_number, f.type, f.amount, f.occurred_on,
         f.status, f.document_number, f.document_path,
         coalesce(f.revision, 1),
         coalesce(f.document_meta ->> 'pdf_state', 'current')
    from public.finance_entries f
    join public.jobs j on j.id = f.job_id
   where j.customer_id is not null
     and j.customer_id = public.my_customer_id()
     and f.type in ('invoice', 'estimate', 'payment')
   order by f.occurred_on desc nulls last;
$$;

revoke all on function public.my_documents() from public, anon;
grant execute on function public.my_documents() to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Storage — let a customer open their OWN invoice / estimate PDF
-- ---------------------------------------------------------------------------
-- Additive: the four existing "contracts *" policies are untouched, and
-- Postgres ORs permissive policies, so admins keep exactly what they had.
--
-- The allow-list has to come out of a SECURITY DEFINER function, not an
-- inline subquery. A policy expression runs with the CALLER's privileges, so
-- an inline `select f.document_path from finance_entries f join jobs j …`
-- is itself filtered by fin_admin_select and jobs_member_select — for a
-- customer that subquery returns zero rows and the policy silently grants
-- nothing. (Proven by impersonation before this was changed: the customer saw
-- 0 of their own 2 PDFs.) my_customer_id() already had to be definer for the
-- same reason.
create or replace function public.my_document_paths()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select f.document_path
    from public.finance_entries f
    join public.jobs j on j.id = f.job_id
   where j.customer_id is not null
     and j.customer_id = public.my_customer_id()
     and f.type in ('invoice', 'estimate')
     and f.document_path is not null;
$$;

comment on function public.my_document_paths() is
  'Storage object names the signed-in customer is allowed to open in the '
  'contracts bucket. Exists only to back the "contracts customer read own '
  'documents" policy, which cannot read finance_entries on its own.';

revoke all on function public.my_document_paths() from public, anon;
grant execute on function public.my_document_paths() to authenticated;

-- The match is on the exact object NAME, never a prefix. The contracts bucket
-- is laid out as <job_id>/<file>, and a job's folder also holds subcontractor
-- agreements, permits and materials lists that are none of the homeowner's
-- business. A `name like job_id || '/%'` policy would hand those over too.
-- Payments are excluded here (a payment "document" is a receipt scan from the
-- ops console, not something we render) — my_documents() still lists them.
drop policy if exists "contracts customer read own documents" on storage.objects;
create policy "contracts customer read own documents" on storage.objects
  for select using (
    bucket_id = 'contracts'
    and public.my_customer_id() is not null
    and name in (select public.my_document_paths())
  );

commit;

-- Verify (expect jd_select/jd_insert/jd_update/jd_delete, and exactly ONE
-- policy on finance_entry_revisions):
--   select tablename, policyname, cmd from pg_policies
--    where schemaname = 'public'
--      and tablename in ('job_documents', 'finance_entry_revisions')
--    order by tablename, policyname;
--
-- Verify the barrier by SIMULATING the user, not by reading the policy:
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"email":"snettleton2005@gmail.com","role":"authenticated"}';
--   select count(*) from public.finance_entries;            -- expect: 0
--   select count(*) from public.finance_entry_revisions;    -- expect: 0
--   select * from public.revise_document('<a real estimate id>'::uuid,
--     '[{"name":"x","qty":1,"rate":1}]'::jsonb, 1);         -- expect: 42501
--   select count(*) from storage.objects where bucket_id = 'contracts';
--                                                           -- expect: 0
--   rollback;
