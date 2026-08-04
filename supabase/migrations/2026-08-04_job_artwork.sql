-- Property artwork per job (2026-08-04 overhaul).
--
-- Each job gets ONE cartoon illustration of its actual property, used as the
-- semi-opaque background of its pipeline card. The picture is sourced from
-- Google Street View using jobs.address (or replaced by a photo Devon takes),
-- then run through the `property-art` edge function to cartoonify it. The
-- finished PNG lives in the private `property-art` storage bucket.
--
-- Idempotent: safe to re-run.

create table if not exists public.job_artwork (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  company text not null default 'dc-solar',
  -- 'streetview' = auto-fetched from the address, 'photo' = Devon's own shot.
  source text not null default 'streetview',
  -- Path in the property-art bucket for the finished cartoon.
  art_path text,
  -- The address (or photo path) the art was generated from. Lets us detect
  -- "the address changed, this artwork is stale" without guessing.
  source_ref text,
  -- pending | ready | failed
  status text not null default 'pending',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists job_artwork_job_id_key on public.job_artwork (job_id);

alter table public.job_artwork enable row level security;

-- Everyone in the company can SEE the artwork (it's on every pipeline card);
-- only admins can create or change it.
drop policy if exists ja_art_select on public.job_artwork;
create policy ja_art_select on public.job_artwork for select
  using (public.is_company_member(company));

drop policy if exists ja_art_insert on public.job_artwork;
create policy ja_art_insert on public.job_artwork for insert
  with check (public.is_company_admin(company));

drop policy if exists ja_art_update on public.job_artwork;
create policy ja_art_update on public.job_artwork for update
  using (public.is_company_admin(company))
  with check (public.is_company_admin(company));

drop policy if exists ja_art_delete on public.job_artwork;
create policy ja_art_delete on public.job_artwork for delete
  using (public.is_company_admin(company));

-- Private bucket: these are pictures of customers' homes tied to job records,
-- so they stay behind signed URLs like every other customer document.
insert into storage.buckets (id, name, public)
values ('property-art', 'property-art', false)
on conflict (id) do nothing;

drop policy if exists "property art read" on storage.objects;
create policy "property art read" on storage.objects for select
  using (bucket_id = 'property-art' and public.is_company_member('dc-solar'));

drop policy if exists "property art upload" on storage.objects;
create policy "property art upload" on storage.objects for insert
  with check (bucket_id = 'property-art' and public.is_company_admin('dc-solar'));

drop policy if exists "property art update" on storage.objects;
create policy "property art update" on storage.objects for update
  using (bucket_id = 'property-art' and public.is_company_admin('dc-solar'))
  with check (bucket_id = 'property-art' and public.is_company_admin('dc-solar'));

drop policy if exists "property art delete" on storage.objects;
create policy "property art delete" on storage.objects for delete
  using (bucket_id = 'property-art' and public.is_company_admin('dc-solar'));
