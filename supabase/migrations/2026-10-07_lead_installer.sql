-- The original solar installer on a lead, and "update existing" imports
-- (2026-10-07).
--
-- leads.installer — the company that installed the property's solar (Carson
-- is getting it added to the permit list). It is ALSO written into the lead's
-- notes as "Original installer: <name>" (Carson: it should be in the notes),
-- and the CRM can filter on the column.
--
-- import_leads(p_source, p_rows, p_update):
--   p_update = false (as before) — a row whose phone/email + address already
--                     matches a lead or customer is skipped.
--   p_update = true  — a row matching an existing LEAD fills in what that lead
--                     is missing: installer, email, phone (never overwrites),
--                     and appends the "Original installer" note line once.
--                     So a re-sent list can add installers to the 242 KC leads
--                     without re-importing them. Customers are never touched.
-- Rows may carry "installer"; a new lead gets the column and the note line.
--
-- The old 2-argument function is dropped first so PostgREST sees one version
-- (the default keeps every existing caller working).
--
-- Idempotent: safe to re-run.

begin;

alter table public.leads add column if not exists installer text;
comment on column public.leads.installer is
  'The company that originally installed the solar at this address (imported); also in notes as "Original installer: …".';

drop function if exists public.import_leads(text, jsonb);

create or replace function public.import_leads(p_source text, p_rows jsonb, p_update boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_company   text := 'dc-solar';
  v_source    text := nullif(trim(coalesce(p_source, '')), '');
  v_row       jsonb;
  v_name      text;
  v_phone     text;
  v_email     text;
  v_address   text;
  v_installer text;
  v_notes     text;
  v_key       text;
  v_lead      uuid;
  v_seen      text[] := '{}';
  v_inserted  integer := 0;
  v_updated   integer := 0;
  v_existing  integer := 0;
  v_invalid   integer := 0;
  v_dupes     integer := 0;
begin
  if not public.is_company_admin(v_company) then
    raise exception 'admins only' using errcode = '42501';
  end if;
  if v_source is null then
    raise exception 'name this import (its source)' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'send at most 5,000 rows at a time' using errcode = '22023';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_name      := nullif(trim(coalesce(v_row->>'name', '')), '');
    v_phone     := nullif(trim(coalesce(v_row->>'phone', '')), '');
    v_email     := nullif(lower(trim(coalesce(v_row->>'email', ''))), '');
    v_address   := nullif(trim(coalesce(v_row->>'address', '')), '');
    v_installer := nullif(left(trim(coalesce(v_row->>'installer', '')), 120), '');
    v_notes     := nullif(left(trim(coalesce(v_row->>'notes', '')), 4000), '');
    if v_installer is not null and position('Original installer:' in coalesce(v_notes, '')) = 0 then
      v_notes := concat_ws(E'\n', 'Original installer: ' || v_installer, v_notes);
    end if;

    if v_name is null or (v_phone is null and v_email is null) then
      v_invalid := v_invalid + 1;
      continue;
    end if;
    v_key := public.lead_match_key(v_phone, v_email, v_address);
    if v_key = any(v_seen) then
      v_dupes := v_dupes + 1;
      continue;
    end if;
    v_seen := v_seen || v_key;

    select l.id into v_lead
      from public.leads l
     where l.company = v_company and public.lead_match_key(l.phone, l.email, l.address) = v_key
     order by l.created_at
     limit 1;

    if v_lead is not null then
      if p_update then
        update public.leads l
           set installer = coalesce(nullif(l.installer, ''), v_installer),
               email     = coalesce(nullif(l.email, ''), v_email),
               phone     = coalesce(nullif(l.phone, ''), v_phone),
               notes     = case
                 when v_installer is null or position('Original installer:' in coalesce(l.notes, '')) > 0 then l.notes
                 else concat_ws(E'\n', 'Original installer: ' || v_installer, nullif(l.notes, ''))
               end
         where l.id = v_lead
           and (
             (v_installer is not null and coalesce(l.installer, '') = '')
             or (v_email is not null and coalesce(l.email, '') = '')
             or (v_phone is not null and coalesce(l.phone, '') = '')
           );
        if found then
          v_updated := v_updated + 1;
        else
          v_existing := v_existing + 1;
        end if;
      else
        v_existing := v_existing + 1;
      end if;
      continue;
    end if;

    if exists (select 1 from public.customers c
                where c.company = v_company and public.lead_match_key(c.phone, c.email, c.address) = v_key) then
      v_existing := v_existing + 1;
      continue;
    end if;

    insert into public.leads
      (company, name, phone, email, address, source, status, notes, assigned_to, call_first, import_batch, installer)
    values
      (v_company, left(v_name, 200), v_phone, v_email, v_address, left(v_source, 120), 'new',
       v_notes, null, true, left(v_source, 120), v_installer);
    v_inserted := v_inserted + 1;
  end loop;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'skipped_existing', v_existing,
                            'skipped_invalid', v_invalid, 'skipped_duplicate', v_dupes);
end;
$$;

revoke all on function public.import_leads(text, jsonb, boolean) from public, anon;
grant execute on function public.import_leads(text, jsonb, boolean) to authenticated;

commit;
