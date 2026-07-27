# DC Solar KC App — Session Handoff

*Last updated 2026-07-27 (session 3, Windows PC: build #18 shipped to TestFlight — recovery of the failed #15–#17 attempts; repo lives at C:\Durbin Enterprises\DC-Solar-IOS-App; new GitHub deploy key `dc-solar-app-push-windows`).*
*New Claude Code session? Read this file and [PLAN.md](PLAN.md) first — they replace all prior context.*

## What this is

Employee field-ops app for DC Solar LLC (solar installation, Kansas City). One Expo codebase (`app/`) ships iOS (TestFlight) + web. Backend is the **same Supabase project the dcsolarkc.com website/ops console uses** — one database for everything. Owner: Devon Durbin (devonsd311@gmail.com), not a professional developer, mostly on Windows.

## Repo layout

- `app/` — the Expo app (SDK 57, TypeScript, expo-router, src/ layout). All app work happens here.
- `supabase/migrations/` — 9 SQL files, run **manually** by Devon in the Supabase dashboard SQL Editor (no CLI access). Status: **1–9 all confirmed applied (8 and 9 run 2026-07-24 night).**
- `PLAN.md` — original build plan + phases; still the roadmap.
- `HANDOFF.md` — this file. Keep it updated at the end of every session.
- NOT in git: `app/.env` (recreate — see below), `data/` (local business-data exports; the DB is the source of truth), `website/` (separate repo: github.com/durby48/dcsolarkc).

## Accounts & IDs

- Supabase: https://kjamxfezsathrsbztiln.supabase.co — publishable key `sb_publishable_rETJcVvcbKk79wOFSNIlTg_CEFCfbdF` (client-safe). The **secret key** is in Supabase dashboard → Settings → API keys — needed only for admin scripts, never in the app or git.
- Expo/EAS: account `durby`, org `dc-solar`, project `dc-solar-kc` (id c1bf33f2-33a6-4730-9fb3-4b98405c2c82). `npx eas-cli login` once per machine.
- Apple: ASC App ID 6794484032, bundle `com.dcsolarkc.fieldapp`, Apple ID devonsd311@gmail.com. TestFlight: https://appstoreconnect.apple.com/apps/6794484032/testflight/ios
- Builds shipped: #2 (first TestFlight), #3 (Pipeline/PM/More), #4 (stages/totals), #5 (picker fix, stage refresh, finance editing, skyline icon), #14 (session 2: pipeline Contracted/Invoiced buckets + per-completed-job Avg Profit, Pending Install stage, in-app PDF view + share sheet, home-screen widget; #6–#13 were burned by failed attempts — autoIncrement bumps on every try), #18 (session 3, 2026-07-27: same code as #17's commit — verse of the day, job reminders, push-token registration, aps-environment entitlement. #15/#16 burned: provisioning profile lacked Push Notifications capability until Devon enabled it on the App ID; #17 burned: broken Node binary on the EAS builder, infra flake, retry fixed it).
- Apple Team ID: E4B2Y6BWCH (in app.json ios.appleTeamId — needed by @bacons/apple-targets).
- EAS env vars (production): EXPO_PUBLIC_SUPABASE_URL/KEY now live on EAS servers — needed because the repo-root .gitignore excludes `.env` from EAS uploads (day-one builds predated the git repo, so this only bit now).
- **EAS build gotchas (learned the hard way on 2026-07-24):**
  - EAS builders run npm 10; local Mac has npm 11. After adding/updating deps, regenerate the lock with `npx -y npm@10 install --package-lock-only` and verify `npx -y npm@10 ci --dry-run`, or the build dies at Install dependencies with "lock file out of sync".
  - eas-cli's App Groups capability auto-sync hits an Apple API bug ("request entity is not a valid request document object"). App Groups were enabled manually in the Apple Developer portal (group.com.dcsolarkc.fieldapp on both com.dcsolarkc.fieldapp and .widget) — done, shouldn't recur.
  - Creating a provisioning profile for a NEW target requires a real Apple ID login (interactive) once; after that, builds are fully `--non-interactive` again.
- Twilio: not yet created. EIN for A2P registration: 93-3073873 (Devon enters it into Twilio forms personally).

## Windows setup (first time)

1. Install Node LTS (nodejs.org) and Git; clone this repo.
2. `cd app && npm install`
3. Create `app/.env`:
   ```
   EXPO_PUBLIC_SUPABASE_URL=https://kjamxfezsathrsbztiln.supabase.co
   EXPO_PUBLIC_SUPABASE_KEY=sb_publishable_rETJcVvcbKk79wOFSNIlTg_CEFCfbdF
   ```
4. Dev: `npx expo start` → scan QR with Expo Go on iPhone (same Wi-Fi), or press `w` for web.
5. Ship: `npx eas-cli login` then `npx eas-cli build --platform ios --profile production --auto-submit --non-interactive` (fully hands-free; ascAppId is in eas.json).
6. Verify before shipping: `npx tsc --noEmit` and `npx expo export --platform web` must both pass.

## People / logins

All 6 employees have Supabase auth logins; shared temp password `DCSolarKC2026` with forced personal-password change on first app sign-in (`must_change_password` user_metadata flag → /set-password screen).

| Person | Email (app identity) | Role | Rate |
|---|---|---|---|
| Devon Durbin | devonsd311@gmail.com | owner (admin) | $35 |
| Isaiah Nettleton | inettleton18@gmail.com | operator (admin) | $33 |
| Ben Nettleton | bnettleton403@gmail.com | viewer | $35 |
| Simon Nettleton | snettleton2005@gmail.com | viewer | $30 |
| Garrett Nimsgern | gnimsgern.2022@gmail.com | viewer | $30 |
| Tyler Sisson | tylersisson99@yahoo.com | viewer | $30 |

⚠️ Isaiah also has isaiah.nettleton@dcsolarkc.com (website console only). Its `employees` row was DELETED on purpose so it cannot record app data — his hours land only under the gmail identity. Do not re-add it.

## Key architecture decisions (do not accidentally undo)

- **RLS is the security model.** Admins = employees.role in (owner, operator) via `is_company_admin()`; everyone else sees only their own rows. Finance data, job editing, scheduling, paystub uploads: admin-only at the DB level.
- **Stages vs status:** jobs have a `stage` column (7 pipeline stages, `app/src/lib/stages.ts`) — the app's vocabulary. The legacy `status` (active/completed/on_hold) is kept in sync via `statusForStage()` because the dcsolarkc.com ops console still uses it.
- **Job numbering** (`DC-26###`) is computed from the live jobs table at save time (max+1) — shared with the ops console, no separate counter. Next: DC-26019.
- **finance_entries** got admin UPDATE/DELETE only in migration 7; older code paths assume insert-only — the app's edit UI shows a friendly migration message if #7 isn't applied.
- **Receipts** are a review queue: crew insert → admin approve → the approval INSERTS a finance_entries expense (tagged in `extracted`). Don't let crew write finance_entries directly.
- **Location**: foreground-only GPS at clock in/out (no background tracking yet — that's a future phase with a consent policy).
- **Pipeline header buckets (session 2):** "Contracted" = invoice-entry totals of jobs in Pending Removal/Reinstall/Install/Permit; "Invoiced" = Pending Payment jobs only; "Avg Profit" = mean of per-job (paid − expenses − labor)/paid over Complete jobs with payments. All in `lib/pipeline.ts::fetchCompanyTotals` (needs the jobs list for stages).
- **Home-screen widget (session 2):** WidgetKit target in `app/targets/widget/` via @bacons/apple-targets; app pushes today's job + clock state through App Group `group.com.dcsolarkc.fieldapp` (`lib/widget.ts`, called from the Today screen). Widget shows a live timer while clocked in. Data refreshes only when the app runs — no background fetch.
- **PDF view/share (session 2):** `lib/pdf.ts` — in-app browser sheet for viewing, expo-file-system download + share sheet (iMessage etc.) for sharing. Used by JobDocuments, JobInvoices, paystubs.
- Historic data imported from Devon's P&L spreadsheet is tagged `pnl-import-2026-07-24` (finance_entries.extracted / employee_hours description).

## Notifications (added 2026-07-24 evening)

- **Local job reminders** (shipped): `lib/notifications.ts` schedules on-device notifications 24h and 1h before each job_schedule_dates start (next 14 days, default 8:00 AM when start_time is null). Re-synced on every Today-screen load; deduped via data.type tag. No server needed.
- **Verse of the day** (shipped): `lib/verses.ts` (42 public-domain-phrasing verses about work), shown on the sign-in screen instead of the old tagline; rotates daily, same verse for the whole crew.
- **Push token registration** (shipped, dormant): devices upsert Expo push tokens into `push_tokens` (migration 9) on sign-in. Nothing sends pushes yet.
- **Email-triggered pushes** (NEXT PHASE — payments received / contracts signed / estimates accepted, which Devon currently learns about via email to devon@dcsolarkc.com). Plan:
  1. Devon runs `npx eas-cli credentials -p ios` once to add an APNs push key (remote push won't deliver without it; local reminders are unaffected).
  2. Supabase Edge Function `notify` (service role): takes {title, body, emails?} → looks up push_tokens → POSTs to https://exp.host/--/api/v2/push/send.
  3. Email ingestion (ANSWERED 2026-07-24): devon@dcsolarkc.com is **Google Workspace**; payment confirmations come from **varied contracting companies** (no single fixed sender like QuickBooks). Because senders vary, match via Gmail filters Devon curates, not a hardcoded sender list. Design: Devon creates Gmail filters that apply label `DC-Notify` (e.g., subject contains "payment"/"remittance"/"contract"/"estimate accepted", or per-GC sender filters). A **Google Apps Script** on his account runs every 5 min: search `label:DC-Notify -label:DC-Notified`, POST {from, subject, snippet} to the Supabase Edge Function (shared-secret header), then relabel to DC-Notified. New GC? Devon just adds a Gmail filter — no code change.
  4. Complementary in-app trigger (no email needed): Supabase database webhook on finance_entries INSERT (type=payment) → same notify function, so payments recorded in the app also push to admins.

## State / near-term TODO

1. Confirm migration 7 ran; Devon then fixes his known finance-entry mistakes with the new edit UI.
2. Devon to set each job's real stage (all defaulted to "Pending Estimate", completed → "Complete").
3. Crew TestFlight invites: create an External Testing group in App Store Connect, add the 5 crew emails (first external build needs ~1 day beta review).
4. Next feature phases (see PLAN.md): Twilio number + A2P (ETA texts, review requests), receipts→reimbursement report, admin company dashboard, Gusto data into the Employees screen, migrate the home-PC CRM (Cloudflare tunnel) into Supabase and retire it.
5. Known cosmetic debt: app icon is the skyline wordmark on cream (as requested); Android side untouched; no push notifications yet.

## Conventions for future sessions

- Match the existing visual language: theme tokens in `app/src/constants/theme.ts` (cream/sun/ocean/ink), cards + chips + pills, no new UI libraries.
- Every data fetch degrades gracefully (mock data or friendly message) — never crash on RLS/missing-table errors; demo mode must keep working signed-out.
- New DB changes = new file in `supabase/migrations/` (idempotent: IF NOT EXISTS / drop-policy-then-create), and Devon pastes it into the SQL Editor. Update the status line at the top of this file after.
- Verify with `npx tsc --noEmit` + `npx expo export --platform web` before every EAS build.
