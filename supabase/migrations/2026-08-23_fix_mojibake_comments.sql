-- Re-state the nine comments that scripts/db/query.ps1 corrupted before 97253c2
-- (Get-Content without -Encoding UTF8 decoded the file as Windows-1252, so every
-- em dash reached Postgres as three characters). Bodies are copied verbatim from
-- the migrations that first created them; nothing else in those migrations is
-- re-run because later migrations (review_fixes, card_packs) supersede parts of them.
-- Audit 2026-08-23: no function body, policy, view, constraint, default, enum,
-- trigger, cron job or public data column carried the same corruption.

begin;

-- from supabase/migrations/2026-08-18_employee_of_month.sql
comment on table public.employee_of_month is
  'One row per company per month: who is Employee of the Month and which photo to show. Readable by every employee — never add money columns.';

-- from supabase/migrations/2026-08-18_marketing.sql
comment on table public.marketing_connections is
  'Which marketing platforms are wired up. NO OAuth tokens here — every '
  'company member can read this table. Tokens live in '
  'public.marketing_secrets (service role only) or in edge-function secrets.';

-- from supabase/migrations/2026-08-22_comms.sql
comment on table public.messages is
  'Every SMS and every bridge call, in and out. ADMIN ONLY on all four verbs '
  '(split per verb, never FOR ALL): threads carry prices, disputes and home '
  'addresses. Do not add a member read policy — Postgres ORs permissive '
  'policies and one broad policy defeats every narrow one.';

-- from supabase/migrations/2026-08-22_comms.sql
comment on column public.message_templates.body is
  'Merge fields are {{double_braced}} and are filled by renderTemplate() in '
  'lib/comms.ts, which strips any token it cannot resolve rather than sending '
  'the literal braces. EVERY template must end with "Reply STOP to opt out." '
  '— that sentence is part of the A2P 10DLC campaign registration.';

-- from supabase/migrations/2026-08-22_crm.sql
comment on column public.customers.archived_at is
  'Soft hide. There is no DELETE policy on this table and there should not be '
  'one — jobs and finance_entries reference these rows.';

-- from supabase/migrations/2026-08-22_document_revisions.sql
comment on column public.finance_entries.document_meta is
  'Everything the PDF needs that is not a line item: customer_snapshot, '
  'valid_until, totals {subtotal, discount, tax, total}, tax, discount, '
  'pdf_state (current|stale) and last_client_token (double-tap guard). '
  'INVARIANT: amount = totals.total — revise_document() asserts it.';

-- from supabase/migrations/2026-08-22_media_dropbox.sql
comment on table public.integration_secrets is
  'OAuth app credentials and refresh tokens for third-party integrations. '
  'RLS IS ENABLED WITH ZERO POLICIES ON PURPOSE — the same shape that makes '
  '`employees` and `marketing_secrets` structurally unreachable. No client '
  'key can read or write this table, not even the owner''s. Only the service '
  'role (the dropbox-sync edge function) can. DO NOT ADD A POLICY HERE.';

-- from supabase/migrations/2026-08-22_media_dropbox.sql
comment on table public.media_assets is
  'Photo library mirrored from Dropbox (or uploaded in-app). Member SELECT — '
  'these are marketing shots and Employee of the Month photos, not money. '
  'Admin INSERT/UPDATE/DELETE, split per verb; the sync itself runs as the '
  'service role and bypasses all of it.';

-- from supabase/migrations/2026-08-22_trading_cards.sql
comment on column public.cards.power is
  'Crew power rating, 0-4. ZERO IS MEANINGFUL (The Inspector is Power 0) — '
  'null means "not a crew card", 0 means "contributes nothing". Same for bonus.';

commit;
