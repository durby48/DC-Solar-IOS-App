-- Solar Shield tiers (2026-10-12, Devon): what each yearly plan includes.
-- One line per item — the brochure, Plans & prices and the Stripe card page
-- (stripe-card-link) all read service_plans.includes. Prices unchanged
-- (Bronze $299, Silver $499, Gold $899 a year, 2-year agreement).
--
-- Decisions: thermal imaging in EVERY tier; panel cleaning is an OPTIONAL
-- add-on, discounted like panel removal & reinstall (5 / 10 / 15 %); the report
-- is the "Solar Health Report" (not an "appraisal" — no dollar valuation).
-- Idempotent: plain updates by tier.

begin;

update public.service_plans set includes = $i$1 service visit a year
Full inspection: voltage and current readings on every string, plus wiring, racking and inverter
Thermal imaging to find hot spots
Solar Health Report: photos, readings and roof documents for your roofer
Minor repairs (fuses, connectors, loose wiring): labor included, parts extra
Post-hail inspections at a member discount
10% off critter guard
5% off panel removal & reinstall for a new roof
Panel cleaning, optional add-on: 5% off$i$
where company = 'dc-solar' and tier = 'bronze';

update public.service_plans set includes = $i$2 service visits a year (spring and fall)
Full inspection: voltage and current readings on every string, plus wiring, racking and inverter
Thermal imaging to find hot spots
Solar Health Report: photos, readings and roof documents for your roofer
Minor repairs included, up to $50 in parts
Monitoring checked every quarter
Yearly efficiency report: actual vs. expected production
1 post-hail inspection a year included
15% off critter guard
10% off panel removal & reinstall for a new roof
Panel cleaning, optional add-on: 10% off
Priority scheduling$i$
where company = 'dc-solar' and tier = 'silver';

update public.service_plans set includes = $i$2 service visits a year, plus an inspection within 72 hours of every hail storm
Full inspection: voltage and current readings on every string, plus wiring, racking and inverter
Thermal imaging to find hot spots
Solar Health Report with insurance-ready storm photos and roof documents for your roofer
Minor repairs included, parts and labor
Monthly monitoring review with alerts
Quarterly efficiency report: actual vs. expected production
Critter guard installed free, once (up to 30 panels)
15% off panel removal & reinstall for a new roof
Panel cleaning, optional add-on: 15% off
Priority scheduling$i$
where company = 'dc-solar' and tier = 'gold';

-- The call script said cleaning was "built in" — it is an add-on.
update public.sales_resources
set body = replace(body,
      'with the inspection and cleaning built in.',
      'with the inspection built in and discounted panel cleaning.'),
    updated_at = now()
where company = 'dc-solar' and kind = 'script'
  and body like '%with the inspection and cleaning built in.%';

commit;
