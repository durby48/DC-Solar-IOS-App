# Marketing connections — setup checklist

Goal: the Sales tab's **Marketing** segment shows real Google, Facebook,
Instagram and Yelp numbers instead of sample data.

Nothing below can be done by a Claude session — every step needs Devon signed
in as the owner of the business accounts. Until step 1 and step 2 are done the
app shows *"Sample data — connect a platform to see real numbers."* and that is
working as intended, not a bug.

Order matters: **Google's access request takes days to approve**, so submit it
first and do Meta and Yelp while waiting.

---

## 1. Google Business Profile (the important one)

This is where the reviews and most of the calls come from. Google gates the
APIs behind a manual approval.

1. **Google Cloud project.** https://console.cloud.google.com → new project,
   name it `dc-solar-marketing`. (Do **not** reuse the Maps/Street View project
   from the property artwork — separate quotas, separate blast radius.)
2. **Enable the APIs.** APIs & Services → Library → enable all of:
   - My Business Account Management API
   - My Business Business Information API
   - **Business Profile Performance API** (the metrics)
   - Google My Business API (the reviews — this one only appears *after*
     approval in step 3)
3. **Request access.** Fill in the standard access form linked from
   https://developers.google.com/my-business/content/prereqs — it asks for the
   Cloud project number and the Google account that manages the business
   listing (devon@dcsolarkc.com). Approval arrives by email, typically a few
   business days. **Nothing works before this.**
4. **OAuth consent screen.** APIs & Services → OAuth consent → External,
   app name "DC Solar KC", support email devon@dcsolarkc.com. Add scope
   `https://www.googleapis.com/auth/business.manage`. Add devon@dcsolarkc.com
   as a test user (no public verification needed — one user, ourselves).
5. **Credentials.** Create an OAuth **client ID**, type *Web application*, with
   redirect URI `https://developers.google.com/oauthplayground`. Keep the
   client ID and client secret.
6. **Get a refresh token.** https://developers.google.com/oauthplayground →
   gear icon → tick "Use your own OAuth credentials", paste the client ID and
   secret → in the left list enter the scope
   `https://www.googleapis.com/auth/business.manage` → Authorize → Exchange
   authorization code for tokens → copy the **refresh token** (starts `1//`).
   It does not expire unless revoked.
7. **Find the account and location ids.** With an access token from the
   playground:
   ```
   GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts
   GET https://mybusinessbusinessinformation.googleapis.com/v1/{accountName}/locations?readMask=name,title
   ```
   Both come back as `accounts/123…` and `locations/456…`. Store **the digits
   only** — the function adds the prefixes.

## 2. Meta (Facebook page + Instagram)

1. **Developer app.** https://developers.facebook.com → My Apps → Create App →
   type *Business*. Name it "DC Solar KC Insights".
2. **Permissions.** Add the Facebook Login product, then request these
   permissions: `pages_read_engagement`, `read_insights`, `instagram_basic`,
   `instagram_manage_insights`. For a page we own, Development mode is enough —
   no App Review, as long as Devon is an admin of the page.
3. **Instagram must be a Business account** and **linked to the Facebook
   page** (Instagram app → Settings → Account type → Business → link page).
   A personal IG account returns no insights at all.
4. **Page access token.** Graph API Explorer → pick the app → select the DC
   Solar page → Generate Access Token with the four permissions → then extend
   it at Access Token Debugger → "Extend Access Token" to get the **long-lived
   page token** (~60 days for a user token; page tokens derived from a
   long-lived user token do not expire). ⚠️ If the Marketing chips ever say
   *"Needs attention"*, this token is the first suspect.
5. **Ids.** Graph API Explorer:
   - `GET /me/accounts` → the page `id`
   - `GET /{page-id}?fields=instagram_business_account` → the IG user id

## 3. Yelp

1. https://www.yelp.com/developers → Manage App → create an app → copy the
   **API key**.
2. The business alias is the slug in the Yelp URL:
   `yelp.com/biz/`**`dc-solar-kansas-city`** ← that part.

Yelp's Fusion API returns only the rating and review count — no review text and
no replies. The Yelp card in the app is deliberately thin for that reason.

---

## 4. Set the secrets on the function

Run the migration first if it has not been applied:
`supabase/migrations/2026-08-18_marketing.sql`.

Then set the secrets via the Management API (PAT in
`~/Desktop/DC Solar LLC/secrets/supabase-access-token.txt`):

```
POST https://api.supabase.com/v1/projects/kjamxfezsathrsbztiln/secrets
Authorization: Bearer <PAT>
Content-Type: application/json

[
  {"name": "GOOGLE_BUSINESS_CLIENT_ID",     "value": "…apps.googleusercontent.com"},
  {"name": "GOOGLE_BUSINESS_CLIENT_SECRET", "value": "GOCSPX-…"},
  {"name": "GOOGLE_BUSINESS_REFRESH_TOKEN", "value": "1//…"},
  {"name": "GOOGLE_BUSINESS_ACCOUNT_ID",    "value": "123456789"},
  {"name": "GOOGLE_BUSINESS_LOCATION_ID",   "value": "987654321"},
  {"name": "META_PAGE_ID",                  "value": "…"},
  {"name": "META_PAGE_TOKEN",               "value": "EAA…"},
  {"name": "META_IG_USER_ID",               "value": "…"},
  {"name": "YELP_API_KEY",                  "value": "…"},
  {"name": "YELP_BUSINESS_ALIAS",           "value": "dc-solar-kansas-city"}
]
```

Deploy `supabase/functions/marketing-sync` the same way the other functions
deploy (`POST /v1/projects/<ref>/functions/deploy?slug=marketing-sync`,
multipart, **verify_jwt TRUE**), then call it once from an admin session:

```json
POST /functions/v1/marketing-sync
{ "days": 90 }
```

Expect `{"ok":true,"results":[…]}`. A platform whose secrets are missing comes
back as `{"ok":false,"reason":"not_connected"}` and is skipped — that is a
state, not a failure, so partial setup is safe.

Schedule it daily once it works (pg_cron or a Vercel cron hitting the endpoint
with an admin token). Google's daily metrics settle a day late, so the function
deliberately stops at yesterday.

---

## What is stored where — do not shortcut this

- **`marketing_connections` / `marketing_metrics` / `marketing_reviews`** —
  readable by every DC Solar employee. Reach numbers are not money.
- **No OAuth token goes in any of those tables.** Tokens live in edge-function
  secrets (above), or in `public.marketing_secrets`, which has RLS enabled and
  **zero policies** — no client key can read it, only the service role. This is
  the same structural protection `employees` uses.
- If a future feature seems to need a token in the client, it needs an edge
  function instead.
