-- Signed-in devices on the Security screen (2026-08-25).
--
-- WHY A FUNCTION AND NOT A TABLE POLICY: the session list lives in
-- `auth.sessions`, which PostgREST does not expose and which no client key can
-- reach. Rather than copy session data into `public` (a second copy of the
-- truth, instantly stale), three SECURITY DEFINER functions read it in place
-- and hand back only what belongs to the caller. Same shape as the customer
-- portal's `my_projects()` / `my_documents()`: the function chooses the rows
-- AND the columns, so a client cannot widen the query.
--
-- THE SECURITY BOUNDARY IS `user_id = auth.uid()`, once per function. There is
-- deliberately no "look at someone else's devices" path, not even for admins:
-- an owner who needs to boot a crew member out does it from the Supabase
-- dashboard, where it is logged. This screen is "my devices", nothing more.
--
-- WHAT THE CALLER GETS: no tokens, ever. The id (needed to revoke), when the
-- session started, when it was last refreshed, the raw user agent, the IP, the
-- assurance level (aal2 = a second factor was used), and whether it is the
-- device asking. `auth.jwt() ->> 'session_id'` is what makes that last one
-- possible — GoTrue stamps the session id into every access token.
--
-- REVOKING IS A REAL SIGN-OUT: `auth.refresh_tokens` and `auth.mfa_amr_claims`
-- both carry ON DELETE CASCADE to `auth.sessions`, verified against the live
-- database before this was written. Deleting the row therefore destroys the
-- refresh tokens with it — the device cannot silently mint a new access token
-- afterwards. It keeps whatever access token it already holds until that
-- expires (max one hour, `jwt_exp` = 3600).
--
-- Idempotent: create-or-replace throughout, safe to re-run.

begin;

-- ---------------------------------------------------------------- list ----
create or replace function public.my_sessions()
returns table (
  id           uuid,
  created_at   timestamptz,
  last_seen_at timestamptz,
  user_agent   text,
  ip           text,
  aal          text,
  is_current   boolean
)
language sql
security definer
set search_path = public, auth
stable
as $$
  select
    s.id,
    s.created_at,
    -- `refreshed_at` is `timestamp WITHOUT time zone` in GoTrue's schema while
    -- the others carry a zone; the cast keeps one type coming out of here.
    coalesce(s.refreshed_at at time zone 'UTC', s.updated_at, s.created_at) as last_seen_at,
    s.user_agent,
    -- `inet` renders with a /32 unless it goes through host().
    host(s.ip)                                                             as ip,
    s.aal::text,
    s.id::text = (auth.jwt() ->> 'session_id')                             as is_current
  from auth.sessions s
  where s.user_id = auth.uid()
  order by 3 desc nulls last;
$$;

comment on function public.my_sessions() is
  'The calling user''s own signed-in devices. No tokens. See 2026-08-25_my_sessions.sql.';

-- -------------------------------------------------------------- revoke ----
create or replace function public.revoke_my_session(target uuid)
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  removed integer;
begin
  if target is null then
    return false;
  end if;

  -- `user_id = auth.uid()` is the entire security boundary. Without it this
  -- function would sign ANY user out of ANY device, which is exactly the kind
  -- of thing SECURITY DEFINER makes possible by accident.
  delete from auth.sessions
   where id = target
     and user_id = auth.uid();

  get diagnostics removed = row_count;
  return removed > 0;
end;
$$;

comment on function public.revoke_my_session(uuid) is
  'Sign one of MY devices out. Returns false when the id is not mine.';

-- Sign out everywhere but here. Separate from the loop-in-the-client version
-- so it is one statement: revoking sessions one at a time from the app would
-- leave a half-finished state if the network dropped midway.
create or replace function public.revoke_my_other_sessions()
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  removed integer;
  here    text := auth.jwt() ->> 'session_id';
begin
  delete from auth.sessions
   where user_id = auth.uid()
     -- `is distinct from` so a missing session_id claim (there should not be
     -- one, but a stale token shape would) revokes everything rather than
     -- silently revoking nothing.
     and id::text is distinct from here;

  get diagnostics removed = row_count;
  return removed;
end;
$$;

comment on function public.revoke_my_other_sessions() is
  'Sign out every device except the one calling. Returns how many were removed.';

-- Signed-in callers only. `anon` must never reach these: with no `auth.uid()`
-- the list would be empty, but a public EXECUTE grant on a SECURITY DEFINER
-- function that touches `auth` is not something to leave lying around.
revoke all on function public.my_sessions()              from public, anon;
revoke all on function public.revoke_my_session(uuid)    from public, anon;
revoke all on function public.revoke_my_other_sessions() from public, anon;

grant execute on function public.my_sessions()              to authenticated;
grant execute on function public.revoke_my_session(uuid)    to authenticated;
grant execute on function public.revoke_my_other_sessions() to authenticated;

commit;
