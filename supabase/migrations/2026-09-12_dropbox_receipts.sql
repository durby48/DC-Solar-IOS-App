-- Dropbox: every employee receipt goes into a receipts-only Dropbox folder.
-- (2026-09-12, later the same day as the job-folder work)
--
-- WHY THIS EXISTS
--
-- Devon: "I need to make sure that every receipt uploaded by us employees
-- goes into a dropbox folder for just receipts." Crews photograph receipts in
-- the field app into the private `receipts` bucket (`<email local part>/
-- <epochMs>-<name>.jpg`) and insert a `receipts` row; until now those never
-- reached Dropbox.
--
-- HOW IT WORKS — same design as job photos, same queue table, same cron.
--
--   receipts INSERT (with a storage_path)
--     └─ trigger inserts a `dropbox_photo_mirrors` row (source 'receipt',
--        status 'queued') and fires pg_net POST
--        {action:'mirror_receipt', receipt_id} at dropbox-sync.
--   every 15 minutes (pg_cron `dropbox-mirror-retry`, unchanged)
--     └─ POST {action:'retry_mirrors'}: the function drains queued/failed
--        rows of BOTH sources (it branches on `source`).
--
-- The function files each receipt at
--   /DC Solar/Receipts/<YYYY-MM>/<YYYY-MM-DD> <first name> <category> [<job number>] <amount>.<ext>
-- with mode=add + autorename: Dropbox stays an append-only ARCHIVE. Deleting
-- or rejecting a receipt in the app never deletes the Dropbox copy.
--
-- WHY THE SAME TABLE. `dropbox_photo_mirrors` already has the status /
-- attempts / last_error / dropbox_* bookkeeping, the pending index, the
-- admin-only RLS and the retry cron. A `source` column plus a nullable
-- `receipt_id` is a smaller change than a second table and a second drain.
--
-- SCHEMA CHANGE ON dropbox_photo_mirrors
--   + source      text  'job_photo' | 'receipt'   (default 'job_photo')
--   + receipt_id  uuid  → receipts(id) ON DELETE CASCADE, unique when set
--   ~ job_id      now nullable — a receipt need not belong to a job
--   + check: a 'receipt' row has receipt_id and no photo_id; a 'job_photo'
--     row has job_id and no receipt_id. (A literal "exactly one of photo_id /
--     receipt_id" is NOT used on purpose: photo_id is ON DELETE SET NULL, so
--     deleting a photo in the app would violate it.)
--
-- NOTHING HERE CAN FAIL A RECEIPT. The trigger swallows every error, pg_net
-- is asynchronous, and a lost nudge costs fifteen minutes.
--
-- Idempotent: safe to re-run. No secret in this file — the trigger goes
-- through the existing dropbox_sync_post().

begin;

-- ---------------------------------------------------------------------------
-- 1. dropbox_photo_mirrors: source + receipt_id, job_id nullable
-- ---------------------------------------------------------------------------
alter table public.dropbox_photo_mirrors
  add column if not exists source text not null default 'job_photo';

alter table public.dropbox_photo_mirrors
  add column if not exists receipt_id uuid references public.receipts(id) on delete cascade;

alter table public.dropbox_photo_mirrors
  alter column job_id drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.dropbox_photo_mirrors'::regclass
       and conname  = 'dropbox_photo_mirrors_source_check'
  ) then
    alter table public.dropbox_photo_mirrors
      add constraint dropbox_photo_mirrors_source_check
      check (source in ('job_photo', 'receipt'));
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.dropbox_photo_mirrors'::regclass
       and conname  = 'dropbox_photo_mirrors_source_shape_check'
  ) then
    alter table public.dropbox_photo_mirrors
      add constraint dropbox_photo_mirrors_source_shape_check
      check (
        (source = 'job_photo' and receipt_id is null and job_id is not null)
        or
        (source = 'receipt' and receipt_id is not null and photo_id is null)
      );
  end if;
end
$$;

create unique index if not exists dropbox_photo_mirrors_receipt_uq
  on public.dropbox_photo_mirrors (receipt_id) where receipt_id is not null;

create index if not exists dropbox_photo_mirrors_source_idx
  on public.dropbox_photo_mirrors (source, status);

comment on table public.dropbox_photo_mirrors is
  'Every job photo (source job_photo) and every employee receipt (source '
  'receipt) copied to Dropbox, with its Dropbox id and status (queued / '
  'mirrored / failed / skipped). Photos land in the job folder, receipts in '
  '/DC Solar/Receipts/<YYYY-MM>. Written only by the dropbox-sync edge '
  'function. Admin SELECT, no client writes. Dropbox is an append-only '
  'archive: an app-side delete never removes the Dropbox file.';

comment on column public.dropbox_photo_mirrors.source is
  'job_photo (row keyed by photo_id, needs job_id) or receipt (row keyed by receipt_id; job_id optional).';

-- ---------------------------------------------------------------------------
-- 2. Trigger — enqueue a row, then nudge the function. Never fail the write.
-- ---------------------------------------------------------------------------
-- A receipt submitted without a photo has nothing to mirror and gets no row;
-- the app never attaches a file after the fact (storage_path is set on insert).
create or replace function public.dropbox_receipt_mirror_enqueue()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if new.storage_path is null or length(trim(new.storage_path)) = 0 then
      return new;
    end if;
    insert into public.dropbox_photo_mirrors
        (source, receipt_id, job_id, company, storage_bucket, storage_path)
      values
        ('receipt', new.id, new.job_id, coalesce(new.company, 'dc-solar'), 'receipts', new.storage_path)
      on conflict (receipt_id) where receipt_id is not null do nothing;
    perform public.dropbox_sync_post(
      jsonb_build_object('action', 'mirror_receipt', 'receipt_id', new.id)
    );
  exception when others then
    -- The employee's receipt must never fail because of Dropbox.
    raise warning 'dropbox_receipt_mirror_enqueue: %', sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists receipts_dropbox_mirror_trg on public.receipts;
create trigger receipts_dropbox_mirror_trg
  after insert on public.receipts
  for each row
  execute function public.dropbox_receipt_mirror_enqueue();

-- ---------------------------------------------------------------------------
-- 3. dropbox_enqueue_receipts — the backfill's enqueue half (service role)
-- ---------------------------------------------------------------------------
-- Adds a queued row for every receipt that has a file and no mirror row yet,
-- oldest first, bounded per call; optionally resets failed RECEIPT rows to
-- queued with attempts = 0. Pure bookkeeping — no HTTP, no Dropbox. (The
-- existing dropbox_enqueue_backlog(..., p_reset_failed => true) also resets
-- failed rows of every source; that is fine and intended.)
create or replace function public.dropbox_enqueue_receipts(
  p_limit int default 200,
  p_reset_failed boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enqueued int := 0;
  v_reset    int := 0;
begin
  insert into public.dropbox_photo_mirrors
      (source, receipt_id, job_id, company, storage_bucket, storage_path)
  select 'receipt', r.id, r.job_id, coalesce(r.company, 'dc-solar'), 'receipts', r.storage_path
    from public.receipts r
   where r.storage_path is not null
     and length(trim(r.storage_path)) > 0
     and not exists (select 1 from public.dropbox_photo_mirrors m where m.receipt_id = r.id)
   order by r.created_at
   limit greatest(coalesce(p_limit, 0), 0);
  get diagnostics v_enqueued = row_count;

  if p_reset_failed then
    update public.dropbox_photo_mirrors
       set status = 'queued', attempts = 0, updated_at = now()
     where source = 'receipt' and status = 'failed';
    get diagnostics v_reset = row_count;
  end if;

  return jsonb_build_object(
    'receipts_enqueued', v_enqueued,
    'reset', v_reset
  );
end;
$$;

revoke all on function public.dropbox_enqueue_receipts(int, boolean) from public, anon, authenticated;

commit;

-- ===========================================================================
-- VERIFY (run after applying; everything below is read-only or rolled back)
-- ===========================================================================
--
-- Schema:
--   select column_name, is_nullable, column_default from information_schema.columns
--    where table_name = 'dropbox_photo_mirrors' and column_name in ('source', 'receipt_id', 'job_id');
--   -- expect: source NO 'job_photo', receipt_id YES, job_id YES
--
--   select conname from pg_constraint where conrelid = 'public.dropbox_photo_mirrors'::regclass
--    order by conname;
--   -- expect dropbox_photo_mirrors_source_check and _source_shape_check among them
--
--   select tgname, tgrelid::regclass from pg_trigger
--    where tgname in ('receipts_dropbox_mirror_trg', 'job_photos_dropbox_mirror_trg');
--   -- expect both (the photo trigger is untouched)
--
--   select jobid, jobname, schedule, active from cron.job where jobname = 'dropbox-mirror-retry';
--   -- unchanged
--
-- Existing photo rows still satisfy the new check (0 means fine):
--   select count(*) from public.dropbox_photo_mirrors
--    where not ((source = 'job_photo' and receipt_id is null and job_id is not null)
--            or (source = 'receipt' and receipt_id is not null and photo_id is null));
--
-- The client roles cannot enqueue receipts:
--   select has_function_privilege('authenticated', 'public.dropbox_enqueue_receipts(int,boolean)', 'execute') as auth,
--          has_function_privilege('anon',          'public.dropbox_enqueue_receipts(int,boolean)', 'execute') as anon;
--   -- expect: false, false
--
-- RLS is inherited (admin SELECT only) — a viewer sees no receipt rows:
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"email":"snettleton2005@gmail.com","role":"authenticated"}';
--   select count(*) from public.dropbox_photo_mirrors where source = 'receipt';   -- expect 0
--   rollback;
--
-- The trigger never breaks a receipt insert, even with Dropbox down — rolled
-- back, as the postgres role:
--   begin;
--   insert into public.receipts (company, employee, amount, description, category, storage_path)
--     values ('dc-solar', 'probe@example.com', 1, 'dropbox probe', 'other', 'probe/0-probe.jpg')
--     returning id;
--   select source, status, attempts, storage_bucket from public.dropbox_photo_mirrors
--    where receipt_id = (select id from public.receipts where description = 'dropbox probe');
--   -- expect: receipt, queued, 0, receipts
--   rollback;
--
-- A receipt with no file gets no row:
--   begin;
--   insert into public.receipts (company, employee, amount, description, category)
--     values ('dc-solar', 'probe@example.com', 1, 'dropbox probe nofile', 'other');
--   select count(*) from public.dropbox_photo_mirrors
--    where receipt_id = (select id from public.receipts where description = 'dropbox probe nofile');
--   -- expect 0
--   rollback;
--
-- Watch it work:
--   select source, status, count(*) from public.dropbox_photo_mirrors group by 1, 2 order by 1, 2;
--   select status, attempts, dropbox_path_display, last_error from public.dropbox_photo_mirrors
--    where source = 'receipt' order by updated_at desc limit 20;
