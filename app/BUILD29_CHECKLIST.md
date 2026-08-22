# Build 29 checklist (Phase 2 — the native manifest)

Build 29 is the one native build of the 2026-08 overhaul. Everything after it
ships over the air on **runtime 2**. Nothing native can be added later without
burning another build, so the list below has to be complete *before* the build
runs.

**Do not run the build until every box in "Owner prerequisites" is ticked.**
`eas.json` has `autoIncrement: true` with `appVersionSource: remote`, so **every
attempt consumes a build number whether it succeeds or fails** — builds #6–#13,
#15–#17 were all burned that way. Expect the next successful build to be **≥29**;
never hardcode "29" in anything the crew reads.

---

## What is already staged in the repo

Committed as part of Workstream J (staging only — no build has been run):

| Change | File |
|---|---|
| `runtimeVersion` → `"2"` (was `{policy: "appVersion"}`) | `app.json` |
| `ios.usesAppleSignIn: true` | `app.json` |
| Plugins: `expo-apple-authentication`, `expo-video`, `expo-sensors` | `app.json` |
| 14 new packages + 18 SDK-57 patch bumps | `package.json`, `package-lock.json` |
| Olive palette mirrored into the widget + on-clock dot turned olive | `targets/widget/*` |
| Olive ramp added to `colors` (add-only, no screen restyled) | `src/constants/theme.ts` |

`expo.version` stays **`1.0.0`** and `metro.config.js` is untouched — both are
verified by `git diff` and must stay that way.

### Why runtimeVersion "2" matters

Build 28 and a naive build 29 would both report runtime `1.0.0`, so the first
OTA importing a new native module (`expo-linear-gradient`, `react-native-svg`, …)
would **crash every build-28 phone on launch**. Pinning `"2"` freezes build 28 at
its last bundle — no crash, just no more updates — and gives the overhaul its own
update lane. Future native releases become `"3"`.

The consequence: **the crew must install build 29 by hand.** Their phones stop
receiving OTAs the moment this ships, until they do.

---

## Owner prerequisites (Devon) — all four block the build

### 1. Apple — enable Sign in with Apple on the App ID  ⛔ blocking

Do this **manually in the Apple Developer portal**, not through EAS. `eas
capability sync` has silently failed on this project before, and a provisioning
profile missing the capability is exactly how builds #15/#16 were burned.

1. https://developer.apple.com/account → Certificates, Identifiers & Profiles → **Identifiers**
2. Open App ID **`com.dcsolarkc.fieldapp`** (Team `E4B2Y6BWCH`)
3. Tick **Sign In with Apple** → Save → confirm the "modify capabilities" prompt
4. Leave it as a primary App ID (no grouping needed)

`app.json` already sets `ios.usesAppleSignIn: true`, so EAS will request a
profile carrying the entitlement. If the App ID doesn't have it, the build fails
at code-signing and the number is gone.

Separately, for the *server* side of Apple sign-in (not build-blocking, needed
before the Phase-3 login UI works): Services ID `com.dcsolarkc.fieldapp.web`,
plus a `.p8` key pasted into the Supabase dashboard. **That secret expires every
6 months — put a calendar reminder on it.**

### 2. Google — iOS + Web OAuth client IDs  ⛔ blocking

See **`GOOGLE_SIGNIN_TODO.md`** in this folder for the full walkthrough. Short
version: Google Cloud → OAuth consent screen (External; `email`, `profile`,
`openid`) → a **Web** client with redirect
`https://kjamxfezsathrsbztiln.supabase.co/auth/v1/callback` → an **iOS** client
for `com.dcsolarkc.fieldapp`. About 15 minutes.

### 3. Add the Google Sign-In plugin entry  ⛔ blocking

`@react-native-google-signin/google-signin@16.1.4` is installed and locked, but
**its plugin is deliberately absent from `app.json`** because it needs the
reversed iOS client ID from step 2. Once you have it, append to `expo.plugins`:

```json
[
  "@react-native-google-signin/google-signin",
  {
    "iosUrlScheme": "com.googleusercontent.apps.<REVERSED_IOS_CLIENT_ID>"
  }
]
```

Then re-run `npx expo config --type public`, `npx expo export --platform web`,
and `npx tsc --noEmit` before building. Google sign-in is a **native** capability
— if build 29 ships without this entry, it cannot be fixed by an OTA and stays
broken until build 30.

### 4. Login MP4 — **not found; the WebP stays**  ✅ not blocking

The source `login-solarflow.mp4` (~2.55 MB, 720p, 24 fps) **could not be located
on this PC.** Searched `Downloads`, `Desktop`, `Videos`, `Documents`, `OneDrive`
and then the entire user profile for `*.mp4` / `*.mov` / `*.m4v` matching
"solar", "flow", or "login", plus every mp4 between 1.5 and 4 MB modified after
2026-06-01. The only name match was `Downloads\DC Solar Weeks 1&2.mp4` — a 92 MB
screen recording, not the login clip. There is no video file anywhere in the repo.

So `assets/images/login-solarflow.webp` (**7.1 MB — 76 % of the asset payload,
re-shipped in every OTA**) stays for now. `expo-video` is still installed and its
plugin is configured, so the swap is a pure OTA change the day the MP4 turns up:
drop it at `assets/images/login-solarflow.mp4`, point `src/app/index.tsx` at it,
delete the WebP. No new build required.

If Devon finds it (Google Drive, an old phone, the video editor's project
folder), hand it over before the build only if you also want the 4.5 MB saving in
the *embedded* bundle; otherwise it can wait.

---

## The build command

Run from `app/`:

```
npx eas-cli build --platform ios --profile production --auto-submit --non-interactive
```

- `--profile production` → channel `production`, `autoIncrement: true`
- `--auto-submit` → uploads to App Store Connect (`ascAppId` 6794484032) on success
- Expect build number **≥29**. Check what actually came out with
  `npx eas-cli build:list --platform ios --limit 3` and use *that* number in any
  note to Devon.

**TestFlight submissions have queued for 70+ minutes on this project** (an Expo
incident on 2026-08-18 stalled build 28's submission). Do not resubmit early —
a duplicate submission is another burned number. Watch the EAS submission page
instead.

Do **not** run `eas update` against runtime 2 until build 29 is confirmed
installed on at least one device; there is nothing on runtime 2 to update yet.

---

## Crew install message (send verbatim)

> New DC Solar app update. Open TestFlight → DC Solar KC → Update. You have to install this one manually — automatic in-app updates are paused until you do. After it opens, go to More, scroll to the bottom, and tell Devon what the small grey line says. It should read `runtime 2`.

Six people: Devon plus the five-person crew. Nobody's phone gets another OTA
until they've done this.

---

## How to verify the build is right

1. **Install from TestFlight**, open the app, go to **More** and scroll to the
   bottom. `components/BuildInfo.tsx` renders:

   ```
   DC Solar KC 1.0.0 · runtime 2 · production
   embedded bundle (no OTA applied yet)
   ```

   **`runtime 2` is the whole test.** If it still says `runtime 1.0.0`, the
   binary was built from a commit before the `app.json` change — stop and
   rebuild rather than publishing an OTA on top of it.

2. **A phone still on build 28 must keep working.** Open it, confirm it does not
   crash and its `update …` id is unchanged. It should simply stop receiving new
   updates. If a build-28 phone crashes on launch after an OTA, the runtime split
   didn't take.

3. **Widget:** clock in and confirm the home-screen widget's status dot is now
   **olive**, not blue, and its background is still cream.

4. **Sign in with Apple** shows up in the entitlements: the build log's
   "Configure provisioning profile" step should list Sign In with Apple. (The
   login *button* is Phase 3 — not expected in this build.)

5. Static checks, from `app/`, all clean before you build:

   ```
   npx expo export --platform web
   npx tsc --noEmit
   npx expo export --platform web
   npx -y npm@10 ci --dry-run
   npx expo-doctor
   ```

   The lock must be **npm-10 shaped** — EAS builders run npm 10, and npm 11
   rewrites the file in a way they choke on. Regenerate it only with
   `npx -y npm@10 install --package-lock-only`, never with the local npm 11.
   `npm ci --dry-run` reporting ~10 `lightningcss-*` packages to add is normal
   on Windows: those are the optional macOS/Linux native binaries npm correctly
   skips here and the EAS builder needs.

---

## What is deliberately NOT in this build

- **`lottie-react-native`** — no Lottie asset exists anywhere in the repo, so the
  dependency would be dead weight in the binary. Adding it later needs build 30.
- **`expo-av`** — removed from SDK 57. `expo-video` replaces it.
- **`expo-secure-store` config plugin** — the package is installed and locked so
  it is available later, but the v57 docs make the plugin entry optional and its
  only props (`configureAndroidBackup`, `faceIDPermission`) are Android-backup
  and Face ID settings this app does not use. **The package is carried, not
  wired**: switching Supabase's auth storage to SecureStore signs every user out
  once, so that is a deliberate later decision, not a build-29 change.
- **Contacts / calendar modules** — not part of the overhaul.
- **`expo-image` plugin** — this one *is* present, added automatically by
  `npx expo install --fix` when `expo-image` went to 57.0.3, which is the first
  version to ship a config plugin. Its only prop (`disableLibdav1d`) is left at
  its default; the entry is a no-op that keeps the manifest matching what a fresh
  `expo install` produces.
