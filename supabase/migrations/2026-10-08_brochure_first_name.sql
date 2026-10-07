-- Brochure links by first name (2026-10-08, Carson): /brochure?rep=ken, not
-- the email-derived voice identity ("gogreenken").
--
--   staff_profiles.brochure_slug  the rep's first name, lowercase letters only,
--                                 unique per company (ken, ken2, …)
--   my_brochure_slug()            the signed-in employee's slug, made on first
--                                 use from their display name
--   public_rep_contact(slug)      matches the brochure slug OR the old voice
--                                 identity, so links already texted keep working
--
-- Idempotent.

begin;

alter table public.staff_profiles add column if not exists brochure_slug text;
create unique index if not exists staff_profiles_brochure_slug_key
  on public.staff_profiles (company, brochure_slug) where brochure_slug is not null;

-- First name → a free slug ("ken", then "ken2", "ken3", …).
create or replace function public.brochure_slug_for(p_company text, p_name text, p_email text)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_base text := lower(regexp_replace(split_part(trim(coalesce(nullif(p_name, ''), split_part(p_email, '@', 1))), ' ', 1), '[^A-Za-z]', '', 'g'));
  v_try  text;
  n      integer := 1;
begin
  if v_base = '' then v_base := 'rep'; end if;
  v_try := v_base;
  while exists (
    select 1 from staff_profiles
     where company = p_company and brochure_slug = v_try and lower(email) <> lower(p_email)
  ) loop
    n := n + 1;
    v_try := v_base || n;
  end loop;
  return v_try;
end;
$$;

create or replace function public.my_brochure_slug()
returns text language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(coalesce(public.jwt_email(), ''));
  v_name  text;
  v_slug  text;
begin
  if v_email = '' or not public.is_company_staff('dc-solar') then
    return null;
  end if;
  select brochure_slug into v_slug from staff_profiles where company = 'dc-solar' and lower(email) = v_email;
  if v_slug is not null then
    return v_slug;
  end if;
  select display_name into v_name from employees where company = 'dc-solar' and lower(email) = v_email;
  v_slug := public.brochure_slug_for('dc-solar', v_name, v_email);
  insert into staff_profiles (company, email, brochure_slug)
  values ('dc-solar', v_email, v_slug)
  on conflict (company, email) do update set brochure_slug = coalesce(staff_profiles.brochure_slug, excluded.brochure_slug);
  select brochure_slug into v_slug from staff_profiles where company = 'dc-solar' and lower(email) = v_email;
  return v_slug;
end;
$$;

-- Give everyone on the sales side (and the admins) theirs now.
do $$
declare r record;
begin
  for r in
    select lower(e.email) as email, e.display_name
      from employees e
     where e.company = 'dc-solar' and e.role in ('sales', 'sales_manager', 'owner', 'operator') and not coalesce(e.is_test, false)
     order by e.created_at nulls last, e.display_name
  loop
    if not exists (select 1 from staff_profiles where company = 'dc-solar' and lower(email) = r.email and brochure_slug is not null) then
      insert into staff_profiles (company, email, brochure_slug)
      values ('dc-solar', r.email, public.brochure_slug_for('dc-solar', r.display_name, r.email))
      on conflict (company, email) do update set brochure_slug = excluded.brochure_slug;
    end if;
  end loop;
end $$;

create or replace function public.public_rep_contact(p_slug text)
returns table (name text, phone text)
language sql stable security definer set search_path = public as $$
  select coalesce(e.display_name, 'DC Solar'), vr.number_e164
    from staff_profiles p
    join employees e on lower(e.email) = lower(p.email) and e.company = p.company
    left join voice_routes vr on lower(vr.assigned_to) = lower(p.email) and vr.company = p.company
   where p.company = 'dc-solar'
     and (p.brochure_slug = lower(trim(coalesce(p_slug, ''))) or p.voice_identity = lower(trim(coalesce(p_slug, ''))))
     and e.role in ('sales', 'sales_manager', 'owner', 'operator')
   order by (p.brochure_slug = lower(trim(coalesce(p_slug, '')))) desc
   limit 1;
$$;

revoke all on function public.brochure_slug_for(text, text, text) from public, anon, authenticated;
revoke all on function public.my_brochure_slug() from public, anon;
grant execute on function public.my_brochure_slug() to authenticated;
revoke all on function public.public_rep_contact(text) from public;
grant execute on function public.public_rep_contact(text) to anon, authenticated;

commit;
