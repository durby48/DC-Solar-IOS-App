-- Lead temperature (2026-10-08, Carson): Hot / Warm / Cold, a one-tap tag a
-- rep sets on a lead, separate from its stage (a lead can be Contacted and
-- Warm). Null = not set. Reps write it under the existing leads_own_update /
-- leads_manager_update / admin policies; leads_guard_ownership only guards
-- the owner, the job link and the company, so no policy changes.
--
-- Same day: "Closed out" became "Not interested" in the app — a label only;
-- the stored status stays 'lost'.
--
-- Idempotent.

begin;

alter table public.leads add column if not exists temperature text;
alter table public.leads drop constraint if exists leads_temperature_check;
alter table public.leads add constraint leads_temperature_check
  check (temperature is null or temperature in ('hot', 'warm', 'cold'));

commit;
