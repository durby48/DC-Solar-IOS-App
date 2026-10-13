-- Custom-price Solar Shield plans get their own Stripe product (2026-10-12).
-- service-visit-done made a custom yearly price on the BRONZE product, so a
-- rep's custom deal showed up on the customer's invoice as the Bronze plan.
-- Now: company_settings.stripe_custom_product_id (live product "Solar Shield
-- Custom — DC Solar"); service-visit-done falls back to the Bronze product
-- only when this is empty. Idempotent.

begin;

alter table public.company_settings add column if not exists stripe_custom_product_id text;
comment on column public.company_settings.stripe_custom_product_id is
  'Stripe product that custom-price Solar Shield plans are billed on (service-visit-done). Null = the Bronze price''s product.';

commit;
