# Google + Apple sign-in — setup checklist

Goal: a new customer taps **Continue with Google** or **Sign in with Apple** on
`/sign-up` and lands straight in the portal, instead of waiting on the office to
send a temporary password.

**Customers only.** Staff keep email + password + a 6-digit TOTP code, and the
server refuses a Google or Apple identity on a staff address outright. That is
not a UI convention — it is a trigger, and it is described in "The staff block"
below. Do not add these buttons to the staff login screen.

Cost: **$0.** Time: about 35 minutes of Devon's, plus ~5 minutes of config that
a Claude session can run. Nothing in sections 1–3 can be automated: every step
needs Devon signed in as the owner of the Google Cloud project and the Apple
developer account.

Until section 1 is done, `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` is empty and
`AuthProviderButtons` renders **nothing at all**. A blank space above the
sign-up form is the designed state, not a bug.

⚠️ **Google sign-in is a native capability.** The `app.json` plugin entry in
section 5 has to be in place before the EAS build; it cannot be added by an OTA
update. See `app/GOOGLE_SIGNIN_TODO.md` and `app/BUILD29_CHECKLIST.md`.

---

## 1. Google Cloud — consent screen and two OAuth clients (Devon, ~15 min)

1. https://console.cloud.google.com → pick or create a project (`dc-solar-app`
   is fine; do **not** reuse `dc-solar-marketing` from `MARKETING_SETUP.md` —
   separate quotas, separate blast radius).
2. **APIs & Services → OAuth consent screen.** User type **External**. App name
   "DC Solar KC", support email devon@dcsolarkc.com, developer contact the same.
   Scopes: `email`, `profile`, `openid` — nothing else. These three are
   non-sensitive, so Google does **not** require app verification and there is
   no review wait.
   - Publishing status: click **Publish app**. Left in *Testing*, only accounts
     on the test-user list can sign in and their refresh tokens expire after 7
     days.
3. **Credentials → Create credentials → OAuth client ID → Web application.**
   Name it `DC Solar KC — web`. Authorized redirect URI, exactly:

   ```
   https://kjamxfezsathrsbztiln.supabase.co/auth/v1/callback
   ```

   That is Supabase's callback, not ours. The app's own URL never appears here —
   GoTrue bounces the browser onward to whatever `redirectTo` we asked for,
   which is why section 4's `uri_allow_list` matters instead.
   Copy the **client ID** *and* the **client secret**.
4. **Credentials → Create credentials → OAuth client ID → iOS.** Bundle ID
   `com.dcsolarkc.fieldapp`. No App Store ID or Team ID needed. Copy the
   **client ID** and the **iOS URL scheme** Google shows on the detail page —
   that is the reversed client ID:

   ```
   iOS client ID   1234567890-abcdefghij.apps.googleusercontent.com
   reversed        com.googleusercontent.apps.1234567890-abcdefghij
   ```

   The iOS client has **no secret**. That is correct and there is nothing to
   find; a public client cannot keep one.

## 2. Apple — App ID capability, Services ID, signing key (Devon, ~20 min)

⚠️ **Step 2a must happen BEFORE the EAS build runs.** `app.json` already sets
`ios.usesAppleSignIn: true`, so EAS will ask Apple for a provisioning profile
carrying the Sign in with Apple entitlement. If the App ID does not have the
capability, the build fails at code-signing — and `eas.json` has
`autoIncrement: true`, so a failed attempt still burns a build number. Builds
#15 and #16 died exactly this way.

### 2a. Enable the capability on the App ID — by hand

Do this in the portal, **not** through `eas capability sync`, which has silently
failed on this project before.

1. https://developer.apple.com/account → Certificates, Identifiers & Profiles →
   **Identifiers**
2. Open App ID **`com.dcsolarkc.fieldapp`** (Team `E4B2Y6BWCH`)
3. Tick **Sign In with Apple** → Save → confirm the "modify capabilities" prompt
4. Leave it a primary App ID — no grouping needed

### 2b. Services ID — this is the *web* client

Native iOS authenticates as the bundle id; the browser needs its own identifier.

1. Identifiers → **+** → **Services IDs** → description "DC Solar KC Web",
   identifier **`com.dcsolarkc.fieldapp.web`**
2. Open it → tick **Sign In with Apple** → **Configure**
3. Primary App ID: `com.dcsolarkc.fieldapp`
4. **Domains and Subdomains** (no scheme, no trailing slash):

   ```
   kjamxfezsathrsbztiln.supabase.co
   app.dcsolarkc.com
   ```

5. **Return URLs**, exactly one:

   ```
   https://kjamxfezsathrsbztiln.supabase.co/auth/v1/callback
   ```

6. Save, then **Continue → Save** on the outer sheet as well. Apple's UI loses
   the configuration if you only save the inner sheet.

### 2c. Sign-in key (.p8)

1. Keys → **+** → name "DC Solar KC Sign in with Apple" → tick **Sign in with
   Apple** → Configure → primary App ID `com.dcsolarkc.fieldapp` → Save
2. **Register**, then **Download**. Apple lets you download the `.p8` **once**.
   Put it in `~/Desktop/DC Solar LLC/secrets/` — never in this repo.
3. Note the **Key ID** (10 chars) and the **Team ID** (`E4B2Y6BWCH`).

### 2d. 🔴 The Apple secret expires every 6 months

Supabase turns the `.p8` into a signed client secret JWT, and Apple caps those
at **6 months**. When it lapses, every Apple sign-in fails and nothing else
does — a genuinely confusing outage.

**Put a recurring calendar reminder on Devon's calendar now**, titled
*"Regenerate Apple sign-in secret (Supabase → Auth → Providers → Apple)"*,
repeating every 5 months. The `.p8` itself does not expire; only the generated
secret does, so renewal is: dashboard → Apple provider → re-enter Team ID, Key
ID and the `.p8` → Generate → Save.

## 3. Turn the providers on in Supabase (Devon or a Claude session, ~5 min)

**Apple goes through the dashboard**, because the dashboard is what turns the
`.p8` into the secret JWT: Supabase dashboard → **Authentication → Providers →
Apple** → enable → paste Services ID, Team ID, Key ID and the `.p8` contents →
**Generate a new secret** → Save. Then set the client-id list (below) so the
*native* bundle id is accepted too.

**Google goes through the Management API.** PAT in
`C:\Durbin Enterprises\config\secrets\supabase-access-token.txt`.

```
curl -X PATCH "https://api.supabase.com/v1/projects/kjamxfezsathrsbztiln/config/auth" \
  -H "Authorization: Bearer <SUPABASE_PAT>" \
  -H "Content-Type: application/json" \
  -d '{
        "external_google_enabled": true,
        "external_google_client_id": "<WEB_CLIENT_ID>.apps.googleusercontent.com,<IOS_CLIENT_ID>.apps.googleusercontent.com",
        "external_google_secret": "<WEB_CLIENT_SECRET>",
        "external_google_skip_nonce_check": false,
        "external_apple_enabled": true,
        "external_apple_client_id": "com.dcsolarkc.fieldapp,com.dcsolarkc.fieldapp.web"
      }'
```

`GET` the same endpoint first and patch only keys that already exist in the
response — the endpoint replaces what you send.

Three things that are easy to get wrong:

- **`external_google_client_id` is a comma-separated list**, web id first then
  the iOS id. Supabase validates the `aud` claim of every id token against this
  list, and the native iOS flow presents a token whose `aud` is the **iOS**
  client. Web id only ⇒ native Google fails with `Unacceptable audience`.
- **`external_apple_client_id` needs both identifiers too**: the bundle id
  `com.dcsolarkc.fieldapp` for the native token and the Services ID
  `com.dcsolarkc.fieldapp.web` for the browser redirect.
- **Leave `external_google_skip_nonce_check` false.** The client sends no nonce
  for native Google (the library gives no way to set one for the original
  sign-in flow), so there is nothing to check and nothing to skip. Only flip it
  if a native token turns out to carry a nonce we did not generate — and record
  why if you do.

Also confirm from Workstream D1 that `uri_allow_list` still contains
`https://app.dcsolarkc.com/**` and the localhost dev ports. The web flow asks
GoTrue to bounce back to `window.location.origin + '/'`; an origin that is not
allow-listed is silently replaced with `site_url` and the customer lands on the
wrong host with their tokens in the URL fragment.

## 4. `.env` — the two client IDs (~2 min)

`app/.env` (copy the shape from `app/.env.example`):

```
EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=<web client id>.apps.googleusercontent.com
EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID=<ios client id>.apps.googleusercontent.com
```

Client IDs are public identifiers — they ship inside the JS bundle either way.
The **client secret does not go here**; it goes in the Supabase auth config in
section 3.

⚠️ **Set them on EAS as well.** `EXPO_PUBLIC_*` values are substituted at bundle
time, and EAS builds on a clean machine that never sees `app/.env`. A build made
without them ships with the buttons hidden — and no error to explain why.

```
cd app
npx eas-cli env:create --name EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID --value "…" --environment production --visibility plaintext
npx eas-cli env:create --name EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID --value "…" --environment production --visibility plaintext
```

Repeat for `preview` if that profile is used. Vercel needs the same two
variables on the web project.

## 5. `app.json` — the Google plugin entry (~2 min, blocks the build)

Append to `expo.plugins`, substituting the reversed iOS client ID from step 1.4:

```json
[
  "@react-native-google-signin/google-signin",
  {
    "iosUrlScheme": "com.googleusercontent.apps.<REVERSED_IOS_CLIENT_ID>"
  }
]
```

It is deliberately absent today — a placeholder would register a bogus URL
scheme and fail the round trip. `expo-apple-authentication` and
`ios.usesAppleSignIn: true` are already in place. `runtimeVersion` stays `"2"`
and `version` stays `"1.0.0"`; do not touch either.

Then, from `app/`:

```
npx expo config --type public      # must parse
npx expo export --platform web     # must succeed
npx tsc --noEmit                   # must be clean
```

---

## The staff block

`supabase/migrations/2026-08-22_oauth_staff_block.sql`, plus a client-side
backstop. Three layers, and only the first two are security:

1. **`BEFORE INSERT` on `auth.identities`** — the authoritative gate. When a
   Google account matches an existing *verified* `auth.users` row, GoTrue
   auto-links it by inserting into `auth.identities` and **never touches
   `auth.users`**, so an `auth.users` trigger would never fire. Every staff
   account already exists and is verified. Without this, Devon tapping
   "Continue with Google" would link his Google identity to his staff account
   and sign him straight into the crew app, past the 6-digit code.
2. **`handle_new_auth_user()`** on `auth.users` — the same refusal for a
   brand-new account whose address happens to be on the roster.
3. **`lib/oauth.ts::refuseStaff()`** — after any successful social sign-in the
   client calls `getAccountInfo()`, and on `kind === 'employee'` signs out and
   returns *"Staff sign in with your email, password and 6-digit code."* This is
   belt and braces: it exists so a server misconfiguration surfaces as a clear
   message rather than a half-signed-in staff member.

Both triggers raise with errcode **42501** and the text *"Staff accounts sign in
with a password and a 6-digit code"*. `lib/oauth.ts` maps either to that same
sentence. GoTrue sometimes flattens a trigger exception into a bare "Database
error…", so the fallback message names both possibilities rather than guessing.

Existing email/password customers are unaffected in the other direction: tapping
Google with the same verified address **links** the identity to the account they
already have. Same user id, same portal data, no duplicate.

## What is stored where — do not shortcut this

- **`auth.identities`** — one row per provider per user. This is where linking
  happens and where the block lives. Nothing in the app reads it.
- **`auth.users.raw_user_meta_data.full_name`** — Google's id token carries
  `name`, and GoTrue files it automatically. **Apple does not**: it sends the
  name exactly once, on the first authorisation, outside the token, so
  `signInWithApple()` copies it across with `supabase.auth.updateUser()`
  immediately. Miss that moment and the name is gone for good.
- **`public.customer_accounts`** — created by `handle_new_auth_user()` with
  status `pending` and `customer_id` null, exactly as for an email signup. A
  social signup is a customer signup. There is **no self-UPDATE policy** on this
  table, so the Apple name lands in auth metadata only; an admin still links the
  row to a `customers` record by hand (or the portal invite does it).
- **Nothing OAuth-related is stored in the app.** No tokens, no `.p8`, no client
  secret. `expo-secure-store` is installed but deliberately unwired — swapping
  the supabase-js storage adapter would sign every existing user out.
- **The client secret** lives only in the Supabase auth config; **the `.p8`**
  lives only in `~/Desktop/DC Solar LLC/secrets/` and inside Supabase. Neither
  belongs in this repo.

## How the client actually signs in

`app/src/lib/oauth.ts` — every export resolves to
`{ok:true} | {ok:'cancelled'} | {ok:false, message}` and none of them throw.

| Platform | Google | Apple |
|---|---|---|
| iOS | dynamic `import()` of `@react-native-google-signin/google-signin` → `configure({webClientId, iosClientId})` → `signIn()` → `idToken` → `supabase.auth.signInWithIdToken` | `AppleAuthentication.signInAsync` → `identityToken` → the same call |
| Android | same as iOS, plus `hasPlayServices()` | no button (Apple has no Android flow) |
| Web | `supabase.auth.signInWithOAuth({provider, redirectTo: origin + '/'})` | same |

**The Apple nonce.** Apple copies whatever string it is given into the `nonce`
claim of the identity token, unmodified; Supabase accepts either the value we
hand it or that value's SHA-256. So the client generates a random 256-bit raw
nonce, gives **Apple `SHA-256(raw)`** and **Supabase the raw value** — a token
lifted from somewhere else cannot be made to match. There is no `globalThis.crypto`
on native (Hermes ships none, React Native installs none, and Expo's WinterCG
runtime installs `TextDecoder`/`URL`/`fetch` but not WebCrypto), and
`expo-crypto` is not a dependency, so `oauth.ts` carries a ~40-line FIPS 180-4
SHA-256 and draws randomness from `crypto.getRandomValues` → `expo-modules-core`'s
`uuid.v4()` (the platform CSPRNG) → `Math.random` as a last resort.

**Web returns `'cancelled'` on success**, which reads backwards until you see
why: supabase-js has already set `window.location.href` and the page is
unloading. `'cancelled'` is the one result whose contract is *do nothing*. The
real outcome lands on the next load of `/`, where `detectSessionInUrl` (web
only — see `lib/supabase.ts`) consumes the URL fragment and `landingRoute()`
routes the session. A **staff** refusal on web therefore shows up as landing
back on the login screen signed out, with the reason in the URL fragment rather
than on screen; the native flows report it inline.

---

## Test plan

Run all six. Numbers 4 and 5 are the ones that catch a wrong client-id list.

1. **New customer, Google, iOS.** A Gmail address that is in neither
   `employees` nor `auth.users`. Tap Continue with Google → picker → lands on
   `/customer`. Check:
   ```sql
   select u.email, i.provider, ca.status
     from auth.users u
     join auth.identities i on i.user_id = u.id
     left join public.customer_accounts ca on ca.user_id = u.id
    where u.email = '<the address>';
   ```
   Expect one `google` identity and a `customer_accounts` row with status
   `pending`.
2. **New customer, Google, web** at https://app.dcsolarkc.com/sign-up. Full-page
   redirect out and back to `/`, then straight to `/customer`. If it comes back
   to the wrong host, `uri_allow_list` is the culprit.
3. **New customer, Apple, iOS.** First authorisation only: choose "Share My
   Email", confirm the name is offered, and afterwards check
   `raw_user_meta_data->>'full_name'` is populated. Sign out, sign in again —
   Apple sends **no** name the second time, which is expected, and the metadata
   must still be there.
4. **Existing password customer taps Google with the same email.** Expect the
   **same `auth.users.id`** and two rows in `auth.identities` (`email` +
   `google`), not a second account. Their invoices and projects must still be
   there.
5. **Staff email → refused.** Sign out, tap Continue with Google, pick
   devonsd311@gmail.com. Expect *"Staff sign in with your email, password and
   6-digit code."* and **no session**. Then confirm nothing linked:
   ```sql
   select provider from auth.identities
    where user_id = (select id from auth.users where email = 'devonsd311@gmail.com');
   ```
   Expect `email` only. Repeat once on web (there the refusal shows as landing
   back on the login screen signed out).
6. **Apple Hide My Email.** Sign in choosing "Hide My Email" and confirm the
   account is created with the `@privaterelay.appleid.com` address. ⚠️ Two
   consequences worth knowing before a customer hits them: that address is what
   `customer_accounts.email` gets, so it will **not** match the address on their
   `customers` record and an admin has to link the row by hand; and mail sent to
   it only relays while the app's Apple team has a **verified Sender email
   address / SPF domain** registered under *Certificates, Identifiers & Profiles
   → Services → Sign in with Apple for Email Communication*. Until
   dcsolarkc.com is registered there, portal invites and password resets to a
   relay address bounce.

Also re-check that **staff login is untouched**: `app/index.tsx` shows no social
buttons, and email + password + 6-digit code still works.

## Owner follow-ups this produces

| Value | Where it comes from | Goes where |
|---|---|---|
| Google **web** client ID | step 1.3 | `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` + `external_google_client_id` (first) |
| Google **web** client secret | step 1.3 | `external_google_secret` — nowhere else |
| Google **iOS** client ID | step 1.4 | `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` + `external_google_client_id` (second) |
| Google **reversed** iOS client ID | step 1.4 | `app.json` plugin `iosUrlScheme` |
| Apple Services ID | step 2b | `external_apple_client_id` (second) |
| Apple Team ID + Key ID + `.p8` | step 2c | Supabase dashboard → Auth → Providers → Apple |
| 🔴 Calendar reminder, every 5 months | step 2d | Devon's calendar |
| Both `EXPO_PUBLIC_*` values again | step 4 | EAS env vars **and** Vercel |
