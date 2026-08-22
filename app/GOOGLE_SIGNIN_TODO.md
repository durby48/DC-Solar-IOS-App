# ✅ DONE (2026-08-22): Google Sign-In config plugin is in `app.json`

This file used to be the one build-blocking item for social login. It is
resolved — kept only so the history in HANDOFF/plan links still land somewhere.

What was done on 2026-08-22 (full walkthrough stays in
[`docs/SOCIAL_LOGIN_SETUP.md`](../docs/SOCIAL_LOGIN_SETUP.md)):

- **Google Cloud** — Devon created the Web client (redirect
  `https://kjamxfezsathrsbztiln.supabase.co/auth/v1/callback`) and the iOS client
  for `com.dcsolarkc.fieldapp`.
- **`app.json`** — plugin entry added with
  `iosUrlScheme: com.googleusercontent.apps.746927911368-kq2d49b1amnetvh3q1tu1eo7ir74m8cc`
  (`npx expo config --type public` parses; `tsc` + web export clean).
- **`app/.env`** (gitignored) — `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` and
  `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` set; the same two variables exist on **EAS**
  (production) and **Vercel** (production + preview). The web bundle inlines the
  web client id and the `/sign-up` prerender now renders "Continue with Google"
  and "Sign in with Apple".
- **Supabase** — `external_google_enabled` with the comma-listed web,iOS client
  ids + secret (`skip_nonce_check` off); `external_apple_enabled` with client ids
  `com.dcsolarkc.fieldapp,com.dcsolarkc.fieldapp.web` and a secret JWT signed from
  Apple key `ZFPHJ32K5K` (Team `E4B2Y6BWCH`) for the Services ID
  `com.dcsolarkc.fieldapp.web`. **That secret expires 2027-02-18** — regenerate
  with `node scripts/auth/apple-secret.mjs` (see the script header) and re-PATCH
  `external_apple_secret`. Only web Apple sign-in breaks if it lapses; native
  uses `signInWithIdToken` and never needs it.
- **Secrets on disk (never in git):** `C:\Durbin Enterprises\config\secrets\google-oauth-dcsolar.txt`
  and `apple-signin-AuthKey_ZFPHJ32K5K.p8`.

Still on Devon before `eas build`: confirm **Sign In with Apple is enabled on the
App ID `com.dcsolarkc.fieldapp`** (Identifiers → App IDs → capability checkbox —
EAS's capability sync has failed on this project before) and that the Services
ID's "Configure" lists domains `kjamxfezsathrsbztiln.supabase.co` +
`app.dcsolarkc.com` with return URL
`https://kjamxfezsathrsbztiln.supabase.co/auth/v1/callback`.
