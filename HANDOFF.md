# DC Solar KC App — Session Handoff

*Last updated 2026-08-03 (Mac session: email scanner now LOGS transactions into finance_entries — DEPLOYED (notify v7 via Management API) and backfilled (13 entries since 7/24: 1 deposit $4,715 + 12 expenses $720.01, none job-matched — Chase alerts don't name jobs). Expense rows got a job picker in the edit card (assign to DC-26### or Company), shipped as an OTA update (commit 12db267) — this doubles as the pending OTA-adoption test on build 27: Devon should confirm it lands (close + reopen the app twice). ⚠️ Devon pasted the service-role key, sb_secret key, and a Supabase PAT into the session chat — rotate all three when convenient.)*
*New Claude Code session? Read this file and [PLAN.md](PLAN.md) first — they replace all prior context.*

## What this is

Employee field-ops app for DC Solar LLC (solar installation, Kansas City). One Expo codebase (`app/`) ships iOS (TestFlight) + web. Backend is the **same Supabase project the dcsolarkc.com website/ops console uses** — one database for everything. Owner: Devon Durbin (devonsd311@gmail.com), not a professional developer, mostly on Windows.

## Repo layout

- `app/` — the Expo app (SDK 57, TypeScript, expo-router, src/ layout). All app work happens here.
- `supabase/migrations/` — 10 SQL files, run **manually** by Devon in the Supabase dashboard SQL Editor (no CLI access). Status: **1–11 all applied (#10 run by Devon, #11 run directly via the Management API, both 2026-07-27).**
- `PLAN.md` — original build plan + phases; still the roadmap.
- `HANDOFF.md` — this file. Keep it updated at the end of every session.
- NOT in git: `app/.env` (recreate — see below), `data/` (local business-data exports; the DB is the source of truth), `website/` (separate repo: github.com/durby48/dcsolarkc).

## Accounts & IDs

- Supabase: https://kjamxfezsathrsbztiln.supabase.co — publishable key `sb_publishable_rETJcVvcbKk79wOFSNIlTg_CEFCfbdF` (client-safe). The **secret key** is in Supabase dashboard → Settings → API keys — needed only for admin scripts, never in the app or git.
- Expo/EAS: account `durby`, org `dc-solar`, project `dc-solar-kc` (id c1bf33f2-33a6-4730-9fb3-4b98405c2c82). `npx eas-cli login` once per machine.
- Apple: ASC App ID 6794484032, bundle `com.dcsolarkc.fieldapp`, Apple ID devonsd311@gmail.com. TestFlight: https://appstoreconnect.apple.com/apps/6794484032/testflight/ios
- Builds shipped: #2 (first TestFlight), #3 (Pipeline/PM/More), #4 (stages/totals), #5 (picker fix, stage refresh, finance editing, skyline icon), #14 (session 2: pipeline Contracted/Invoiced buckets + per-completed-job Avg Profit, Pending Install stage, in-app PDF view + share sheet, home-screen widget; #6–#13 were burned by failed attempts — autoIncrement bumps on every try), #18 (session 3, 2026-07-27: same code as #17's commit — verse of the day, job reminders, push-token registration, aps-environment entitlement. #15/#16 burned: provisioning profile lacked Push Notifications capability until Devon enabled it on the App ID; #17 burned: broken Node binary on the EAS builder, infra flake, retry fixed it), #19 (session 3: Financials tab — admin expense dashboard + ledger + add/edit/delete), #20 (session 3: pipeline stage-filter chips, estimate Supplement checkbox, broadened money-word pushes), #21 (session 3: completed_on dates, Active filter, contracts-bucket upsert fix — migration 10), #22 (session 3: photo-upload auto-retry with fresh-path retries, fresh PDFs share under their real document names via `shareLocalPdf`), #23 (session 3: Financials pipeline-mirror card + /ledger drill-downs for estimates/invoices/contracted/paid with PDF actions and period/job-status filters), #24 (session 3: editable contract values on /ledger/contracted via a per-job "Contract value" invoice entry, with a per-job Generate-contract-PDF toggle producing `<job>-Contract.pdf` — off for historical jobs with uploaded signed contracts), #25 (session 3: Materials section + PDF extraction, demo mode removed, web back arrows), #26 (session 3: **first OTA-capable build** — expo-updates enabled; crew must run ≥26 to receive `eas update` pushes). First OTA update published 2026-07-27: **Calendar tab** (Today renamed; This-week card lists Tomorrow→Saturday from job_schedule_dates, explicit "No work for tomorrow", blank later empty days; clock card unchanged). Further OTA updates same day: admin photo delete (migration 12), customer insurance PDFs (migration 13). ⚠️ Devon's build 26 did NOT pick up OTA updates despite correct channel/runtime/env config (cause unconfirmed — possibly device download flake or silent rollback); **build 27** shipped with everything embedded. NEXT SESSION: after Devon confirms 27, publish a trivial `eas update` and verify it lands before relying on OTA again.
- Apple Team ID: E4B2Y6BWCH (in app.json ios.appleTeamId — needed by @bacons/apple-targets).
- EAS env vars (production): EXPO_PUBLIC_SUPABASE_URL/KEY now live on EAS servers — needed because the repo-root .gitignore excludes `.env` from EAS uploads (day-one builds predated the git repo, so this only bit now).
- **EAS build gotchas (learned the hard way on 2026-07-24):**
  - EAS builders run npm 10; local Mac has npm 11. After adding/updating deps, regenerate the lock with `npx -y npm@10 install --package-lock-only` and verify `npx -y npm@10 ci --dry-run`, or the build dies at Install dependencies with "lock file out of sync".
  - eas-cli's App Groups capability auto-sync hits an Apple API bug ("request entity is not a valid request document object"). App Groups were enabled manually in the Apple Developer portal (group.com.dcsolarkc.fieldapp on both com.dcsolarkc.fieldapp and .widget) — done, shouldn't recur.
  - Creating a provisioning profile for a NEW target requires a real Apple ID login (interactive) once; after that, builds are fully `--non-interactive` again.
- Twilio: not yet created. EIN for A2P registration: 93-3073873 (Devon enters it into Twilio forms personally).
- **⚠️ Metro minifier must keep function names** (`app/metro.config.js`, added 2026-07-27): terser's name-mangling white-screened the production WEB build with zero console errors — React Navigation reads a screen component's function name (lowercase first letter = render function) and mangled names broke rendering. `keep_fnames`/`keep_classnames` fixes it; dev builds never show the problem, so test web changes against a real `expo export`. Applies to iOS bundles too (slightly larger, harmless).
- **Web app (2026-07-27):** Vercel project `dc-solar-app` (account devonsd311-2585, same one as the dcsolarkc website) serves the static Expo web export — live at https://dc-solar-app.vercel.app, aliased to **app.dcsolarkc.com** (⚠️ works only after Devon adds DNS: CNAME `app` → `cname.vercel-dns.com` at the domain's Google DNS — dcsolarkc.com is NOT on Vercel nameservers). Same Supabase/auth/RLS as iOS; native-only features (widget, push, share sheet, contract-PDF generation) degrade gracefully on web.

## Windows setup (first time)

1. Install Node LTS (nodejs.org) and Git; clone this repo.
2. `cd app && npm install`
3. Create `app/.env`:
   ```
   EXPO_PUBLIC_SUPABASE_URL=https://kjamxfezsathrsbztiln.supabase.co
   EXPO_PUBLIC_SUPABASE_KEY=sb_publishable_rETJcVvcbKk79wOFSNIlTg_CEFCfbdF
   ```
4. Dev: `npx expo start` → scan QR with Expo Go on iPhone (same Wi-Fi), or press `w` for web.
5. **Ship (NEW WORKFLOW since build 26 — OTA updates):** JS/TS-only changes ship with `npx eas-cli update --channel production --environment production --non-interactive --message "<what changed>"` (the `--environment` flag is REQUIRED in non-interactive mode) — reaches installed apps (build ≥26) on next launch, costs NO build quota. Full native builds (`npx eas-cli build --platform ios --profile production --auto-submit --non-interactive`) are needed ONLY when native things change: new native dependency, app.json/plugins/entitlements, expo-updates config, widget code, SDK upgrade. Version bump (1.0.0 → 1.0.x) changes the runtimeVersion → needs a build. Quota note (2026-07-27): Devon nearly exhausted the free plan's monthly builds; OTA exists precisely to stop that. Do NOT create extra Expo accounts to dodge quota.
6. Verify before shipping: `npx tsc --noEmit` and `npx expo export --platform web` must both pass.
7. Ship web (added 2026-07-27 — do this with every iOS build so app.dcsolarkc.com stays in lockstep): from `app/`, after a fresh `npx expo export --platform web`: `Copy-Item .vercel dist -Recurse -Force; Copy-Item public\.vercelignore dist\.vercelignore -Force; cd dist; npx vercel deploy --prod --yes`. The Vercel project link lives at `app/.vercel` (gitignored — recreate with `npx vercel link --yes --project dc-solar-app`); `app/public/vercel.json` (cleanUrls + dynamic-route rewrites) rides into every export automatically. ⚠️ The `.vercelignore` copy is REQUIRED (expo's public-dir copy skips dotfiles): it re-includes `assets/node_modules/**` — Vercel otherwise silently drops the @expo/vector-icons font and every icon on the web renders as tofu ("emojis not rendering", found 2026-07-31).

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
- **Pipeline stage filter (session 3):** chip row under the totals header — All + Active (= everything except Complete) + the 8 stages, each with a live count; filters the job list client-side. State is per-visit (resets to All).
- **jobs.completed_on (migration 10):** date stamped automatically when a job's stage is set to Complete (editable in the job editor; cleared when the stage leaves Complete). Complete cards on the Pipeline show "Completed <date>" instead of the next-date line. Column-fallback machinery in `lib/jobs.ts::payloadAttempts` now generates subsets over three optional column groups (stage / PM / completed_on).
- **contracts bucket fix (migration 10):** document PDF uploads use upsert — the bucket was missing UPDATE/DELETE policies, so re-generating an existing file failed with an RLS violation ("cloud copy failed to save"). Migration 10 adds admin UPDATE + DELETE.
- **Estimate "Supplement" checkbox (session 3):** in the document builder (estimates only) — adds a prefilled line item: name "Supplement", $136/panel, qty 1 (Devon adjusts qty per estimate), with the racking-&-railing warranty paragraph as the item description (prints under the item name on the PDF; constants at the top of `document-builder.tsx`).
- **Ledger drill-downs (session 3, build 23):** the Financials tab mirrors the Pipeline header numbers (same `fetchCompanyTotals`, same rows) in a second card whose tiles open `/ledger/[view]` (`app/src/app/ledger/[view].tsx`): estimates (every estimate + PDF view/share, grouped per job, "current estimate" footnote), invoices (every invoice + PDF, active/completed job filter + All/Month/Quarter/YTD period chips), contracted (jobs in contracted stages + contract values, tap → job), paid (payments grouped per job). All admin-only, all client-side — no new tables.
- **Crew assignments + calendar views (2026-07-31, migration 16, OTA):** `job_assignments` (job×email, roster-name fill trigger, member read/admin write). Job screen "Assigned crew" chips (admin toggle). Calendar: admin Week|Month toggle — Month is a navigable agenda via `fetchScheduleRange`; assigned crew first names show on every calendar entry. Crew hours/my-hours (migrations 14–15): own-row entries + admin manage-all, hours×date no clock times, roster rate via trigger.
- **Materials (session 3, migration 11, build 25):** job Materials section is live (`components/JobMaterials.tsx`, `lib/materials.ts`, `job_materials` table — crew read, admin write, name × qty only, NO pricing). Admins add items manually, upload materials PDFs (doc_type 'materials', contracts bucket), and tap Extract → `supabase/functions/extract-materials` (verify-JWT ON + admin check; unpdf text extraction + qty heuristics) returns candidate items reviewed with checkboxes before saving. Extraction is heuristic — expect to uncheck junk rows on messy PDFs.
- **Edge functions deploy via the Management API** (no dashboard paste needed): `POST /v1/projects/<ref>/functions/deploy?slug=<name>` multipart with `metadata` (JSON: entrypoint_path/name/verify_jwt) + `file`. notify=verify_jwt FALSE (shared secret), extract-materials=verify_jwt TRUE. notify redeployed to v4 (broadened money words) 2026-07-27.
- **Demo mode removed from the sign-in screen** (session 3, build 25): crew must sign in; the mock-data fallbacks remain in the libs but there is no UI entry point. Web-only header back button lives in `_layout.tsx` (native-stack renders no arrow on web).
- **Direct SQL access (2026-07-27):** Devon issued a Supabase personal access token (stored OUTSIDE the repo at `C:\Durbin Enterprises\config\secrets\supabase-access-token.txt`); sessions on this PC run migrations via the Management API `database/query` endpoint — still write each migration file to `supabase/migrations/` for the record.
- **Financials tab (session 3):** 4th tab between Pipeline and More (`(tabs)/financials.tsx`, data in `lib/financials.ts`). Admin-only (viewers/demo get a friendly placeholder). Overview tiles (Paid in / Expenses / Net / This month) + the full company expense ledger grouped by month with subtotals, each row editable/deletable via the existing `updateFinanceEntry`/`deleteFinanceEntry`. "+ Add expense" inserts a finance_entries row (type=expense, direction=out, status=recorded — same shape receipts approval writes) with optional job chip (job_id null = company overhead), so Pipeline profit math picks job-tied ones up automatically.

## Notifications (added 2026-07-24 evening)

- **Local job reminders** (shipped): `lib/notifications.ts` schedules on-device notifications 24h and 1h before each job_schedule_dates start (next 14 days, default 8:00 AM when start_time is null). Re-synced on every Today-screen load; deduped via data.type tag. No server needed.
- **Verse of the day** (shipped): `lib/verses.ts` (42 public-domain-phrasing verses about work), shown on the sign-in screen instead of the old tagline; rotates daily, same verse for the whole crew.
- **Push token registration** (shipped, dormant): devices upsert Expo push tokens into `push_tokens` (migration 9) on sign-in. Nothing sends pushes yet.
- **Email-triggered pushes** (BUILT 2026-07-27, session 3 — awaiting Devon's one-time setup): code is in the repo — Edge Function `supabase/functions/notify/index.ts` (shared-secret auth, accepts direct/{from,subject,snippet}/db-webhook payloads, pushes to ADMINS by default via push_tokens + Expo push API) and Gmail poller `docs/gmail-notify.gs`. **Full setup checklist: `docs/NOTIFICATIONS_SETUP.md`** — APNs key (`npx eas-cli credentials -p ios`, interactive), deploy function + NOTIFY_SECRET in the dashboard, Gmail labels/filters, Apps Script + 5-min trigger, optional finance_entries INSERT webhook.
- **Chase bank alerts** (Devon enabled deposits 2026-07-27; purchase/withdrawal alerts = Devon's next Chase visit): business alerts email devon@dcsolarkc.com — deposits AND (once enabled) debit purchases, ACH withdrawals, wires, checks. All ride the same Gmail-filter pipeline (filter Chase's sender → DC-Notify label). Money-word subjects get a 💰 push. Bank alerts push to admins only.
- **Email → finance_entries transaction logging (BUILT 2026-08-03, Mac session — needs deploy + Apps Script repaste + backfill):** the `notify` function now parses every Gmail-shape payload for a transaction — dollar amount (balance-adjacent amounts excluded) + in/out keywords (deposit/remittance/"payment received"/"has paid" → type `payment` direction `in`; purchase/debit card/withdrawal/"check cleared"/"payment to" → `expense`/`out`) — and inserts a finance_entries row via the service role: description = subject, counterparty = sender name, occurred_on = email date, job auto-matched by DC-26### in the text or a unique job-name substring (else company-level, job_id null). Tagged `extracted: {source:'email-scanner', gmail_message_id, keyword, matched_job}`; deduped on gmail_message_id so re-sends are safe. The finance_entries INSERT webhook branch SKIPS email-scanner payments (email path already pushed — no doubles). Ambiguous emails (no amount / no keyword, e.g. "estimate accepted") push but don't log. `docs/gmail-notify.gs` now forwards messageId/date/body(4000 chars) — Devon must repaste it over the old Code.gs — and gained `backfillDcNotify()`: replays all DC-Notify mail since 2026-07-24 with `backfill:true` (logs entries, sends NO pushes, safe to re-run; per-email results in the Apps Script execution log). LIVE since 2026-08-03: notify v7 deployed, gmail-notify.gs repasted, backfill run (13 entries logged; first attempt failed because the OLD function was still deployed — it push-spammed on backfill payloads and logged nothing; redeploying fixed it). Wrong classifications are fixable in the app's finance edit UI, which now includes a job picker per expense row.

## State / near-term TODO

0. **Notifications go-live — DONE 2026-07-27: APNs push key uploaded (3V8AND3562), `notify` deployed + secret set, tested end-to-end (`{"sent":1}`). REMAINING (Devon): Gmail labels/filters (in progress), Apps Script + 5-min trigger, optional payment webhook — see `docs/NOTIFICATIONS_SETUP.md` steps 3–5. NOTIFY_SECRET lives in the edge function's secrets + (soon) the Apps Script properties.**
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
