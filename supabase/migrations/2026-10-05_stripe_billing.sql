-- Stripe billing for service visits: card on file, annual plan charged when
-- the visit is done (2026-10-05, B2).
--
-- WHERE THE MONEY LOGIC LIVES. Three edge functions, not the database:
--   stripe-card-link   — the rep (or an admin) gets a Stripe-hosted page where
--                        the customer saves a card. Card data never touches
--                        DC Solar; Stripe returns only brand + last 4.
--   service-visit-done — the crew's "Visit done": runs
--                        mark_service_visit_done() as the caller, then starts
--                        the customer's annual subscription on the saved card
--                        (year one charged immediately).
--   stripe-webhook     — Stripe's events: card saved, invoice paid, payment
--                        failed, subscription changed.
-- This migration only adds the columns they write.
--
-- WHO CAN SEE IT. Admins (customers / company_settings admin policies). A
-- sales rep can read their own booked customer row (customers_sales_select),
-- so they see "Card on file ✓ Visa •4242" and a payment problem — never a
-- card number, which is not stored anywhere here. Nobody writes these columns
-- from the app: only the edge functions, with the service role.
--
-- THE PLAN PRICE is company_settings.stripe_annual_price_id, so swapping the
-- placeholder $1/year test price for the real one (a NEW Stripe price — Stripe
-- prices cannot be edited) is a settings change, not a release.
--
-- Idempotent: safe to re-run.

begin;

alter table public.company_settings add column if not exists stripe_annual_price_id text;
comment on column public.company_settings.stripe_annual_price_id is
  'Stripe Price (price_…) of the annual service plan a visit''s customer is '
  'subscribed to when the crew marks the visit done. Test-mode placeholder '
  'until the real price is set.';

update public.company_settings
   set stripe_annual_price_id = 'price_1UNJSnIGKObcdHTL2XgRAfyb'
 where company = 'dc-solar' and stripe_annual_price_id is null;

alter table public.customers
  add column if not exists stripe_customer_id     text,
  add column if not exists card_on_file_at        timestamptz,
  add column if not exists card_brand             text,
  add column if not exists card_last4             text,
  add column if not exists stripe_subscription_id text,
  add column if not exists plan_status            text,
  add column if not exists payment_issue          text,
  add column if not exists payment_issue_at       timestamptz;

create unique index if not exists customers_stripe_customer_idx
  on public.customers (stripe_customer_id)
  where stripe_customer_id is not null;

comment on column public.customers.card_on_file_at is
  'When the customer saved a card on the Stripe page (stripe-webhook). Brand '
  'and last 4 only; the card itself lives at Stripe.';
comment on column public.customers.plan_status is
  'The annual plan subscription''s Stripe status: active, past_due, '
  'incomplete, canceled… Null = never subscribed.';
comment on column public.customers.payment_issue is
  'Why the last charge did not go through (declined, no card on file). '
  'Cleared when a payment succeeds. Shown to admins as a flag.';

alter table public.jobs add column if not exists stripe_invoice_id text;
comment on column public.jobs.stripe_invoice_id is
  'Service visits: the Stripe invoice that paid for this visit (service_paid_at).';

commit;
