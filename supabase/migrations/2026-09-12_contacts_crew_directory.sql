-- Contacts for the whole company (2026-09-12, same day as contacts_tags).
--
-- Devon: contacts are "useful contacts for myself and my employees to have".
-- phone_directory() answered only admins, so the Contacts tab was empty for
-- the crew even though `contacts` and `customers` are member-readable
-- tables. The function now returns the customer + contact rows to any company
-- member; leads and colleagues' cell numbers (staff_profiles) remain
-- admin-only exactly as before. Same signature, same grants. Idempotent.

begin;

drop function if exists public.phone_directory();

create function public.phone_directory()
returns table (
  source       text,
  id           uuid,
  display_name text,
  subtitle     text,
  phone_e164   text,
  sort_key     text,
  archived     boolean,
  customer_id  uuid,
  tags         text[],
  title        text
)
language sql
security definer
set search_path = public
stable
as $$
  with everyone as (
    select 'customer'::text as source,
           c.id,
           c.name as display_name,
           c.address as subtitle,
           c.phone_e164,
           c.archived_at is not null as archived,
           1 as priority,
           null::uuid as customer_id,
           '{}'::text[] as tags,
           null::text as title
      from public.customers c
     where c.company = 'dc-solar'

    union all

    select 'contact',
           k.id,
           k.name,
           k.org,
           k.phone_e164,
           k.archived_at is not null,
           2,
           k.customer_id,
           case when cardinality(k.tags) > 0 then k.tags
                when k.kind is not null and k.kind <> '' then array[k.kind]
                else '{}'::text[] end,
           k.title
      from public.contacts k
     where k.company = 'dc-solar'

    union all

    select 'crew',
           e.id,
           coalesce(e.display_name, e.email),
           initcap(e.role),
           sp.cell_phone_e164,
           false,
           3,
           null::uuid,
           '{}'::text[],
           null::text
      from public.employees e
      left join public.staff_profiles sp
        on sp.company = e.company
       and lower(sp.email) = lower(e.email)
     where e.company = 'dc-solar'
       and e.is_test = false

    union all

    select 'lead',
           l.id,
           l.name,
           l.status,
           l.phone_e164,
           false,
           4,
           null::uuid,
           '{}'::text[],
           null::text
      from public.leads l
     where l.company = 'dc-solar'
  ),
  deduped as (
    select distinct on (coalesce(e.phone_e164, e.source || ':' || e.id::text))
           e.source, e.id, e.display_name, e.subtitle, e.phone_e164, e.archived,
           e.customer_id, e.tags, e.title
      from everyone e
     order by coalesce(e.phone_e164, e.source || ':' || e.id::text), e.priority, e.display_name
  )
  select d.source,
         d.id,
         d.display_name,
         d.subtitle,
         d.phone_e164,
         lower(coalesce(d.display_name, '')) as sort_key,
         d.archived,
         d.customer_id,
         d.tags,
         d.title
    from deduped d
   where public.is_company_admin('dc-solar')
      -- Members (the crew) get the company directory too — customers and the
      -- imported contacts, both of which they may already read straight from
      -- the tables. Leads and colleagues' cell numbers stay admin-only.
      or (public.is_company_member('dc-solar') and d.source in ('customer', 'contact'))
   order by lower(coalesce(d.display_name, '')), d.source;
$$;

revoke all on function public.phone_directory() from public, anon;
grant execute on function public.phone_directory() to authenticated;

commit;

-- Verify (rolled back):
--   begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"email":"snettleton2005@gmail.com","role":"authenticated"}';
--   select source, count(*) from public.phone_directory() group by source;  -- customer + contact only
--   set local request.jwt.claims = '{"email":"devonsd311@gmail.com","role":"authenticated"}';
--   select source, count(*) from public.phone_directory() group by source;  -- all four sources
--   rollback;
