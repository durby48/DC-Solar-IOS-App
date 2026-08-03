# Push notifications — setup checklist

Goal: Chase deposit alerts (and GC payment emails) land on the admins'
phones as push notifications, and payments recorded in the app push too.

Devon's Chase side is DONE (2026-07-27): business alerts enabled for
"online deposit submitted" and "deposit over $1 posted", delivered by email.

**Purchases / outgoing transactions too (added 2026-07-27):** in Chase →
Profile & Settings → Alerts, also enable the spending-side alerts —
debit card purchase, ACH/electronic withdrawal, wire transfer sent, and
check cleared (set thresholds to $1 so everything fires), delivered to
the same email. They ride the SAME Gmail filter (same Chase sender) —
no new code or filters needed. The notify function tags any alert whose
subject/body mentions payment/deposit/purchase/transaction/debit/
withdrawal/charge/transfer with 💰.

The pipeline: **Chase/GC email → Gmail filter applies `DC-Notify` label →
Apps Script (every 5 min) → Supabase `notify` edge function → Expo push →
admin phones.** Plus a direct path with no email: **finance_entries payment
INSERT → database webhook → same function.**

**Transaction logging (added 2026-08-03):** the notify function now also
PARSES each forwarded email. When it finds a dollar amount plus a clear
in/out keyword (deposit/remittance/payment received → `payment`;
purchase/debit/withdrawal/charge → `expense`), it inserts a
`finance_entries` row — so the Financials tab, Pipeline profit, and
per-job costs update from bank/GC emails automatically. Rows are tagged
`extracted.source = 'email-scanner'` with the Gmail message id (dedup),
the matched keyword, and the auto-matched job (DC-26### number or job
name found in the email; company-level when no single match). Ambiguous
emails still push but don't log. Wrong guesses are fixable in the app's
Financials edit UI. A one-time `backfillDcNotify()` in the Apps Script
replays everything since 2026-07-24 without pushing.

Everything below is one-time setup, in order:

## 1. APNs push key (Devon, ~2 min, interactive — required first)

Remote pushes cannot deliver to iOS without an APNs key on Expo's servers.
In a terminal:

```
cd "C:\Durbin Enterprises\DC-Solar-IOS-App\app"
npx eas-cli credentials -p ios
```

Pick `production` → Push Notifications → "Set up a new push key" and let
EAS generate/upload it (needs your Apple login once). Local job reminders
work without this; Chase alerts do not.

## 2. Deploy the `notify` edge function (~3 min)

1. https://supabase.com/dashboard → project → **Edge Functions** →
   Deploy new function → name `notify` → paste
   [supabase/functions/notify/index.ts](../supabase/functions/notify/index.ts).
2. **Uncheck "Verify JWT"** (the function checks its own shared secret).
3. Generate a long random secret (30+ characters), then: Edge Functions →
   notify → **Secrets** → add `NOTIFY_SECRET` = that value.
4. Test from any terminal (should return `{"sent":N}` and push to any
   signed-in admin device once step 1 is done and a new build has run):

```
curl -X POST "https://kjamxfezsathrsbztiln.supabase.co/functions/v1/notify" -H "content-type: application/json" -H "x-notify-secret: YOUR_SECRET" -d "{\"title\":\"Test\",\"body\":\"Hello from the notify function\"}"
```

## 3. Gmail labels + filters (~3 min, in devon@dcsolarkc.com)

1. Create labels `DC-Notify` and `DC-Notified` (Gmail → Settings → Labels).
2. Filter for Chase: search `from:(chase.com)` (open one of the alert
   emails and copy its exact sender — usually `no.reply.alerts@chase.com`)
   → Create filter → **Apply label DC-Notify** + Never send to Spam.
3. One filter per GC that emails payment confirmations, or a catch-all
   like `subject:(payment OR remittance OR "estimate accepted")` →
   same label. New GC later = one new filter, no code changes.

## 4. Apps Script poller (~5 min)

Follow the setup comment at the top of [docs/gmail-notify.gs](gmail-notify.gs)
(paste into script.google.com, two Script Properties, 5-minute trigger).

**Already set up? (2026-08-03)** paste the NEW gmail-notify.gs over the old
Code.gs — it now forwards messageId/date/body so transactions can be
parsed and deduped. Then run `backfillDcNotify` once from the Run menu to
log every DC-Notify transaction since 7/24 into finance_entries (no
pushes; safe to re-run; per-email results in the execution log).

## 5. In-app payment pushes — database webhook (~2 min, optional but nice)

Supabase Dashboard → **Database → Webhooks** → Create:
- Table `finance_entries`, event **INSERT**
- Type: HTTP request, POST, URL `https://kjamxfezsathrsbztiln.supabase.co/functions/v1/notify`
- HTTP header: `x-notify-secret` = the same secret
The function ignores every insert except `type = 'payment'` and pushes
"💰 Payment recorded — $X from <counterparty>" to admins. Payments the
email scanner logged itself are skipped here (the email path already
pushed) — no double notifications.

## Who gets pushed

Bank/email alerts and payment webhooks go to **admins only** (owner +
operator roles — Devon and Isaiah), looked up live from `employees`.
Devices register in `push_tokens` on sign-in (migration 9) — a phone gets
pushes after signing into the app once on a build ≥ #18.

## Privacy notes

- The Apps Script forwards sender, subject, message id/date, and up to
  4,000 characters of the plain-text body (needed to parse transaction
  amounts) — to Devon's own Supabase project only, over HTTPS with the
  shared secret. Push notifications still carry only the 140-char snippet.
- The secret lives in two places only: the edge function's secrets and
  the Apps Script's Script Properties.
- Nothing in this pipeline can move money — Chase only *sends* alert
  emails; no bank credentials are stored anywhere.
