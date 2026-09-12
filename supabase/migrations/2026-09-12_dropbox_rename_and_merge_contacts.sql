-- Two follow-ups from the 2026-09-12 overhaul.
--
-- 1. DROPBOX FOLDER RENAMES. Devon: "dropbox folder should be renamed if a
--    job is renumbered." The folder name is `<job_number> - <customer name>`,
--    so it changes when the job's number, name or customer changes, or when
--    the CUSTOMER is renamed. Both cases re-queue the job's folder row and
--    nudge `ensure_job_folder`, which (dropbox-sync v24+) MOVES an existing
--    folder to the expected path instead of creating a second one. A failed
--    move is retried by the 15-minute cron like everything else. Same
--    never-fail-the-write discipline as the insert trigger.
--
-- 2. MERGING CUSTOMERS moves their people and tasks too. `crm_merge_customers`
--    re-pointed jobs, money, documents, notes, messages and portal accounts
--    at the kept record but not `contacts.customer_id` (new 2026-09-12) or
--    `tasks.customer_id` (2026-09-07), so a merge silently orphaned both.
--    Same function, two more UPDATEs, two more counters in the result.
--
-- Idempotent.

begin;

-- ---------------------------------------------------------------------------
-- 1a. jobs: number / name / customer changed → re-queue the folder
-- ---------------------------------------------------------------------------
create or replace function public.dropbox_job_folder_requeue()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if coalesce(new.is_internal, false) then
      return new;
    end if;
    if new.job_number is not distinct from old.job_number
       and new.name is not distinct from old.name
       and new.customer_id is not distinct from old.customer_id then
      return new;
    end if;
    insert into public.dropbox_job_folders (job_id, company)
      values (new.id, coalesce(new.company, 'dc-solar'))
      on conflict (job_id) do update
        set status = case when public.dropbox_job_folders.status = 'skipped' then 'skipped' else 'queued' end,
            updated_at = now();
    perform public.dropbox_sync_post(
      jsonb_build_object('action', 'ensure_job_folder', 'job_id', new.id)
    );
  exception when others then
    raise warning 'dropbox_job_folder_requeue: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists jobs_dropbox_folder_rename_trg on public.jobs;
create trigger jobs_dropbox_folder_rename_trg
  after update of job_number, name, customer_id on public.jobs
  for each row
  execute function public.dropbox_job_folder_requeue();

-- ---------------------------------------------------------------------------
-- 1b. customers: renamed → re-queue every one of their job folders
-- ---------------------------------------------------------------------------
create or replace function public.dropbox_customer_folders_requeue()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  begin
    if new.name is not distinct from old.name then
      return new;
    end if;
    for r in
      select j.id, j.company
        from public.jobs j
       where j.customer_id = new.id
         and coalesce(j.is_internal, false) = false
    loop
      insert into public.dropbox_job_folders (job_id, company)
        values (r.id, coalesce(r.company, 'dc-solar'))
        on conflict (job_id) do update
          set status = case when public.dropbox_job_folders.status = 'skipped' then 'skipped' else 'queued' end,
              updated_at = now();
      perform public.dropbox_sync_post(
        jsonb_build_object('action', 'ensure_job_folder', 'job_id', r.id)
      );
    end loop;
  exception when others then
    raise warning 'dropbox_customer_folders_requeue: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists customers_dropbox_folder_rename_trg on public.customers;
create trigger customers_dropbox_folder_rename_trg
  after update of name on public.customers
  for each row
  execute function public.dropbox_customer_folders_requeue();

-- ---------------------------------------------------------------------------
-- 2. crm_merge_customers: + contacts, + tasks
-- ---------------------------------------------------------------------------
create or replace function public.crm_merge_customers(keep_id uuid, merge_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_keep     public.customers%rowtype;
  v_merge    public.customers%rowtype;
  v_jobs     int := 0;
  v_fin      int := 0;
  v_docs     int := 0;
  v_notes    int := 0;
  v_accts    int := 0;
  v_msgs     int := 0;
  v_contacts int := 0;
  v_tasks    int := 0;
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

  -- (the jobs update also fires jobs_dropbox_folder_rename_trg, so the
  --  merged customer's Dropbox folders move under the kept name)
  update public.jobs j set customer_id = keep_id where j.customer_id = merge_id;
  get diagnostics v_jobs = row_count;

  update public.finance_entries f set customer_id = keep_id where f.customer_id = merge_id;
  get diagnostics v_fin = row_count;

  update public.customer_documents d set customer_id = keep_id where d.customer_id = merge_id;
  get diagnostics v_docs = row_count;

  update public.customer_notes n set customer_id = keep_id where n.customer_id = merge_id;
  get diagnostics v_notes = row_count;

  update public.messages m set customer_id = keep_id where m.customer_id = merge_id;
  get diagnostics v_msgs = row_count;

  update public.customer_accounts a set customer_id = keep_id where a.customer_id = merge_id;
  get diagnostics v_accts = row_count;

  -- The kept record keeps its own primary contact; the merged one's people
  -- come along as ordinary contacts.
  update public.contacts k
     set customer_id = keep_id,
         is_primary  = case when exists (select 1 from public.contacts p
                                          where p.customer_id = keep_id and p.is_primary)
                            then false else k.is_primary end
   where k.customer_id = merge_id;
  get diagnostics v_contacts = row_count;

  update public.tasks t set customer_id = keep_id where t.customer_id = merge_id;
  get diagnostics v_tasks = row_count;

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
    'messages', v_msgs,
    'customer_accounts', v_accts,
    'contacts', v_contacts,
    'tasks', v_tasks
  );
end;
$$;

revoke all on function public.crm_merge_customers(uuid, uuid) from public, anon;
grant execute on function public.crm_merge_customers(uuid, uuid) to authenticated;

commit;

-- Verify (rolled back, as the postgres role):
--   begin;
--   update public.jobs set job_number = 'DC-99999' where job_number = 'DC-26037';
--   select status from public.dropbox_job_folders
--    where job_id = (select id from public.jobs where job_number = 'DC-99999');  -- queued
--   rollback;
