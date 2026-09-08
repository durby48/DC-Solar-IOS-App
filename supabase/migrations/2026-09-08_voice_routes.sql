-- Inbound voice routing: which employee a Twilio number rings (2026-09-08).
--
-- WHY. `twilio-voice-inbound` v1 rang EVERY owner/operator who had a voice
-- identity. Carson wants the main number to ring Devon only, with a
-- deliberate fallback, and the next need is obvious — another number for
-- Isaiah — so this is the smallest thing that is a routing table rather
-- than a hard-coded email: one row per Twilio number, one assigned person.
--
-- WHAT IT DOES NOT DO. No ring groups, no schedules, no UI. A number with no
-- row rings nobody in the app and has no cell fallback (the caller hears the
-- apology and the admins get a missed-call push) — an unrouted number is
-- something to notice, not something to guess about.
--
-- FALLBACK is derived, not stored: the assigned person's own
-- `staff_profiles.cell_phone_e164` (when `voice_bridge_enabled`), which is
-- exactly what the old "owner's cell" resolved to for Devon.
--
-- RLS: admins read/write (same shape as comms_settings); nobody else needs
-- it — the edge function reads it with the service role.
--
-- Idempotent: safe to re-run; the seed never overwrites an edited row.

begin;

create table if not exists public.voice_routes (
  number_e164 text primary key,
  company     text not null default 'dc-solar',
  /** employees.email of the person this number rings, in the app first, then on their cell. */
  assigned_to text not null,
  label       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint voice_routes_number_e164_check check (number_e164 ~ '^\+[1-9][0-9]{7,14}$')
);

comment on table public.voice_routes is
  'Which employee an inbound call to a Twilio number rings (app, then their cell). '
  'One row per number. Read by twilio-voice-inbound with the service role.';

drop trigger if exists voice_routes_touch on public.voice_routes;
create trigger voice_routes_touch
  before update on public.voice_routes
  for each row execute function public.crm_touch_updated_at();

alter table public.voice_routes enable row level security;

drop policy if exists voice_routes_admin_select on public.voice_routes;
create policy voice_routes_admin_select on public.voice_routes
  for select using (public.is_company_admin(company));

drop policy if exists voice_routes_admin_insert on public.voice_routes;
create policy voice_routes_admin_insert on public.voice_routes
  for insert with check (public.is_company_admin(company));

drop policy if exists voice_routes_admin_update on public.voice_routes;
create policy voice_routes_admin_update on public.voice_routes
  for update using (public.is_company_admin(company)) with check (public.is_company_admin(company));

drop policy if exists voice_routes_admin_delete on public.voice_routes;
create policy voice_routes_admin_delete on public.voice_routes
  for delete using (public.is_company_admin(company));

-- The main DC Solar number rings Devon. Never overwrites a later edit.
insert into public.voice_routes (number_e164, company, assigned_to, label)
values ('+18167446473', 'dc-solar', 'devonsd311@gmail.com', 'Main office number')
on conflict (number_e164) do nothing;

commit;
