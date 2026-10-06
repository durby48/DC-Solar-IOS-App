-- Sales resources (2026-10-07): the brochure, the call script, situations,
-- objections — what a rep needs while selling. Carson: one main script, then a
-- section of situations; admins manage it.
--
-- sales_resources: one row per piece.
--   kind 'script'     the main call script (one, normally)
--        'situation'  "if it's this kind of call…" add-ons
--        'objection'  "if they say X, say Y"
--        'file'       an uploaded PDF (the brochure) in the private
--                     'sales-resources' storage bucket, opened by signed URL
--   body             light markup: "# heading", "## sub", "- bullet", blank
--                    line between paragraphs (rendered by the app)
-- Every employee may read (reps sell with it); admins write. The starter
-- content below is a DRAFT for Carson and Devon to edit in CRM Settings →
-- Sales resources — no claims about DC Solar that are not already true.
--
-- Idempotent: safe to re-run (seeds only when the table is empty).

begin;

create table if not exists public.sales_resources (
  id          uuid primary key default gen_random_uuid(),
  company     text not null default 'dc-solar',
  kind        text not null check (kind in ('script', 'situation', 'objection', 'file')),
  title       text not null,
  body        text,
  file_path   text,
  sort        integer not null default 100,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
create index if not exists sales_resources_kind_idx on public.sales_resources (company, kind, sort);

alter table public.sales_resources enable row level security;
drop policy if exists sr_staff_select on public.sales_resources;
create policy sr_staff_select on public.sales_resources for select using (public.is_company_staff(company));
drop policy if exists sr_admin_insert on public.sales_resources;
create policy sr_admin_insert on public.sales_resources for insert with check (public.is_company_admin(company));
drop policy if exists sr_admin_update on public.sales_resources;
create policy sr_admin_update on public.sales_resources for update
  using (public.is_company_admin(company)) with check (public.is_company_admin(company));
drop policy if exists sr_admin_delete on public.sales_resources;
create policy sr_admin_delete on public.sales_resources for delete using (public.is_company_admin(company));

insert into storage.buckets (id, name, public) values ('sales-resources', 'sales-resources', false)
on conflict (id) do nothing;
drop policy if exists "sales resources read" on storage.objects;
create policy "sales resources read" on storage.objects for select
  using (bucket_id = 'sales-resources' and public.is_company_staff('dc-solar'));
drop policy if exists "sales resources upload" on storage.objects;
create policy "sales resources upload" on storage.objects for insert
  with check (bucket_id = 'sales-resources' and public.is_company_admin('dc-solar'));
drop policy if exists "sales resources replace" on storage.objects;
create policy "sales resources replace" on storage.objects for update
  using (bucket_id = 'sales-resources' and public.is_company_admin('dc-solar'));
drop policy if exists "sales resources delete" on storage.objects;
create policy "sales resources delete" on storage.objects for delete
  using (bucket_id = 'sales-resources' and public.is_company_admin('dc-solar'));

-- ---------------------------------------------------------------------------
-- Starter content (draft)
-- ---------------------------------------------------------------------------
insert into public.sales_resources (company, kind, title, body, sort)
select * from (values
('dc-solar', 'script', 'Call script', $s$# 1. Opening
- "Hi, is this [name]? This is [your name] with DC Solar, here in Kansas City. Do you have a minute?"
- "We take care of solar systems around KC. I'm calling because your property at [address] has solar, and we help owners keep it producing like it should."

# 2. Learn about their system
- "How long have you had the panels?"
- "Who installed them, and are they still taking care of it?"
- "When was the system last cleaned or checked?"
- "Do you keep an eye on how much it's producing? Noticed it dropping?"

Listen more than you talk. Note what they say in the lead.

# 3. Why service matters
- Dirt, pollen, bird droppings and debris build up and cut how much power the panels make.
- Small problems — a loose connection, a failing inverter, a monitoring outage — can go unnoticed for months while the system underproduces.
- "Our service plan sends a DC Solar crew out once a year to inspect, clean and check your system, and you get a report on what we found."

# 4. The plans
- Bronze, Silver and Gold — see Plans & prices for what each includes.
- Every plan is billed yearly with a 2-year agreement.
- Nothing is charged until after the first visit.

# 5. Book the visit
- "Want me to get you on the schedule? I have [day] or [day] open." (Book visit shows the open days.)
- Get their name, phone, email and the address.
- "I'll text you a secure link to save a card — it isn't charged until after we've been out."

# 6. Not ready yet
- "No problem — when's a good time for me to follow up?" Set a follow-up task.
- "Is it okay if I text you our plan info?" Only text if they say yes.
$s$, 1),
('dc-solar', 'situation', 'Commercial — permit list owner', $s$## Who you're calling
A business or property owner whose building got a solar permit (the imported KC lists). The number is often a front desk or a property manager.

## How to open
- Ask for whoever handles the building or facilities: "Who takes care of the solar on your building at [address]?"
- "We noticed the city permit for solar at your building and wanted to make sure someone's looking after it."

## Good to know
- Commercial systems are bigger, so lost production costs more — that's your angle.
- Pricing for larger systems is often a Custom price; book an Inspection first if you're not sure.
- These leads are call-first: you can't text them until you've had a real conversation.
$s$, 10),
('dc-solar', 'situation', 'Homeowner — residential', $s$## How to open
- Friendly and short: "Hi, I'm with DC Solar here in KC — we keep home solar systems clean and running."

## What matters to them
- Their power bill. Lower production means a higher bill.
- Not having to climb on the roof or worry about it.

## Close
- Most homeowners fit Bronze or Silver. Book a Cleaning.
$s$, 20),
('dc-solar', 'situation', '"My installer handles that"', $s$## What to say
- "Great — do they come out once a year to clean and check it, or only when something breaks?"
- "A lot of installers stop by only for warranty problems. We do the yearly upkeep so small issues get caught early."
- "If your installer is no longer around, we can take over looking after it."

## Don't
- Don't badmouth their installer. Stay positive.
$s$, 30),
('dc-solar', 'situation', 'Storm / hail damage', $s$## When
After a hail or wind storm in their area.

## What to say
- "We're checking in with solar owners after the storm. Hail and debris can crack panels or loosen wiring, and it isn't always visible from the ground."
- "We can come out, inspect everything and tell you exactly what we find."

## Book
- Book an Inspection. If there's damage, the crew documents it.
$s$, 40),
('dc-solar', 'situation', 'Renewal — existing customer', $s$## When
A plan is coming up on its yearly renewal.

## What to say
- "It's almost time for your yearly service — let's get you on the schedule."
- Ask how the system has been doing since the last visit.

## Book
- Book their visit; the plan renews on its own.
$s$, 50),
('dc-solar', 'objection', 'Too expensive', $s$- "I get it. Think about what the system cost — the plan is a small amount each year to protect that."
- "Lost production adds up over a year. Keeping it clean and working helps it pay for itself."
- "And nothing is charged until after the first visit, so you can see the work first."
- Offer the plan that fits their budget (Bronze), or a Custom price if it makes sense.
$s$, 10),
('dc-solar', 'objection', 'Not interested', $s$- "Totally fine. Can I ask — when was the last time anyone checked the system?"
- If still no: "No problem. Can I check back in a few months?" Set a follow-up task, or close it out with the reason.
$s$, 20),
('dc-solar', 'objection', 'My panels are fine', $s$- "That's great to hear. Do you watch the production numbers?"
- "Most problems — dirt buildup, a loose connection — don't show from the ground. That's why a yearly check is worth it."
- "We can do a one-time inspection and you'll know for sure."
$s$, 30),
('dc-solar', 'objection', 'I need to think about it / talk to my spouse', $s$- "Of course. What questions can I answer to help you decide?"
- "Can I text you the plan info so you both can look at it?" (only with their okay)
- Set a follow-up for 2–3 days out: "I'll check back Thursday — does that work?"
$s$, 40)
) as v(company, kind, title, body, sort)
where not exists (select 1 from public.sales_resources);

commit;
