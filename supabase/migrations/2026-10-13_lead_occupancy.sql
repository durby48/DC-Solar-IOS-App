-- Owner-occupancy on commercial leads (2026-10-13, Devon): the client only
-- wants businesses that own the building they operate from (and so own the
-- solar). Each commercial prospect was checked: permit (KCMO + Missouri city
-- portals) → county assessor owner + mailing address → who operates at the
-- address now (business site / listings / OpenCorporates).
--   occupancy        'verified'   owner and operator are the same/affiliated and
--                                 the operator occupies the building
--                    'unverified' kept, but the evidence was thin — confirm on
--                                 the first call
--                    null         not checked (residential / older leads)
--   occupancy_note   one-line evidence summary
--   building_owner   assessor owner of record (current county roll)
--   website          the business's site, when known
-- Leads that failed (leased, multi-tenant, apartments, government, vacant)
-- were removed with remove_leads() so an admin can restore them.
-- Kansas data was deliberately NOT used (K.S.A. 45-230 / 45-220(c)(2)).
-- Idempotent.

begin;

alter table public.leads
  add column if not exists occupancy text,
  add column if not exists occupancy_note text,
  add column if not exists building_owner text,
  add column if not exists website text;
alter table public.leads drop constraint if exists leads_occupancy_check;
alter table public.leads add constraint leads_occupancy_check check (occupancy is null or occupancy in ('verified', 'unverified'));

commit;
