-- The keypad button's missed-call badge (2026-10-09, Carson).
--
-- `calls_seen_at` is when this person last looked at their Recent calls (the
-- Recents tab in the keypad window, or Settings → Recent calls). The badge
-- counts missed incoming calls after it. Kept on staff_profiles so the phone
-- and the website agree; the person updates their own row through the
-- existing sp_self_update policy. Existing rows start at "now", so nobody
-- opens the app to a badge for every missed call in history.
begin;

alter table public.staff_profiles
  add column if not exists calls_seen_at timestamptz not null default now();

commit;
