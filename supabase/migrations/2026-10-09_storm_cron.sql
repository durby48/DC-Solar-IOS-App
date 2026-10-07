-- Storm sync schedule (2026-10-09). APPLIED by scratch script, recorded here.
--
-- The shared secret is NOT in this file. It was generated once and stored in
-- two places: the edge-function secret STORM_SYNC_SECRET (storm-sync checks
-- the x-storm-secret header against it) and Supabase Vault as
-- 'storm_sync_secret' (pg_cron reads it from vault.decrypted_secrets). To
-- rotate: set a new value in both.
--
--   storm-sync     every 30 min  → mode 'sync'    (today + yesterday, alerts)
--   storm-summary  12:00 UTC     → mode 'summary' (7 AM CDT / 6 AM CST)

begin;

create or replace function public.storm_sync_call(p_mode text) returns void
language plpgsql security definer set search_path = public as $f$
begin
  perform net.http_post(
    url := 'https://kjamxfezsathrsbztiln.supabase.co/functions/v1/storm-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'x-storm-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'storm_sync_secret')),
    body := jsonb_build_object('mode', p_mode),
    timeout_milliseconds := 60000);
end $f$;
revoke all on function public.storm_sync_call(text) from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname in ('storm-sync', 'storm-summary');
select cron.schedule('storm-sync', '*/30 * * * *', $c$select public.storm_sync_call('sync')$c$);
select cron.schedule('storm-summary', '0 12 * * *', $c$select public.storm_sync_call('summary')$c$);

commit;
