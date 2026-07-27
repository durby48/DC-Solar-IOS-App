# Push notifications — setup checklist

Goal: Chase deposit alerts (and GC payment emails) land on the admins'
phones as push notifications, and payments recorded in the app push too.

Devon's Chase side is DONE (2026-07-27): business alerts enabled for
"online deposit submitted" and "deposit over $1 posted", delivered by email.

The pipeline: **Chase/GC email → Gmail filter applies `DC-Notify` label →
Apps Script (every 5 min) → Supabase `notify` edge function → Expo push →
admin phones.** Plus a direct path with no email: **finance_entries payment
INSERT → database webhook → same function.**

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

## 5. In-app payment pushes — database webhook (~2 min, optional but nice)

Supabase Dashboard → **Database → Webhooks** → Create:
- Table `finance_entries`, event **INSERT**
- Type: HTTP request, POST, URL `https://kjamxfezsathrsbztiln.supabase.co/functions/v1/notify`
- HTTP header: `x-notify-secret` = the same secret
The function ignores every insert except `type = 'payment'` and pushes
"💰 Payment recorded — $X from <counterparty>" to admins.

## Who gets pushed

Bank/email alerts and payment webhooks go to **admins only** (owner +
operator roles — Devon and Isaiah), looked up live from `employees`.
Devices register in `push_tokens` on sign-in (migration 9) — a phone gets
pushes after signing into the app once on a build ≥ #18.

## Privacy notes

- The Apps Script forwards **only** sender, subject, and the first 140
  characters of the body — never full email contents.
- The secret lives in two places only: the edge function's secrets and
  the Apps Script's Script Properties.
- Nothing in this pipeline can move money — Chase only *sends* alert
  emails; no bank credentials are stored anywhere.
