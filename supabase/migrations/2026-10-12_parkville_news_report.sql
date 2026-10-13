-- The March 10, 2026 Parkville hailstorm (Devon, 2026-10-12): "4-inch hail in
-- Parkville". NOAA's spotter database has no Parkville point for that evening —
-- its nearest are 4.5 in at 1 NE Weatherby Lake (23:29Z) and 3 in at 2 SW
-- Beverly Hills KS (23:19Z), the storm moving NE between them, just west of
-- downtown Parkville. The 4 in Parkville figure is from KSHB 41 (meteorologist
-- Lauren Rainson: "Parkville saw the largest hail at 4 inches", Tuesday evening).
--
-- Entered as a NEWS report (id 'manual|…', never touched by the SPC sync),
-- placed at downtown Parkville at 23:25Z (between the two NOAA reports). The
-- radar swath for the day is raised by every hail report (storm-sync,
-- applyReports), so this and the NOAA reports lift March 10 from radar's ~1.5 in
-- to the hail that actually fell. Re-run the day: storm-sync { mode: 'radar',
-- days: ['2026-03-10'] }. Idempotent.

begin;

insert into public.storm_reports (id, company, kind, size, occurred_at, storm_day, lat, lng, location, county, state, comments)
values (
  'manual|news|2026-03-10|parkville',
  'dc-solar', 'hail', 4.0, '2026-03-10 23:25:00+00', '2026-03-10', 39.1911, -94.6830,
  'Parkville (KSHB 41 news report)', 'Platte', 'MO',
  'Not a NOAA report. KSHB 41, March 10, 2026: "Parkville saw the largest hail at 4 inches" (meteorologist Lauren Rainson).'
)
on conflict (id) do update
  set size = excluded.size, occurred_at = excluded.occurred_at, storm_day = excluded.storm_day,
      lat = excluded.lat, lng = excluded.lng, location = excluded.location, comments = excluded.comments;

commit;
