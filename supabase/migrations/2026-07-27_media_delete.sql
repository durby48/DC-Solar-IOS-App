-- Migration 12: allow admins to delete stored media files.
-- Applied directly via the Supabase Management API on 2026-07-27. Re-runnable.
--
-- job_photos rows already had an admin DELETE policy (jp_delete), but the
-- job-photos/receipts storage buckets only had SELECT + INSERT — deleting a
-- photo would leave the file orphaned in storage. Admin-only, matching the
-- contracts-bucket policies from migration 10.

drop policy if exists "field app delete media" on storage.objects;
create policy "field app delete media" on storage.objects for delete
  using (bucket_id in ('job-photos','receipts') and public.is_company_admin('dc-solar'));
