# Push notifications, deep links and incoming calls (2026-09-08)

## What was there before (the audit)

| Question | Answer from the code |
|---|---|
| Library receiving pushes | `expo-notifications` (`lib/notifications.ts`); a foreground handler shows banners. |
| Sender | Edge function `notify` → Expo Push API (`exp.host/--/api/v2/push/send`). |
| Device tokens | `push_tokens` (email, token unique, platform). Registered from Home; RLS: own rows + admin read. |
| Callers of `notify` | DB trigger `notify_webhook()` via pg_net (finance payments, job assignments, schedule days, since 2026-09-08 also leads/tasks/appointments); `twilio-inbound` (texts); the Gmail Apps Script (bank alerts). |
| Payload shape | `{to, title, body, sound}` — **no `data`**. |
| On tap | Nothing. There was no `addNotificationResponseReceivedListener`, no `getLastNotificationResponseAsync`, no router. The app came to the foreground wherever it last was. Same in foreground, background and cold start. **This was the root cause.** |
| Deep links | Scheme `dcsolarkc://`; expo-router maps it to the file routes. No universal links. Not used by notifications. |
| SMS vs lead vs job | Distinguishable only by emoji in the title. |
| Enough ids to route? | No — titles carried a name or a number, nothing else. |
| Incoming calls | The Twilio number's Voice URL was left on Twilio's demo ("the app never receives inbound calls"). No inbound function existed. Outbound in-app calls used `@twilio/voice-react-native-sdk 2.0.0-preview.2`, which **natively owns PushKit (`TwilioVoicePushRegistry`) and CallKit (`reportNewIncomingCall`)** and needs no Info.plist configuration; the token grant said `incoming: {allow: false}`. |
| Native build needed? | **No.** `voip` background mode and the APNs entitlement are already in build 30; everything here is JS + edge functions + one Twilio credential. |

Two token bugs found and fixed: registration only ran when the person had at least one job (a new operator or a viewer never registered), and sign-out never removed the device's token (the previous person's pushes kept arriving until someone else signed in on that phone).

## The contract

Every push carries `data` = a **notification target** (server: `sanitizeTarget()` in `notify`; app: `lib/notificationTargets.ts`):

| type | fields | tap opens |
|---|---|---|
| `sms_thread` | customerId? leadId? contactId? phone? name? | `/messages/thread` — the exact thread the inbound text was filed under |
| `call` | same as sms_thread | the caller's thread (missed calls) |
| `lead` | leadId | `/leads/[id]` |
| `customer` | customerId | `/crm/[id]` |
| `job` | jobId | `/job/[id]` |
| `task` | taskId, leadId?, customerId? | the lead or customer the task belongs to (Home if neither) |
| `appointment` | appointmentId, leadId? | `/leads/[id]` (Calendar if none) |

Strings only, ids only, no bodies, no notes, no secrets. The on-device job reminders' `{type:'job-reminder', jobId}` folds into `job`.

## The router (`lib/notificationRouter.ts`, mounted once in `app/_layout.tsx`)

tap → `parseNotificationTarget(data)` → `routeForTarget()` → `router.push()`. One path for foreground taps, background taps and cold start (`getLastNotificationResponseAsync`). The target is **queued** until the root navigator has a key, a session exists and the pathname has left `/` (i.e. `app/index.tsx` has finished landing the person) — so a cold-start tap is not lost and a tap while signed out continues to the record after login. Each response is handled once (by identifier). A route that cannot be placed falls back to Home; a record that no longer exists is shown by the destination screen's own not-found state.

## Coverage after this change

| Event | Push | Who | Tap target | Status |
|---|---|---|---|---|
| Inbound SMS | yes (`💬 <name or number>` + preview) | admins | exact thread | routing added |
| Missed call to the DC Solar number | **new** (`📞 Missed call`) | admins | caller's thread | new (`twilio-voice-inbound`) |
| Incoming call | **CallKit ring**, not a push | admins registered for calls | answer → `/call` | new; needs the push credential |
| New website lead | yes (`🌐 New website lead`) | admins | the lead | routing added |
| Task assigned to me | **new** (`✅ Task for you`) | the assignee (not self-assignment) | the lead/customer | new (trigger) |
| Appointment given to me | **new** (`📅 Appointment for you`) | the assignee | the lead | new (trigger) |
| Job assignment / removal | yes | the person | the job | routing added |
| Job schedule day added/moved/removed | yes | assigned crew | the job | routing added |
| Payment recorded | yes | admins | the job when known | routing added |
| Job reminders (24 h / 1 h) | local | this device | the job | routing added |
| Task due / overdue | no | — | — | not built (pg_cron candidate) |
| Lead status / job stage changes | no | — | — | deliberately not (noise) |

Lock-screen content: unchanged. Inbound texts show the sender and a 140-character preview on the lock screen, as they did before; nothing else in the app suppresses previews, so no privacy setting was changed.

Preferences: none exist; notifications are operational defaults. Not built now.

## Incoming calls — what is implemented and what Devon must do

Implemented (all JS + edge functions, ships OTA on runtime 3):

- `twilio-voice-inbound`: the number's Voice webhook. Logs the call as a `messages` row (channel call, direction in), identifies the caller like an inbound text, rings every admin's **app** (simultaneous, 25 s) with `displayName` / ids as `<Parameter>`s so CallKit shows the customer's name, falls back to the owner's cell (25 s), then apologises, marks the row `no-answer` and pushes `📞 Missed call` with a `call` target. Child legs report to `twilio-status` via `ParentCallSid`, so answered calls get their duration.
- `twilio-voice-token`: `incoming: {allow: true}` + `push_credential_sid` when the secret `TWILIO_PUSH_CREDENTIAL_SID` exists; the response says `incoming: true/false`.
- App: `registerForIncomingCalls()` (native) registers the device on Home for admins, sets the CallKit display template, and on **answer** parks the live call in `lib/incomingCall.ts` and opens `/call?incoming=1`, which adopts it (timer, mute, keypad, speaker, end). Sign-out unregisters. The browser stays outbound-only.
- Without the credential: `registerForIncomingCalls` reports `not_configured` silently, `twilio-voice-inbound` skips the app and rings the owner's cell — nothing breaks, calls simply keep going to the cell.

**Setup Devon must do (in this order):**
1. Apple Developer → Certificates → **VoIP Services Certificate** for `com.dcsolarkc.fieldapp` (needs a Mac to export the `.p12`; convert to PEM cert + key with `openssl`).
2. Twilio Console → Account → **Push Credentials → Create** (type APN, production; paste the certificate and private key). Copy the `CR…` SID.
3. Supabase edge-function secret `TWILIO_PUSH_CREDENTIAL_SID = CR…` (Management API or dashboard). No redeploy needed.
4. Twilio Console → Phone Numbers → (816) 744-6473 → Voice → **A call comes in**: Webhook, POST, `https://kjamxfezsathrsbztiln.supabase.co/functions/v1/twilio-voice-inbound?k=<TWILIO_WEBHOOK_SECRET>`. (This step alone is worth doing today: it replaces Twilio's demo greeting with "ring the owner's cell".)
5. Isaiah: open Home once on build 30 so his `staff_profiles.voice_identity` is created (the token function creates it) and his device registers.

Not verified on a device in this session (needs the credential and a phone): CallKit ring on lock screen / background / terminated, answer, decline, no duplicate UI. Verified: TwiML generation and gates, token grant shape, registration code paths, `messages` row logging.

Limitations: no voicemail; the fallback cell is the owner's (`role = owner` in `employees`); registration refreshes only when Home opens (tokens last an hour, the Twilio binding a year, so a device that has not opened the app in a year stops ringing).
