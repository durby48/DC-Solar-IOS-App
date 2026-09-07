# Automatic lead intake — audit, design and what shipped (Phase 9, 2026-09-07)

Status: **SHIPPED** (migration `supabase/migrations/2026-09-07_lead_intake.sql`,
applied). The Gmail gate was cleared by Devon before implementation. Sections
7–9 below record what was built and how it was tested; the audit and the
original design are kept above them because the decisions still stand, with
one change: **same phone/email never collapses a new inquiry** (the earlier
"merge" idea was dropped per the Phase 9 context — a matching number is not
proof of the same submission).

## 9A — the audit, answered from the code

Sources read: `app/src/lib/leads.ts`, `app/src/lib/sales.ts`,
`app/src/lib/crm.ts::convertLeadToCustomer`, `app/src/app/leads/index.tsx`
(the manual form), `supabase/migrations/2026-08-07_sales.sql` (schema + RLS),
`2026-08-22_crm.sql` (`phone_e164`), `2026-08-22_review_fixes.sql`
(`sms_opt_out_at`), `supabase/functions/twilio-inbound` (lead lookup by
number), the live `leads` and `quote_requests` tables, and the website repo
`durby48/dcsolarkc` (`app/api/quote/route.ts`, `components/QuoteForm.tsx`,
`lib/validation.ts`, `lib/smsConsent.ts`, `lib/rateLimit.ts`, `types/database.ts`).

| # | Question | Answer |
|---|---|---|
| 1 | Required fields | `name` only (`leads.name text not null`; the form says "A lead needs at least a name"). `company` and `status` have defaults. |
| 2 | Optional fields | `phone`, `email`, `address`, `source`, `estimated_value`, `notes`, `assigned_to`, `lost_reason`, `converted_job_id`, `sms_opt_out_at`. |
| 3 | Default status | `'new'` (column default and `createLead` both set it; check constraint `new/contacted/estimating/won/lost`). |
| 4 | `company` | Column default `'dc-solar'`; `createLead` also writes it explicitly. Every read filters `company = 'dc-solar'`. |
| 5 | Phone normalization | Not in app code — a **generated column** `leads.phone_e164`: 10 digits → `+1…`, 11 starting with 1 → `+…`, anything else → NULL, "never a guess". Indexed; `twilio-inbound` matches inbound texts on it. |
| 6 | Email normalization | None. `createLead` trims; comparisons elsewhere use `lower()`. No uniqueness. |
| 7 | `assigned_to` | Employee **email** (`employees.email`), set by admins via `assignLead`; drives `leads_own_select` / `leads_own_update` for reps. |
| 8 | Source | Free text (`source text`): "referral, website, door knock, roofer". Shown as `Lead · <status> · <source>` in the CRM list and as `Source:` on the Lead-created Activity row. |
| 9 | Canonical create helper | `lib/leads.ts::createLead(input, createdBy)` — client-side, runs under the caller's RLS (admins insert via `leads_admin_all`). |
| 10 | Reusable server-side? | The *rules* are trivial (trim, name required, status new) and can be re-stated in SQL; the helper itself cannot run server-side (it is a browser Supabase client call). |
| 11 | Duplicate detection | **None.** Two leads with the same phone are two leads. Nothing checks `customers` either. |
| 12 | Trustworthy identifiers | `phone_e164` (deterministic), `lower(email)`. Names and addresses are not. |
| 13 | Phone only | Fine: `email` null. SMS threads link by `phone_e164`. |
| 14 | Email only | Fine: `phone` null; the CRM Email pane works, SMS/calls do not. |
| 15 | Missing address / service type | Address is optional; `leads` has **no service-type column** (that lives on `jobs.job_type` after conversion). |
| 16 | Never set by an external source | `company`, `status` (must stay `new`), `assigned_to`, `created_by`, `estimated_value`, `converted_job_id`, `lost_reason`, `sms_opt_out_at`. |

Also true, and load-bearing for the design:

- **RLS on `leads`:** admins everything; reps read/update only leads assigned
  to them. No anonymous path of any kind. Not to be touched.
- **Conversion** (`convertLeadToCustomer`) copies name/phone/email/address/notes
  into `customers` and optionally opens a job at Pending Estimate; runs
  customer → job → lead(won) so a failure leaves the lead visible.
- **`quote_requests`** (the website form's table, same Supabase project):
  `name, email, phone, address, service_type, property_type,
  is_insurance_claim, message, status('new'), sms_consent, sms_consent_at,
  sms_consent_source, sms_consent_version, sms_consent_ip,
  sms_consent_user_agent`. RLS on, ONE policy: `Allow public inserts`
  (anon+authenticated, `with check true`), **no select policy** — only the
  service role can read it. No triggers. **4 rows (2026-07-04 → 2026-09-04),
  all `new`, 2 with SMS consent, none matching any lead or customer.** The
  website's ops console never reads the table; the only signal today is the
  notification email `app/api/quote/route.ts` sends. Those four are the
  leads the CRM has been missing.
- The website already does the right things server-side: validates (name,
  valid email, phone required), rate-limits per IP, and derives every
  consent evidence field on the server from the single checkbox
  (`buildSmsConsentFields`, version `dc_solar_sms_quote_v1_2026_08_25`).

## First source: the DC Solar website quote form

Chosen because it is the only source that exists, it is live, it already
lands in our database, and it has been silently unhandled for two months.
Google Ads / Meta lead forms: no integration, no evidence of use — not built,
not claimed.

## 9B — one canonical intake contract

Customer-submitted, source metadata and trusted fields, kept apart:

```
intake_lead(
  -- customer-submitted (validated, normalized)
  p_name        text,          -- required, trimmed, ≤ 200
  p_phone       text,          -- raw; phone_e164 is derived by the column
  p_email       text,          -- lower(trim())
  p_address     text,
  p_message     text,          -- free text from the person
  -- source metadata (attribution + idempotency)
  p_source      text,          -- 'website' | 'google_ads' | 'meta' | 'api:<name>'
  p_source_ref  text,          -- provider id, e.g. 'quote_requests:<uuid>'; unique per source
  p_service     text,          -- e.g. 'solar', 'removal-reinstall' → goes into notes, not a column
  p_submitted_at timestamptz,
  -- consent evidence (server-derived by the source, never client-supplied)
  p_sms_consent_at      timestamptz,
  p_sms_consent_source  text,
  p_sms_consent_version text
) returns (lead_id uuid, outcome text)   -- outcome: created | duplicate | merged
```

Nothing an external source sends can set `company`, `status`,
`assigned_to`, `created_by`, `estimated_value` or any CRM flag. The function
sets them.

## 9C — proposed implementation (not built)

**One SQL function, two callers.** `public.intake_lead(...)`, SECURITY
DEFINER, owned by postgres, `revoke execute from anon, authenticated` — it is
callable only by the service role and by triggers. Then:

1. **Website (path A, zero marketing-site changes):** an AFTER INSERT trigger
   on `quote_requests` calls `intake_lead` with `source = 'website'`,
   `source_ref = 'quote_requests:' || id`, and the row's consent fields. A
   one-time statement in the same migration replays the 4 existing rows. The
   website keeps sending its email; nothing there changes.
2. **Everything else (path B, future):** an Edge Function `lead-intake`
   (`verify_jwt` false, `?k=<secret>` gate like `twilio-inbound`, one secret
   per source, source name taken from the key not the body) that validates
   JSON, maps a provider payload to the contract in a per-provider adapter,
   and calls the same `intake_lead`. Not built until a second source exists.

**Additive schema:**
- `leads.source_ref text` + unique partial index `(company, source_ref) where source_ref is not null` — idempotency.
- `leads.sms_opt_in_at timestamptz`, `leads.sms_opt_in_source text` — the
  consent evidence the lead carries (customers already has
  `sms_opt_in_source`; conversion should copy it — a small backward-compatible
  extension of `convertLeadToCustomer`, flagged below).
- `quote_requests.lead_id uuid` — back-pointer; `quote_requests.status`
  set to `'in_crm'` by the trigger so the website's own status stays honest.
- No RLS changes on `leads`. `quote_requests` keeps insert-only-for-public
  and no read policy.

**Duplicate / idempotency rules (deterministic, all documented in the row):**

| Case | Rule | Outcome |
|---|---|---|
| Same `source_ref` again (provider retry, replay) | return the existing lead | `duplicate` |
| Same `phone_e164` or same `lower(email)` as an **open** lead (`status` not won/lost) | do not create; append `Re-inquired via <source> on <date>: <message>` to that lead's notes; `updated_at` bumps | `merged` |
| Matches a **won/lost** lead or an existing **customer** | create a new lead; notes start with `Previous lead <id>` / `Existing customer <name>` so the rep sees it | `created` |
| No match | create | `created` |

Both directions are deliberate: a spouse re-submitting should not spawn a
second open lead, while a customer coming back for a removal-reinstall is
genuinely new business.

**Assignment:** left unassigned. No rule exists today (leads are assigned by
hand), and inventing one is business policy. Flagged.

**Consent:** copied verbatim from the source's server-derived evidence, only
when the source says consent was given. Never fabricated. Intake does NOT
text anyone — automation is Phase 10.

**Activity:** the existing `Lead created · Source: website` row already covers
"Lead received"; wording can say `Lead received · Website` when
`source_ref` is set. No new event table.

**Notification:** the website already emails Devon. A push via the existing
`notify` function ("New website lead: <name>") is one call but is arguably
Phase 10; not proposed for 9.

## Product decisions for Carson / Devon

1. Approve path A (trigger on `quote_requests`) as the website integration —
   it means no change to the marketing site at all.
2. Auto-assignment: nobody, or one default rep?
3. Should conversion carry `sms_opt_in_source` onto the customer (touches
   `convertLeadToCustomer`, backward-compatible)?
4. Should the 4 historical quote requests be replayed into `leads` (they are
   real, two months old)?

## 7. What shipped

- **`public.intake_lead(p_source, p_source_ref, p_name, p_phone, p_email, p_address, p_message, p_service, p_property_type, p_insurance_claim, p_submitted_at, p_sms_consent_at, p_sms_consent_source, p_sms_consent_version) → (lead_id, outcome, match_note)`** — SECURITY DEFINER, owned by postgres, EXECUTE revoked from public/anon/authenticated (proven: both anon and a signed-in viewer get `42501`). It trims, lowercases and validates the email, derives the E.164 for matching, names the source (`Website`), enforces `source_ref` idempotency, writes the lead with `status = new`, `created_by = <source>`, `created_at = submission time`, unassigned, and consent only when the source supplied a timestamp (`sms_opt_in_source` = `source@version`).
- **Trigger `quote_requests_intake_trg`** (AFTER INSERT on `quote_requests`, SECURITY DEFINER function) calls it with `source_ref = 'website_quote:<id>'` and writes back `quote_requests.lead_id`, `intake_outcome`, `intake_at`. Any error is caught and recorded as `error: …` — the visitor's insert never fails.
- **Columns:** `leads.source_ref` (+ unique partial index `leads_source_ref_uq` on `(company, source_ref)`), `leads.sms_opt_in_at`, `leads.sms_opt_in_source`, `customers.sms_opt_in_at`, `quote_requests.lead_id / intake_outcome / intake_at`.
- **RLS: no policy changed.** `leads` policies untouched; `quote_requests` keeps insert-only-for-public and no read policy (proven: anon reads 0 rows of either).
- **App (small, additive):** `Lead` type and the three lead selects carry the new columns; `convertLeadToCustomer` reads the lead's consent and `createCustomerRow` writes it onto the customer (optional fields, nothing else in conversion changed); Activity shows `Lead received · Website` (+ "Opted in to texts on the form") for intake leads and keeps `Lead created` for typed ones; the lead detail panel shows an **SMS consent** fact and labels the date **Received** instead of Created.
- **Website: unchanged.** **Native: untouched.** No public edge function — the website already writes to Supabase, and no second source exists yet.

### Final dedupe / re-inquiry behaviour

| Case | Result |
|---|---|
| Same `source_ref` (retry, replay) | `duplicate` — the existing lead id is returned, nothing written. |
| Same `phone_e164` or email as an **open** lead | `created` — a new lead, whose notes say `Possible repeat: open lead "<name>" (<id>) has the same phone/email.`; the open lead gets `Re-inquiry via Website on <date> (new lead <id>).` |
| Same phone/email as a won/lost lead | `created`, notes say `Previous lead "<name>" (<status>, <id>).` |
| Same phone/email as a customer | `created`, notes say `Existing customer "<name>" (<id>).` |
| Website error inside intake | quote row kept, `intake_outcome = error: …`, no lead. |

## 8. Historical replay — examined 4, replayed 0, skipped 4

Every existing `quote_requests` row was inspected. All four are bot
submissions: random-letter names (`jpYIsLOzbFzdASmKGZhijFp`), random-letter
addresses and messages, dotted-Gmail addresses (`j.et.o.h.am.923@…`), every
one "insurance claim = yes", and the two with consent stamps came from
`192.42.116.x` (a Tor exit range). None matches any lead or customer. Each
row now carries `intake_outcome = 'skipped: bot submission (…); reviewed
2026-09-07'`. No real customer inquiry has arrived through the form yet.

Consequence worth deciding: the trigger will faithfully turn the **next** bot
submission into a lead. Filtering belongs on the website (a honeypot field
or Cloudflare Turnstile on `QuoteForm.tsx`) — a marketing-site change,
not made here.

## 9. Testing performed (2026-09-07, test-operator session, fresh Metro)

- Website-style insert as `anon` through the public policy → exactly one lead: phone `(816) 555-0199` → `+18165550199`, email lowercased, source `Website`, `source_ref = website_quote:<id>`, status `new`, unassigned, `created_by = website`, `created_at` = the request's time, consent copied with `public_quote_form@dc_solar_sms_quote_v1_2026_08_25`; `quote_requests.lead_id` and `intake_outcome = created` written back.
- Same `source_ref` through `intake_lead` again → `duplicate`, still one lead.
- Second `anon` insert with the same phone, different name → a second lead with the `Possible repeat…` note; the first lead got the `Re-inquiry…` line with the new id.
- `anon` / signed-in viewer executing `intake_lead` → `permission denied`; `anon` reads 0 rows of `quote_requests` and `leads`; viewer reads 0 leads (unchanged).
- CRM: both leads in the Leads lens (`Lead · New lead · Website`), search, detail panel (Website, SMS consent, Received), Activity `Lead received · Website / Opted in to texts on the form`, SMS composer offered.
- Manual `+ Lead` from the workspace → `/leads` → created `Manual Lead Test` with no `source_ref`, `created_by` = the operator, status new.
- Conversion (`Convert to customer`) → customer created with `sms_opt_in_at` and `sms_opt_in_source` copied; lead marked won.
- All test rows deleted afterwards (customer, three leads, two quote requests). Bot rows retained with their skip reason.
- Fresh-tab hard load of `/workspace` clean; `tsc` and `expo export --platform web` clean.

## Testing plan (as written before implementation)

1. Hard-load `/workspace`; manual `+ Lead` still works.
2. POST the website form (or insert a `quote_requests` row with the service
   role) → exactly one lead, `source = website`, `source_ref` set,
   `phone_e164` derived, unassigned, status `new`, consent fields only when
   consented.
3. Same row again → `duplicate`, no second lead. Same phone, new row →
   `merged`, note appended. Won lead's phone → `created` with the note.
4. Malformed / unauthorized: anon `select` on `quote_requests` → denied; anon
   `execute intake_lead` → denied; anon insert without name → rejected by the
   website's validation before it reaches the table.
5. Lead shows in CRM Leads lens, search, funnel, tasks, appointments,
   conversion. Pipeline, Calendar, Phone/SMS unaffected. `tsc` + web export.
6. Delete the test rows.
