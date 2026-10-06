-- my_phone_line(): the caller's own DC Solar number (2026-10-06, Sales Home).
--
-- voice_routes is admin-only in RLS, which is right for the table: it is the
-- map of every number to every person. But a sales rep's Home greeting shows
-- "your number", so each employee may read THEIR OWN line through this
-- function — one E.164 string or null, nothing about anyone else.
--
-- Idempotent: safe to re-run.

begin;

create or replace function public.my_phone_line()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select vr.number_e164
    from public.voice_routes vr
   where vr.company = 'dc-solar'
     and lower(vr.assigned_to) = lower(public.jwt_email())
   order by vr.created_at
   limit 1;
$$;

revoke all on function public.my_phone_line() from public, anon;
grant execute on function public.my_phone_line() to authenticated;

commit;
