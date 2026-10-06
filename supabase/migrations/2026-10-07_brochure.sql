-- The public brochure page (2026-10-07): app.dcsolarkc.com/brochure?rep=<slug>.
--
-- A customer opens it from a text, signed in to nothing, so it reads through
-- two narrow functions granted to anon — nothing else is exposed:
--   public_service_plans()  label, yearly amount, "what's included" per tier
--   public_rep_contact(slug) a rep's display name and their DC Solar WORK
--                            number (voice_routes), looked up by their voice
--                            identity slug (staff_profiles.voice_identity, e.g.
--                            "gogreenken"). Never an email, never a cell.
-- Plus a company saved text, "Service plan info", whose {{brochure_link}} the
-- app fills with the sending rep's own link.
--
-- Idempotent: safe to re-run.

begin;

create or replace function public.public_service_plans()
returns table (tier text, label text, amount_cents integer, includes text)
language sql stable security definer set search_path = public as $$
  select sp.tier, sp.label, sp.amount_cents, sp.includes
    from service_plans sp
   where sp.company = 'dc-solar'
   order by sp.sort;
$$;

create or replace function public.public_rep_contact(p_slug text)
returns table (name text, phone text)
language sql stable security definer set search_path = public as $$
  select coalesce(e.display_name, 'DC Solar'), vr.number_e164
    from staff_profiles p
    join employees e on lower(e.email) = lower(p.email) and e.company = p.company
    left join voice_routes vr on lower(vr.assigned_to) = lower(p.email) and vr.company = p.company
   where p.company = 'dc-solar'
     and p.voice_identity = lower(trim(coalesce(p_slug, '')))
     and e.role in ('sales', 'sales_manager', 'owner', 'operator')
   limit 1;
$$;

revoke all on function public.public_service_plans() from public;
grant execute on function public.public_service_plans() to anon, authenticated;
revoke all on function public.public_rep_contact(text) from public;
grant execute on function public.public_rep_contact(text) to anon, authenticated;

insert into public.message_templates (company, key, title, body, channel, active, sort)
values ('dc-solar', 'brochure', 'Service plan info',
        'Hi {{customer_first}}, here''s a quick look at DC Solar''s solar service plans: {{brochure_link}} Reply STOP to opt out.',
        'sms', true, 15)
on conflict (company, key) do nothing;

commit;
