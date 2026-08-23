-- Deleting a job: one definer function, never a DELETE policy.
-- (2026-08-23)
--
-- ASCII ONLY, ON PURPOSE. scripts/db/query.ps1 reads migrations with
-- `Get-Content -Raw`, which on Windows PowerShell 5.1 decodes a BOM-less file
-- as ANSI. An em dash in this file becomes three mojibake characters in
-- pg_proc.prosrc, and the user-facing refusal messages below are exactly the
-- text Devon reads in the app. Keep every character in this file 7-bit.
--
-- WHY THIS EXISTS
--
-- Devon needs to remove a job that was created by mistake (DC-26033), and he
-- needs the NEXT job he creates to take that number back rather than leaving a
-- hole in the sequence. The number half of that lives in the app
-- (`lib/jobs.ts::nextJobNumber`, now a smallest-unused search). This file is
-- the database half.
--
-- WHY NOT A DELETE POLICY ON public.jobs
--
-- `jobs` deliberately has SELECT / INSERT / UPDATE policies and no DELETE
-- policy. Seventeen tables reference jobs.id and only nine of those FKs are
-- ON DELETE SET NULL or CASCADE; the rest are NO ACTION, so a raw
-- `delete from jobs` from the client would fail with 23503 and, if those FKs
-- were ever relaxed, would silently orphan hours, receipts and inventory
-- movements. Worse, three of the child tables hold MONEY or PAYROLL:
-- finance_entries, employee_hours, time_entries. A delete button that can
-- vaporise $56k of payments because someone fat-fingered a row is not a
-- feature. So: no DELETE policy, and one SECURITY DEFINER function that knows
-- the whole graph and refuses the dangerous cases.
--
-- THE FK GRAPH THIS FUNCTION IS WRITTEN AGAINST (dumped 2026-08-23)
--
--   ON DELETE CASCADE   job_artwork, job_schedule_dates
--   ON DELETE SET NULL  cards, customer_notes, employee_hours,
--                       finance_entries, leads(converted_job_id),
--                       media_assets, messages
--   NO ACTION           inventory_transactions, job_assignments,
--                       job_documents, job_materials, job_photos,
--                       monitoring_logins, receipts, time_entries
--
-- The function does not rely on the CASCADE/SET NULL behaviour: it does every
-- one of these explicitly, in order, so the return value can report exactly
-- what happened and so a future FK change cannot quietly alter the outcome.
--
-- THREE RULES IT ENFORCES
--
-- 1. MONEY AND HOURS ARE NEVER DELETED. finance_entries, employee_hours,
--    time_entries, receipts and inventory_transactions rows survive; only
--    their job_id is set to null. A payment that loses its job is a
--    bookkeeping annoyance. A payment that is gone is a missing deposit.
--
-- 2. A JOB THAT HAS MONEY OR HOURS ON IT REFUSES TO DELETE (P0001) unless the
--    caller passes p_force. The message names the counts so the UI can say
--    "DC-26033 has 2 payments and 5 hours entries". The exception carries
--    HINT = 'force' precisely when p_force would get past it, which is how the
--    app decides whether to offer the "Un-assign and delete anyway" button.
--    The internal company job raises with HINT = 'never': no force gets past
--    that one, because company overhead, mileage and shop time all post to it.
--
-- 3. FILES ARE THE CLIENT'S JOB. Storage lives outside Postgres, so the
--    function returns the object paths it just orphaned, GROUPED BY BUCKET,
--    and the app removes them best-effort afterwards (admins hold delete
--    policies on contracts / job-photos / property-art). Grouped and not a
--    flat list because `storage.from(bucket).remove(paths)` cannot be called
--    without knowing the bucket.
--
-- KNOWN SIDE EFFECT: job_assignments has an AFTER DELETE notify trigger, so
-- each assigned crew member gets a "Removed from job" push. The job row is
-- already gone by the time the async pg_net call lands, so the push reads
-- "You've been taken off a job." That is noisy but correct, and suppressing it
-- would mean editing notify_webhook(), which finance_entries also uses.
--
-- Idempotent: safe to re-run. Creates no table, seeds nothing, adds no policy.

begin;

create or replace function public.delete_job(p_job_id uuid, p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job          public.jobs%rowtype;
  v_label        text;

  -- Blockers
  v_payments     int := 0;
  v_invoices     int := 0;   -- invoice + contract
  v_emp_hours    int := 0;
  v_time_entries int := 0;
  v_problems     text[] := '{}';

  -- Storage paths handed back to the client
  v_contracts    text[] := '{}';
  v_photos       text[] := '{}';
  v_art          text[] := '{}';

  -- Counters for the receipt
  n_finance      int := 0;
  n_emp_hours    int := 0;
  n_time         int := 0;
  n_receipts     int := 0;
  n_notes        int := 0;
  n_messages     int := 0;
  n_cards        int := 0;
  n_media        int := 0;
  n_leads        int := 0;
  n_inventory    int := 0;
  n_monitoring   int := 0;
  n_schedule     int := 0;
  n_assignments  int := 0;
  n_materials    int := 0;
  n_documents    int := 0;
  n_photos       int := 0;
  n_artwork      int := 0;
begin
  if p_job_id is null then
    raise exception 'delete_job: a job id is required' using errcode = '22023';
  end if;

  -- Authorisation FIRST, and the same answer whether or not the id exists, so
  -- this cannot be used to probe which job ids are real.
  if not public.is_company_admin('dc-solar') then
    raise exception 'delete_job: only owners and operators can delete a project'
      using errcode = '42501';
  end if;

  select * into v_job from public.jobs j where j.id = p_job_id;

  if v_job.id is null then
    raise exception 'delete_job: that project no longer exists'
      using errcode = 'P0002';
  end if;

  if v_job.company is distinct from 'dc-solar' then
    raise exception 'delete_job: refusing to delete a project from another company'
      using errcode = '22023';
  end if;

  v_label := coalesce(v_job.job_number, 'This project');

  -- Rule 3: the internal company job is the bucket every overhead expense,
  -- shop hour and mileage entry posts to. Not deletable at any force.
  if coalesce(v_job.is_internal, false) then
    raise exception
      '% is the internal company project. Company overhead, shop hours and mileage all post to it, so it cannot be deleted.', v_label
      using errcode = 'P0001', hint = 'never';
  end if;

  -- ------------------------------------------------------------------
  -- Blockers: money and payroll attached to this job
  -- ------------------------------------------------------------------
  select count(*) into v_payments
    from public.finance_entries f
   where f.job_id = p_job_id and f.type = 'payment';

  select count(*) into v_invoices
    from public.finance_entries f
   where f.job_id = p_job_id and f.type in ('invoice', 'contract');

  select count(*) into v_emp_hours
    from public.employee_hours h where h.job_id = p_job_id;

  select count(*) into v_time_entries
    from public.time_entries t where t.job_id = p_job_id;

  if v_payments > 0 then
    v_problems := v_problems ||
      format('%s payment%s', v_payments, case when v_payments = 1 then '' else 's' end);
  end if;
  if v_invoices > 0 then
    v_problems := v_problems ||
      format('%s invoice%s', v_invoices, case when v_invoices = 1 then '' else 's' end);
  end if;
  if v_emp_hours > 0 then
    v_problems := v_problems ||
      format('%s hours entr%s', v_emp_hours, case when v_emp_hours = 1 then 'y' else 'ies' end);
  end if;
  if v_time_entries > 0 then
    v_problems := v_problems ||
      format('%s clock entr%s', v_time_entries, case when v_time_entries = 1 then 'y' else 'ies' end);
  end if;

  if array_length(v_problems, 1) is not null and not coalesce(p_force, false) then
    raise exception
      '% has % on it. That money and those hours are never deleted, but they will be un-assigned from the project.',
      v_label, array_to_string(v_problems, ' and ')
      using errcode = 'P0001', hint = 'force';
  end if;

  -- ------------------------------------------------------------------
  -- Money and payroll: un-assign, never delete. Same on both paths.
  -- ------------------------------------------------------------------
  update public.finance_entries f set job_id = null where f.job_id = p_job_id;
  get diagnostics n_finance = row_count;

  update public.employee_hours h set job_id = null where h.job_id = p_job_id;
  get diagnostics n_emp_hours = row_count;

  update public.time_entries t set job_id = null where t.job_id = p_job_id;
  get diagnostics n_time = row_count;

  -- Receipts hold a dollar amount and a photo of the paperwork; the row and
  -- its file both stay, only the job link goes.
  update public.receipts r set job_id = null where r.job_id = p_job_id;
  get diagnostics n_receipts = row_count;

  -- Stock movements are a ledger too: never rewrite history, just unlink.
  update public.inventory_transactions i set job_id = null where i.job_id = p_job_id;
  get diagnostics n_inventory = row_count;

  -- ------------------------------------------------------------------
  -- Things that merely POINT at the job and outlive it
  -- ------------------------------------------------------------------
  update public.customer_notes n set job_id = null where n.job_id = p_job_id;
  get diagnostics n_notes = row_count;

  update public.messages m set job_id = null where m.job_id = p_job_id;
  get diagnostics n_messages = row_count;

  -- Trading cards are collectibles: the card survives its job.
  update public.cards c set job_id = null where c.job_id = p_job_id;
  get diagnostics n_cards = row_count;

  update public.media_assets a set job_id = null where a.job_id = p_job_id;
  get diagnostics n_media = row_count;

  update public.leads l set converted_job_id = null where l.converted_job_id = p_job_id;
  get diagnostics n_leads = row_count;

  -- The customer's monitoring-portal credential belongs to the house, not to
  -- the work order.
  update public.monitoring_logins ml set job_id = null where ml.job_id = p_job_id;
  get diagnostics n_monitoring = row_count;

  -- ------------------------------------------------------------------
  -- Storage paths, collected BEFORE the rows that name them are deleted
  -- ------------------------------------------------------------------
  select coalesce(array_agg(d.storage_path), '{}')
    into v_contracts
    from public.job_documents d
   where d.job_id = p_job_id and d.storage_path is not null;

  select coalesce(array_agg(p.storage_path), '{}')
    into v_photos
    from public.job_photos p
   where p.job_id = p_job_id and p.storage_path is not null;

  select coalesce(array_agg(a.art_path), '{}')
    into v_art
    from public.job_artwork a
   where a.job_id = p_job_id and a.art_path is not null;

  -- ------------------------------------------------------------------
  -- Dependants that only exist because the job exists
  -- ------------------------------------------------------------------
  -- job_materials.source_document_id -> job_documents(id) is NO ACTION, and a
  -- material line on a DIFFERENT job can cite a document filed under this one
  -- (the extractor copies a materials list between jobs). Unlink those first
  -- or the job_documents delete below fails with 23503.
  update public.job_materials m
     set source_document_id = null
   where m.source_document_id in (
     select d.id from public.job_documents d where d.job_id = p_job_id
   );

  delete from public.job_materials m where m.job_id = p_job_id;
  get diagnostics n_materials = row_count;

  delete from public.job_documents d where d.job_id = p_job_id;
  get diagnostics n_documents = row_count;

  delete from public.job_photos p where p.job_id = p_job_id;
  get diagnostics n_photos = row_count;

  delete from public.job_artwork a where a.job_id = p_job_id;
  get diagnostics n_artwork = row_count;

  delete from public.job_assignments ja where ja.job_id = p_job_id;
  get diagnostics n_assignments = row_count;

  delete from public.job_schedule_dates sd where sd.job_id = p_job_id;
  get diagnostics n_schedule = row_count;

  delete from public.jobs j where j.id = p_job_id;

  return jsonb_build_object(
    'deleted', true,
    'job_id', p_job_id,
    'job_number', v_job.job_number,
    'job_name', v_job.name,
    'forced', coalesce(p_force, false),
    -- Grouped by bucket: storage.from(bucket).remove(paths) needs the bucket.
    'storage_paths', jsonb_build_object(
      'contracts',    to_jsonb(v_contracts),
      'job-photos',   to_jsonb(v_photos),
      'property-art', to_jsonb(v_art)
    ),
    'nulled', jsonb_build_object(
      'finance_entries',        n_finance,
      'employee_hours',         n_emp_hours,
      'time_entries',           n_time,
      'receipts',               n_receipts,
      'inventory_transactions', n_inventory,
      'customer_notes',         n_notes,
      'messages',               n_messages,
      'cards',                  n_cards,
      'media_assets',           n_media,
      'leads',                  n_leads,
      'monitoring_logins',      n_monitoring
    ),
    'removed', jsonb_build_object(
      'job_materials',      n_materials,
      'job_documents',      n_documents,
      'job_photos',         n_photos,
      'job_artwork',        n_artwork,
      'job_assignments',    n_assignments,
      'job_schedule_dates', n_schedule
    )
  );
end;
$$;

comment on function public.delete_job(uuid, boolean) is
  'Delete one dc-solar job and everything that only exists because of it '
  '(schedule dates, crew assignments, materials, documents, photos, artwork), '
  'un-assigning - never deleting - money, hours, receipts and stock movements. '
  'Admin only (42501). Refuses (P0001, HINT=force) when the job carries '
  'payments/invoices/hours unless p_force; refuses the internal company job '
  'always (P0001, HINT=never). Returns the orphaned storage paths grouped by '
  'bucket so the client can remove the files best-effort. There is no DELETE '
  'policy on public.jobs and there must not be one.';

revoke all on function public.delete_job(uuid, boolean) from public, anon;
grant execute on function public.delete_job(uuid, boolean) to authenticated;

commit;

-- Verify by SIMULATING the caller, never by reading the grant. Every probe
-- below is wrapped so nothing persists.
--
--   -- a viewer must be refused (expect 42501):
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"email":"snettleton2005@gmail.com","role":"authenticated"}';
--   select public.delete_job((select id from public.jobs limit 1));
--   rollback;
--
--   -- the internal job must be refused even with force (expect P0001/never):
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"email":"devonsd311@gmail.com","role":"authenticated"}';
--   select public.delete_job(
--     (select id from public.jobs where is_internal), true);
--   rollback;
