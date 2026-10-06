-- Role labels (2026-10-08): the "viewer" role is shown as "Crew" everywhere
-- (Carson). The stored value stays 'viewer' — only the label changes. The
-- Phone → Contacts directory built its subtitle with initcap(role), which read
-- "Viewer" and "Sales_manager". Body below is the LIVE definition
-- (pg_get_functiondef, 2026-10-08) with only that expression changed.

begin;

CREATE OR REPLACE FUNCTION public.phone_directory()
 RETURNS TABLE(source text, id uuid, display_name text, subtitle text, phone_e164 text, sort_key text, archived boolean, customer_id uuid, tags text[], title text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
           case e.role when 'viewer' then 'Crew' when 'sales_manager' then 'Sales manager'
                         else initcap(e.role) end,
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
$function$;

commit;
