-- Crew job documents (2026-10-08, Carson): crew can add documents to a job,
-- and see only the ones THEY added — never the office's estimates, invoices
-- or contracts.
--
-- Before this, job_documents and the private `contracts` bucket were
-- admin-only on every verb, so the Documents card on a job showed crew
-- nothing and their uploads failed.
--
--   job_documents  crew SELECT their own rows; INSERT as themselves, any type
--                  except estimate / invoice. Admin policies unchanged.
--   contracts      crew may upload under a job's folder (`<job id>/…`, the
--                  path uploadJobDocument writes) and read only the files of
--                  their own job_documents rows.
--
-- "Crew" = is_company_member(): any employee except sales roles (owners and
-- operators already have the admin policies). Idempotent.

begin;

drop policy if exists jd_crew_select on public.job_documents;
create policy jd_crew_select on public.job_documents for select
  using (public.is_company_member(company) and lower(uploaded_by) = lower(public.jwt_email()));

drop policy if exists jd_crew_insert on public.job_documents;
create policy jd_crew_insert on public.job_documents for insert
  with check (
    public.is_company_member(company)
    and lower(uploaded_by) = lower(public.jwt_email())
    and doc_type not in ('estimate', 'invoice')
  );

drop policy if exists "contracts crew upload" on storage.objects;
create policy "contracts crew upload" on storage.objects for insert
  with check (
    bucket_id = 'contracts'
    and public.is_company_member('dc-solar')
    and (storage.foldername(name))[1] in (select j.id::text from public.jobs j where j.company = 'dc-solar')
  );

drop policy if exists "contracts crew read own" on storage.objects;
create policy "contracts crew read own" on storage.objects for select
  using (
    bucket_id = 'contracts'
    and public.is_company_member('dc-solar')
    and name in (
      select d.storage_path from public.job_documents d
       where d.company = 'dc-solar' and lower(d.uploaded_by) = lower(public.jwt_email())
    )
  );

commit;
