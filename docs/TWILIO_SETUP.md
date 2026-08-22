# Twilio — two-way SMS and bridge calling, setup checklist

Goal: DC Solar texts and calls customers from **one business number**. Every
message lands in the shared inbox in the app instead of on whoever's personal
cell made the call, and the customer always sees the DC Solar number on their
screen.

Nothing below can be done by a Claude session — every step needs Devon signed
in as the owner of the business. Until step 5 is finished the app's Comms
screens answer *"Texting is turned off"* and that is working as intended, not a
bug: the edge functions are deployed and return `503 not_configured` on purpose
when the credentials do not exist yet.

**Order matters. Start step 3 (A2P registration) on day one — carrier approval
takes 1–5 business days and everything else waits on it.** Steps 1, 2 and 4 can
be done while it sits in review.

Running cost once live: **≈ $9/month** (number $1.15, campaign $1.50, a few
dollars of usage) plus **≈ $19 one-time** in registration fees.

---

## 1. Twilio account + the business number (Devon, ~15 min)

1. https://www.twilio.com/try-twilio → sign up with devon@dcsolarkc.com. Choose
   the **paid** account immediately (Console → Billing → add a card, load $20);
   a trial account prefixes every text with "Sent from your Twilio trial
   account" and cannot register an A2P campaign.
2. Console → **Phone Numbers → Buy a number**. Filter to area code **816** (or
   913 if nothing good is left), capabilities **Voice + SMS + MMS**, local — not
   toll-free. ~$1.15/month.
3. Write the number down in E.164: `+1816XXXXXXX`. That exact string is
   `TWILIO_FROM_NUMBER` and it is what every customer will see forever, so pick
   one that is easy to read out loud.
4. Console → **Account → API keys & tokens**: copy the **Account SID**
   (`AC…`) and the **Auth Token**. Those are `TWILIO_ACCOUNT_SID` and
   `TWILIO_AUTH_TOKEN`. The auth token is also what signs every webhook — it is
   the single most sensitive value in this document.

## 2. Messaging Service with Advanced Opt-Out (Devon, ~10 min)

A Messaging Service is the container the A2P campaign attaches to. Sending
through it rather than straight from the number is what keeps the campaign
registration attached to the traffic.

1. Console → **Messaging → Services → Create Messaging Service**. Name it
   `DC Solar KC`. Use case: **Notify my users**.
2. **Sender Pool** → add the number bought in step 1.
3. **Opt-Out Management** → leave **Advanced Opt-Out ON** with the default
   keywords (STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT / START, UNSTOP,
   YES / HELP, INFO). Twilio then answers those words itself and blocks further
   traffic to that number at the carrier level.
   *The app also records the opt-out on the customer record — see step 6 — so
   the two agree. `twilio-inbound` deliberately never replies to STOP or START;
   Twilio has already answered.*
4. **Integration** → "Send a webhook", request URL — see step 5.
5. Copy the **Messaging Service SID** (`MG…`) → `TWILIO_MESSAGING_SERVICE_SID`.

## 3. A2P 10DLC registration — the long pole (Devon, ~45 min + 1–5 business days)

US carriers block unregistered application-to-person texting. Submit this on
day one.

1. Console → **Messaging → Regulatory Compliance → Trust Hub → Business
   Profile**. Standard (not Sole Proprietor).
   - Legal business name: **Durbin Enterprises LLC** trading as **DC Solar KC**
     (use the name exactly as it appears on the EIN letter)
   - EIN: **93-3073873**
   - Business type: LLC · Industry: Energy · Website: `https://dcsolarkc.com`
   - Authorized representative: Devon Durbin, devon@dcsolarkc.com, mobile number
   - Fee: ~$4 one-time
2. Once the brand is **verified**, → **A2P Messaging → Create Campaign**.
   Choose **Low Volume Standard** (~$15 one-time + $1.50/month; up to 6 000
   segments/day, far more than DC Solar sends).
3. Campaign use case: **Customer Care** (secondary: Account Notification).
4. **Sample messages** — paste these four; they are the seeded templates from
   `supabase/migrations/2026-08-22_comms.sql` with the merge fields filled in,
   so the registered samples and the shipped templates match:

   ```
   DC Solar KC: Isaiah is on the way to 101 W 115th St, ETA about 30 minutes. Reply STOP to opt out.
   ```
   ```
   DC Solar KC: reminder that we are scheduled at 101 W 115th St on Tue 9/2 at 8:00 AM. Reply to this text if that no longer works. Reply STOP to opt out.
   ```
   ```
   DC Solar KC: your estimate DC-26031-Estimate for 101 W 115th St is ready, $8,450.00. Reply here with any questions. Reply STOP to opt out.
   ```
   ```
   Thanks for choosing DC Solar KC, Ann. If we did right by you, a quick review helps us a lot: https://g.page/r/dcsolarkc/review Reply STOP to opt out.
   ```

5. **Opt-in description** — carriers reject vague answers. Use this:

   > Customers give written consent on the DC Solar KC estimate and contract
   > form, which they sign in person or electronically before any work is
   > scheduled. The form carries a separate, unchecked SMS consent checkbox
   > directly above the signature line. Consent to receive texts is not a
   > condition of purchase. The date and source of consent are stored on the
   > customer record.

6. **Opt-in proof** — upload a photo/PDF of the estimate form showing the
   checkbox, plus a screenshot of the SMS terms page from step 4.
7. Campaign attaches to the Messaging Service from step 2. Approval arrives by
   email. **Do not send a single production text before it is approved.**

## 4. Consent wording and the two public pages (Devon, ~30 min)

### 4a. On the estimate / contract form

A separate, **unchecked by default** checkbox immediately above the signature,
in the same size type as everything around it:

> ☐ **Text me about my project.** I agree that DC Solar KC (Durbin Enterprises
> LLC) may send me text messages about scheduling, job updates, estimates and
> invoices at the mobile number I provided. Message frequency varies. Message
> and data rates may apply. Reply STOP to opt out or HELP for help. Consent is
> not a condition of purchase. See our SMS Terms at dcsolarkc.com/sms-terms and
> our Privacy Policy at dcsolarkc.com/privacy.

Record who ticked it: `customers.sms_opt_in_source` exists for exactly this
(e.g. `contract-DC-26031`, `verbal-2026-09-02`, `sms-start-reply`).

### 4b. `https://dcsolarkc.com/sms-terms` — must be publicly reachable, no login

The carriers open this URL during review. It has to say, in plain words:

- **who is sending** — DC Solar KC, a trade name of Durbin Enterprises LLC,
  Kansas City, MO, (816) 274-2415, devon@dcsolarkc.com;
- **what is sent** — appointment scheduling and reminders, "on our way" and
  "arrived" notices, job status updates, estimates and invoices, and review
  requests;
- **how often** — "message frequency varies; typically a handful of messages
  per project";
- **cost** — "message and data rates may apply";
- **how to stop** — "reply STOP to any message to stop receiving texts. Reply
  START to resume. Reply HELP for help or call (816) 274-2415.";
- **carriers** — "carriers are not liable for delayed or undelivered messages";
- **no resale** — "we do not sell or share mobile numbers or SMS consent with
  anyone for marketing purposes."

### 4c. `https://dcsolarkc.com/privacy`

Must contain the sentence carriers look for, verbatim in substance:

> Mobile phone numbers collected for SMS are not sold, rented, or shared with
> third parties or affiliates for marketing purposes. Text-messaging opt-in
> data is not shared with any third party.

## 5. Point Twilio at the app and set the secrets (Devon or a Claude session, ~10 min)

First generate a webhook secret — 40+ random characters, no spaces:

```
node -e "console.log(require('crypto').randomBytes(30).toString('base64url'))"
```

Then set every secret in one call (PAT in
`C:\Durbin Enterprises\config\secrets\supabase-access-token.txt`):

```
curl -X POST "https://api.supabase.com/v1/projects/kjamxfezsathrsbztiln/secrets" \
  -H "Authorization: Bearer <SUPABASE_PAT>" \
  -H "Content-Type: application/json" \
  -d '[
    {"name":"TWILIO_ACCOUNT_SID","value":"AC…"},
    {"name":"TWILIO_AUTH_TOKEN","value":"…"},
    {"name":"TWILIO_FROM_NUMBER","value":"+1816XXXXXXX"},
    {"name":"TWILIO_MESSAGING_SERVICE_SID","value":"MG…"},
    {"name":"TWILIO_WEBHOOK_SECRET","value":"<the 40-char string>"}
  ]'
```

`TWILIO_PUBLIC_BASE` is already set to
`https://kjamxfezsathrsbztiln.supabase.co/functions/v1` — leave it alone. It is
what the signature check rebuilds the request URL from, so changing it breaks
every webhook until Twilio's URLs are changed to match.

Now the two webhook URLs, **including the `?k=` query string exactly as
written** (the signature is computed over the whole URL — a missing or extra
character means every request fails the check with a 403):

| Where in the Twilio console | URL |
|---|---|
| Messaging → Services → DC Solar KC → **Integration** → "Send a webhook", *Request URL*, POST | `https://kjamxfezsathrsbztiln.supabase.co/functions/v1/twilio-inbound?k=<TWILIO_WEBHOOK_SECRET>` |
| Phone Numbers → the number → **Voice & Fax** → *A call comes in*, Webhook, POST | leave as Twilio's demo, or point at your own IVR — the app never receives inbound calls |

Outbound status callbacks are set by the functions themselves; there is nothing
to configure for `twilio-status`.

**Verify the gates without sending anything** (all three are expected failures —
that is the test):

```
# no key at all → 401
curl -i -X POST "https://kjamxfezsathrsbztiln.supabase.co/functions/v1/twilio-inbound"

# right key, no signature → 403
curl -i -X POST "https://kjamxfezsathrsbztiln.supabase.co/functions/v1/twilio-inbound?k=<TWILIO_WEBHOOK_SECRET>" \
  -H "content-type: application/x-www-form-urlencoded" \
  --data "From=%2B18165550100&To=%2B1816XXXXXXX&Body=test"

# right key, wrong signature → 403
curl -i -X POST "https://kjamxfezsathrsbztiln.supabase.co/functions/v1/twilio-inbound?k=<TWILIO_WEBHOOK_SECRET>" \
  -H "content-type: application/x-www-form-urlencoded" \
  -H "X-Twilio-Signature: AAAAAAAAAAAAAAAAAAAAAAAAAAA=" \
  --data "From=%2B18165550100&To=%2B1816XXXXXXX&Body=test"
```

Then text the business number from your own phone: it should appear in the app's
inbox within a couple of seconds and push to the admins.

## 6. Turn it on in the app (Devon, ~2 min)

Nothing sends until the switches are on — a deliberate second gate, so a
half-finished A2P registration cannot leak a text.

```sql
update public.comms_settings
   set from_number   = '+1816XXXXXXX',
       sms_enabled   = true,
       voice_enabled = true,
       review_link   = 'https://g.page/r/…/review'
 where company = 'dc-solar';
```

(or the same thing from **CRM → Settings** in the app once Workstream G's
screens ship.)

For bridge calling, each person who will place calls adds their own cell number
once, in **CRM → Settings → My cell number**. That writes `staff_profiles`;
`twilio-call` refuses with *"Add your cell number in CRM settings first"* until
it exists, because there is no safe number to guess.

---

## The four edge functions

| Function | verify_jwt | Who may call it | What it does |
|---|---|---|---|
| `twilio-send-sms` | **true** + admin re-check | signed-in owner/operator | resolves the destination, refuses opted-out customers, writes the `messages` row **first**, then calls Twilio and stamps the SID/status back |
| `twilio-inbound` | **false** | Twilio only (`?k=` **and** `X-Twilio-Signature`) | matches the number to a customer or lead, applies STOP/START, logs the message + MMS media, pushes the admins through `notify`, replies with the after-hours text outside business hours |
| `twilio-status` | **false** | Twilio only (same two gates) | updates `messages` by `twilio_sid` — delivery state, error code, call duration. Always answers 204, including for a SID it has never seen |
| `twilio-call` | **true** + admin re-check | signed-in owner/operator | bridge call: rings **your** cell, says "Connecting you to <customer>", then dials the customer with the DC Solar number as caller ID |

`verify_jwt` is never the authorization on the first and last of those — each
one re-reads `employees.role` with the service role. A JWT only proves somebody
is signed in.

**Why two gates on the webhooks.** `?k=` keeps casual traffic and scanners off
the endpoint. `X-Twilio-Signature` (HMAC-SHA1 over the exact URL plus every POST
parameter sorted and concatenated, keyed with the auth token) is the one that
actually proves Twilio sent it. Without the signature, anyone who ever saw the
URL could forge a text *from a customer* into the thread, or mark an
undelivered message "delivered". Both are compared in constant time.

## What is stored where — do not shortcut this

- **`messages`** — every text and every call, in and out. **Admin-only on all
  four verbs, split per verb.** Threads carry prices, disputes and home
  addresses; `finance_entries` leaked $56,617 to four viewer accounts once
  because one broad policy ORed over every narrow one, and message bodies are
  the same class of data. Do not add a member read policy.
- **`comms_settings`** — one seeded row. Member SELECT (the crew has to be able
  to read the business number and the hours), admin UPDATE, no INSERT policy.
- **`staff_profiles`** — each person's own cell number, self-readable and
  self-writable, admin-readable. It is **not** a column on `employees` on
  purpose: that table has zero write policies and that is a load-bearing
  invariant of this database.
- **`message_templates`** — member read, admin write. Every template ends with
  "Reply STOP to opt out." because the A2P campaign was registered with that
  sentence in the samples. Do not remove it from one.
- **No Twilio credential is in any table.** Account SID, auth token, messaging
  service SID and the webhook secret are edge-function secrets, readable only by
  the functions. If a future feature seems to need the auth token on the client,
  it needs an edge function instead.
- **Recording is OFF** (`comms_settings.record_calls = false`). Missouri is
  one-party consent; DC Solar also works in Kansas and takes calls from
  all-party-consent states. The columns exist so the feature can be turned on
  deliberately, per call, after someone has read the law — not before.

## Owner follow-ups this produces

| Value | Where it comes from | Secret name |
|---|---|---|
| Account SID | Twilio Console → Account | `TWILIO_ACCOUNT_SID` |
| Auth Token | Twilio Console → Account | `TWILIO_AUTH_TOKEN` |
| The purchased number, E.164 | step 1 | `TWILIO_FROM_NUMBER` |
| Messaging Service SID | step 2 | `TWILIO_MESSAGING_SERVICE_SID` |
| A 40-char random string you invent | step 5 | `TWILIO_WEBHOOK_SECRET` |
| (already set) | — | `TWILIO_PUBLIC_BASE` |
