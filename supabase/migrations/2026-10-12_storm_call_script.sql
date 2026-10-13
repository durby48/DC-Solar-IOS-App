-- The storm call script (2026-10-12, Devon): opens on the lead's own storm,
-- heads off early objections with questions, asks who maintains and cleans the
-- system, then offers a free solar inspection, roof inspection documents for
-- their roofing partner, and a Solar Shield (Bronze / Silver / Gold) quote.
--
-- Merge fields — the CRM's Script panel fills them for the open lead or
-- customer (app/src/lib/callScript.ts); anything it cannot fill shows as a
-- highlighted blank. A line that is ONLY an empty field is skipped.
--   {{first_name}}    their first name
--   {{storm_date}}    the day of their last hail (≥ 1 in within 3 mi), e.g.
--                     "Tuesday, August 19th"; else the latest storm the rep has
--   {{storm_detail}}  "Reports put 1.75-inch hail about 1.2 miles from …" or empty
--   {{street}}        street address (before the first comma)
--   {{rep_first}}     the rep's first name
--
-- Replaces the 2026-10-07 starter script ONLY if nobody has edited it since
-- (updated_by is null); an edited script is left alone. Idempotent.

begin;

update public.sales_resources
set body = $s$# 1. Open with their storm
- "Hey {{first_name}}, this is {{rep_first}} with DC Solar here in Kansas City. Was your solar system hit by that storm on {{storm_date}}?"
- {{storm_detail}}
- Not sure? "Most hail damage can't be seen from the ground. Cracked glass, chipped cells and loose wiring usually show up months later as lower production."

# 2. Get ahead of the early objections
Ask these before they have a reason to say no.
- They think it's a sales call: "I'm not calling to sell you solar. You already have it. We're the local crew that looks after systems like yours."
- "Have you noticed your production or your power bill change since the storm?"
- "My panels are fine": "That's great. When was the last time anyone was actually up on the roof checking them?"
- "My installer handles that": "Good. Do they still come out for upkeep, or only when something breaks?"
- "Not right now": "If something did get damaged, would you rather find out now, while it's fresh, or months from now on your bill?"

# 3. Who's looking after it?
- "Do you have a system maintainer, someone who services and monitors the system for you?"
- "And do you have a panel cleaning partner? Dirt, pollen and storm debris cut production. A system that's cleaned and checked regularly lasts longer and keeps producing like it should."
- If they have neither: "That's exactly what we do."
- If they have both: "Would you want a second set of eyes after this storm anyway? The inspection is free."

# 4. The offer
"Here's what we can do for you, {{first_name}}:"
- A FREE solar inspection: our crew checks the panels, wiring, racking and inverter, and tells you exactly what we find.
- Roof inspection documents: photos and notes on the roof around your panels, ready to hand to your preferred roofing partner.
- A quote for the Solar Shield program, powered by DC Solar: yearly protection in Bronze, Silver or Gold. (Plans & prices has the numbers.)

# 5. Book it
- "What day works for the inspection? I have [day] or [day] open." Book visit shows the open days.
- Get their name, phone, email and the address. All four are needed to book.
- "Can I text you the Solar Shield info so you can look it over?" Only text if they say yes.

# 6. Not ready yet
- "No problem. When's a good time for me to follow up?" Set a follow-up task.
- Mark them Hot, Warm or Cold so the follow-up is easy to find.
$s$,
    title = 'Storm call script',
    updated_at = now()
where company = 'dc-solar'
  and kind = 'script'
  and updated_by is null;

commit;
