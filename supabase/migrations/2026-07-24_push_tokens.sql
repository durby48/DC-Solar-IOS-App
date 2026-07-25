-- Migration 9: device push tokens for notifications.
-- Run in Supabase dashboard → SQL Editor. Re-runnable.
--
-- Each signed-in device registers its Expo push token here. Server-side
-- triggers (payment received, contract signed, estimate accepted — the
-- email-integration phase) will read these to send pushes. The app writes
-- through RLS; future edge functions read with the service role (bypasses
-- RLS), so no broad read policy is needed.

create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  company text not null default 'dc-solar',
  email text not null,
  token text not null unique,
  platform text,
  updated_at timestamptz not null default now()
);

alter table public.push_tokens enable row level security;

drop policy if exists "push_tokens_own_select" on public.push_tokens;
create policy "push_tokens_own_select" on public.push_tokens
  for select using (email = public.jwt_email() or public.is_company_admin(company));

drop policy if exists "push_tokens_own_insert" on public.push_tokens;
create policy "push_tokens_own_insert" on public.push_tokens
  for insert with check (email = public.jwt_email());

drop policy if exists "push_tokens_own_update" on public.push_tokens;
create policy "push_tokens_own_update" on public.push_tokens
  for update using (email = public.jwt_email())
  with check (email = public.jwt_email());

drop policy if exists "push_tokens_own_delete" on public.push_tokens;
create policy "push_tokens_own_delete" on public.push_tokens
  for delete using (email = public.jwt_email());
