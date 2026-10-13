-- Commercial call script + Solar Shield-era situations (2026-10-12, Devon).
-- 241 of 242 open leads are commercial (the KC Commercial Solar permit list),
-- and the storm script was written for homeowners.
--
-- sales_resources.audience: 'residential' | 'commercial' | null (null = for
-- everyone). The CRM Script panel and the call screen pick the script whose
-- audience matches the lead (leads.is_commercial); a lead with no matching
-- script falls back to any script.
--
-- New merge fields (app/src/lib/callScript.ts):
--   {{business}}     the lead / customer name (usually the business)
--   {{panel_count}}  "120" — the panels on the lead (a blank until the rep enters it)
--   {{shield_quote}} "For 120 panels, that's Silver at $1,499 a year or Gold
--                    at $1,999 a year." (dropped when the count is unknown)
--
-- Situations / objections from the 2026-10-07 starter set that contradict the
-- Solar Shield plans (cleaning is an add-on now, the inspection comes with the
-- plan, commercial pricing by panel count) are rewritten ONLY if nobody has
-- edited them (updated_by is null). Idempotent.

begin;

alter table public.sales_resources add column if not exists audience text;
alter table public.sales_resources drop constraint if exists sales_resources_audience_check;
alter table public.sales_resources add constraint sales_resources_audience_check
  check (audience is null or audience in ('residential', 'commercial'));

update public.sales_resources set audience = 'residential'
 where company = 'dc-solar' and kind = 'script' and title = 'Storm call script' and audience is null;

insert into public.sales_resources (company, kind, title, body, sort, audience)
select 'dc-solar', 'script', 'Commercial storm call script', $s$# 1. Reach the right person
- "Hi, this is {{rep_first}} with DC Solar here in Kansas City. Who takes care of the solar system on your building at {{street}}?"
- Front desk? "Could you connect me with whoever handles facilities or building maintenance?" Get their name and direct line, and put them in the notes.

# 2. Open with the storm
- "Was the solar system at {{business}} hit by that storm on {{storm_date}}?"
- {{storm_detail}}
- "On a commercial roof, hail damage usually can't be seen from the ground, and a damaged string can quietly cost you production for months."

# 3. Get ahead of the early objections
- "Have you noticed your production or your electric bill change since the storm?"
- "We already have a maintenance company": "Good. Does their contract include voltage readings on every string and thermal imaging, or just a walk-through?"
- "It's under warranty": "Warranties cover defective parts. Storm damage and debris usually aren't covered, and some warranties ask for maintenance records."
- "That's a corporate / property manager decision": "Who should I send the details to? I'll put together a Solar Shield quote for your building."
- "It's not in the budget": "One failed string or inverter can underproduce for months before anyone notices. The plan is built to catch that early."

# 4. The system and who looks after it
- "Roughly how many panels are on the roof?" Put it in Panels on the lead. It sets the price.
- Panels on file: {{panel_count}}
- "Who maintains the system now? And do you have a panel cleaning partner? Dust, pollen and storm debris cut production, and a system that's maintained and cleaned on schedule lasts longer."

# 5. The offer
"Here's what we do for buildings like yours:"
- A full commercial inspection with your Solar Shield plan: voltage and current readings on every string, thermal imaging for hot spots, racking, wiring and inverters.
- A Solar Health Report and roof inspection documents for your roofing contractor, property manager or insurer.
- The Solar Shield program, powered by DC Solar, priced by system size: Bronze $999 a year up to 100 panels, Silver $1,499 up to 250 panels, Gold $1,999 for any size.
- {{shield_quote}}
- Panel cleaning is an optional add-on at your plan's discount.

# 6. Book it
- "When can we get on the roof? I have [day] or [day] open." Book visit, Inspection. The panel count must be on the lead first.
- Get the decision-maker's name, phone and email, and the building address. All four are needed to book.
- Ask about roof access (ladder, hatch, gate codes, hours) and put it in the visit note.

# 7. Not ready yet
- "Who else needs to see this, and when should I follow up?" Set a follow-up task.
- "Can I send you our Solar Shield brochure?" Only send it if they say yes.
$s$, 2, 'commercial'
where not exists (
  select 1 from public.sales_resources where company = 'dc-solar' and kind = 'script' and audience = 'commercial'
);

-- Starter situations / objections that no longer match the plans.
update public.sales_resources set updated_at = now(), body = $s$## Who you're calling
A business or property owner whose building got a solar permit (the imported KC lists). The number is often a front desk or a property manager. Use the Commercial storm call script: the CRM shows it for every Business lead.

## How to open
- Ask for whoever handles the building or facilities: "Who takes care of the solar on your building at [address]?"
- "We noticed the solar permit for your building and wanted to make sure someone's looking after it."

## Pricing
- Commercial Solar Shield is priced by system size: Bronze $999 a year up to 100 panels, Silver $1,499 up to 250, Gold $1,999 for any size.
- Ask how many panels and put it in Panels on the lead. Booking needs it.

## Good to know
- Bigger systems lose more when something fails. That's your angle.
- These leads are call-first: you can't text them until you've had a real conversation.
$s$
where company = 'dc-solar' and kind = 'situation' and title = 'Commercial — permit list owner' and updated_by is null;

update public.sales_resources set updated_at = now(), body = $s$## How to open
- Friendly and short: "Hi, I'm with DC Solar here in KC. We look after home solar systems so they keep producing."

## What matters to them
- Their power bill. Lower production means a higher bill.
- Not having to climb on the roof or worry about it.

## Close
- Most homeowners fit Bronze or Silver. Book the inspection that comes with the plan.
- Panel cleaning is an optional add-on at the plan's discount (5% Bronze, 10% Silver, 15% Gold).
$s$
where company = 'dc-solar' and kind = 'situation' and title = 'Homeowner — residential' and updated_by is null;

update public.sales_resources set updated_at = now(), body = $s$## When
After a hail or wind storm in their area. The CRM fills in their storm date in the call script.

## What to say
- "We're checking in with solar owners after the storm. Hail and debris can crack panels or loosen wiring, and it isn't always visible from the ground."
- "A full inspection comes with every Solar Shield plan: voltage readings, thermal imaging, and a report you can hand to your roofer or insurer."

## Book
- Book an Inspection on a Solar Shield plan. If there's damage, the crew documents it.
$s$
where company = 'dc-solar' and kind = 'situation' and title = 'Storm / hail damage' and updated_by is null;

update public.sales_resources set updated_at = now(), body = $s$- "I get it. Think about what the system cost. The plan is a small amount each year to protect that."
- "Lost production adds up over a year. Catching a problem early keeps the system paying for itself."
- "And nothing is charged until after the first visit, so you see the work first."
- Homes: offer Bronze. Businesses: the tier that covers their panel count (Bronze up to 100 panels). Or a Custom price if it makes sense.
$s$
where company = 'dc-solar' and kind = 'objection' and title = 'Too expensive' and updated_by is null;

update public.sales_resources set updated_at = now(), body = $s$- "That's great to hear. Do you watch the production numbers?"
- "Most problems, like a loose connection or a cracked cell, don't show from the ground. That's why we take voltage readings and use thermal imaging."
- "A full inspection comes with every Solar Shield plan, so you'll know for sure."
$s$
where company = 'dc-solar' and kind = 'objection' and title = 'My panels are fine' and updated_by is null;

commit;
