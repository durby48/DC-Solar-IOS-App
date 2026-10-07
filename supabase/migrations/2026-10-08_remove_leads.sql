-- Remove leads (2026-10-08, Carson). "Remove" HIDES a lead everywhere — the
-- app's lead reads skip `removed_at is not null` — and an admin can restore it
-- or delete it for good from the Removed leads screen.
--
--   remove_leads(ids)          admins + the sales manager: any lead; a rep:
--                              leads they added by hand (created_by = them,
--                              not from an import). A lead with a booked
--                              visit (scheduled / visit_done) is never
--                              removed — cancel the visit first.
--   restore_leads(ids)         admins
--   delete_leads_forever(ids)  admins; only leads already removed. Tasks,
--                              appointments, status history and projections
--                              go with the lead (FK cascade); messages and
--                              quote requests keep their row, unlinked.
--
-- Each returns how many it changed and how many it skipped, so the app can say
-- "Removed 12 · 1 has a booked visit". Idempotent.

begin;

alter table public.leads add column if not exists removed_at timestamptz;
alter table public.leads add column if not exists removed_by text;
create index if not exists leads_removed_idx on public.leads (company, removed_at) where removed_at is not null;

create or replace function public.remove_leads(p_ids uuid[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_me      text := lower(coalesce(public.jwt_email(), ''));
  v_manager boolean := public.is_company_admin('dc-solar') or public.is_sales_manager('dc-solar');
  v_total   integer;
  v_booked  integer;
  v_done    integer;
begin
  if v_me = '' or not public.is_company_staff('dc-solar') then
    raise exception 'staff only' using errcode = '42501';
  end if;
  select count(*), count(*) filter (where status in ('scheduled', 'visit_done'))
    into v_total, v_booked
    from leads where company = 'dc-solar' and id = any(coalesce(p_ids, '{}')) and removed_at is null;
  update leads
     set removed_at = now(), removed_by = v_me
   where company = 'dc-solar'
     and id = any(coalesce(p_ids, '{}'))
     and removed_at is null
     and status not in ('scheduled', 'visit_done')
     and (v_manager or (lower(coalesce(created_by, '')) = v_me and import_batch is null));
  get diagnostics v_done = row_count;
  return jsonb_build_object(
    'removed', v_done,
    'booked', v_booked,
    'not_allowed', greatest(v_total - v_booked - v_done, 0));
end;
$$;

create or replace function public.restore_leads(p_ids uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare v_done integer;
begin
  if not public.is_company_admin('dc-solar') then
    raise exception 'admins only' using errcode = '42501';
  end if;
  update leads set removed_at = null, removed_by = null
   where company = 'dc-solar' and id = any(coalesce(p_ids, '{}')) and removed_at is not null;
  get diagnostics v_done = row_count;
  return v_done;
end;
$$;

create or replace function public.delete_leads_forever(p_ids uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare v_done integer;
begin
  if not public.is_company_admin('dc-solar') then
    raise exception 'admins only' using errcode = '42501';
  end if;
  delete from leads
   where company = 'dc-solar' and id = any(coalesce(p_ids, '{}')) and removed_at is not null;
  get diagnostics v_done = row_count;
  return v_done;
end;
$$;

revoke all on function public.remove_leads(uuid[]) from public, anon;
revoke all on function public.restore_leads(uuid[]) from public, anon;
revoke all on function public.delete_leads_forever(uuid[]) from public, anon;
grant execute on function public.remove_leads(uuid[]) to authenticated;
grant execute on function public.restore_leads(uuid[]) to authenticated;
grant execute on function public.delete_leads_forever(uuid[]) to authenticated;

commit;
