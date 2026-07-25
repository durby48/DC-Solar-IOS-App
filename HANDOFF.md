# DC Solar KC App — Session Handoff

*Last updated 2026-07-24 (end of day-one build session, on a borrowed Mac).*
*New Claude Code session? Read this file and [PLAN.md](PLAN.md) first — they replace all prior context.*

## What this is

Employee field-ops app for DC Solar LLC (solar installation, Kansas City). One Expo codebase (`app/`) ships iOS (TestFlight) + web. Backend is the **same Supabase project the dcsolarkc.com website/ops console uses** — one database for everything. Owner: Devon Durbin (devonsd311@gmail.com), not a professional developer, mostly on Windows.

## Repo layout

- `app/` — the Expo app (SDK 57, TypeScript, expo-router, src/ layout). All app work happens here.
- `supabase/migrations/` — 7 SQL files, run **manually** by Devon in the Supabase dashboard SQL Editor (no CLI access). Status: **1–6 confirmed applied; #7 (finance_editing) delivered but not yet confirmed — ASK DEVON.**
- `PLAN.md` — original build plan + phases; still the roadmap.
- `HANDOFF.md` — this file. Keep it updated at the end of every session.
- NOT in git: `app/.env` (recreate — see below), `data/` (local business-data exports; the DB is the source of truth), `website/` (separate repo: github.com/durby48/dcsolarkc).

## Accounts & IDs

- Supabase: https://kjamxfezsathrsbztiln.supabase.co — publishable key `sb_publishable_rETJcVvcbKk79wOFSNIlTg_CEFCfbdF` (client-safe). The **secret key** is in Supabase dashboard → Settings → API keys — needed only for admin scripts, never in the app or git.
- Expo/EAS: account `durby`, org `dc-solar`, project `dc-solar-kc` (id c1bf33f2-33a6-4730-9fb3-4b98405c2c82). `npx eas-cli login` once per machine.
- Apple: ASC App ID 6794484032, bundle `com.dcsolarkc.fieldapp`, Apple ID devonsd311@gmail.com. TestFlight: https://appstoreconnect.apple.com/apps/6794484032/testflight/ios
- Builds shipped: #2 (first TestFlight), #3 (Pipeline/PM/More), #4 (stages/totals), #5 (picker fix, stage refresh, finance editing, skyline icon) — #5 submitted at end of session.
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
- Historic data imported from Devon's P&L spreadsheet is tagged `pnl-import-2026-07-24` (finance_entries.extracted / employee_hours description).

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
