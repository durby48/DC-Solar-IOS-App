-- The inspection is NOT free (Devon, 2026-10-12): it is included with every
-- Solar Shield subscription. Swaps only the three phrases that said "free",
-- so any other edits made in CRM Settings → Sales resources are kept.
-- Idempotent: a second run finds nothing to replace.

begin;

update public.sales_resources
set body = replace(replace(replace(body,
      '"Would you want a second set of eyes after this storm anyway? The inspection is free."',
      '"Would you want a second set of eyes after this storm anyway? A full inspection comes with every Solar Shield plan."'),
      '- A FREE solar inspection: our crew checks the panels, wiring, racking and inverter, and tells you exactly what we find.',
      '- A full solar inspection, included with your Solar Shield plan: our crew checks the panels, wiring, racking and inverter, and tells you exactly what we find.'),
      '- A quote for the Solar Shield program, powered by DC Solar: yearly protection in Bronze, Silver or Gold. (Plans & prices has the numbers.)',
      '- The Solar Shield program, powered by DC Solar: yearly protection in Bronze, Silver or Gold, with the inspection and cleaning built in. (Plans & prices has the numbers.)'),
    updated_at = now()
where company = 'dc-solar'
  and kind = 'script'
  and (body like '%The inspection is free%' or body like '%A FREE solar inspection%');

-- The offer's lead-in and the booking line follow suit.
update public.sales_resources
set body = replace(body,
      '"What day works for the inspection? I have [day] or [day] open."',
      '"Which plan sounds right for you? Let''s get your first visit on the calendar. I have [day] or [day] open."'),
    updated_at = now()
where company = 'dc-solar' and kind = 'script'
  and body like '%"What day works for the inspection? I have [day] or [day] open."%';

commit;
