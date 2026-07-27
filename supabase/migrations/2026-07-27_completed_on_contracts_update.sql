-- Migration 10: jobs.completed_on + missing storage policies on the
-- contracts bucket. Run in Supabase dashboard → SQL Editor. Re-runnable.
--
-- (a) completed_on: date a project was completed. The app sets it
--     automatically when a job's stage is changed to Complete (and clears
--     it when the stage moves back), and it is editable in the job editor.
-- (b) contracts bucket: document PDFs upload with upsert=true, but the
--     bucket only had INSERT + SELECT policies — re-generating a document
--     whose file already exists hits the UPDATE path and fails with
--     "new row violates row-level security policy". Add admin UPDATE and
--     DELETE, matching the existing admin-only INSERT/SELECT.

alter table public.jobs add column if not exists completed_on date;

drop policy if exists "contracts update" on storage.objects;
create policy "contracts update" on storage.objects for update
  using (bucket_id = 'contracts' and public.is_company_admin('dc-solar'))
  with check (bucket_id = 'contracts' and public.is_company_admin('dc-solar'));

drop policy if exists "contracts delete" on storage.objects;
create policy "contracts delete" on storage.objects for delete
  using (bucket_id = 'contracts' and public.is_company_admin('dc-solar'));
