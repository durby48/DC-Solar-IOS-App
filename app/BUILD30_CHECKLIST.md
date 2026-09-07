# Build 30 checklist (Phase 4 — in-app calling on iPhone)

Build 30 is the native build that lets the iPhone place calls itself, from the
DC Solar number, with the real iOS call screen. Everything after it ships over
the air on **runtime 3**. Build 29 phones are frozen on runtime 2 from the
moment this ships: no crash, just no more updates, until the crew installs
build 30 from TestFlight.

`eas.json` has `autoIncrement: true` with `appVersionSource: remote`, so **every
attempt consumes a build number whether it succeeds or fails**. Never hardcode
"30" in anything the crew reads.

---

## What changed natively (why this needs a build)

| Change | File |
|---|---|
| `@twilio/voice-react-native-sdk` **2.0.0-preview.2** (native module; iOS via autolinking, Android via its Expo module) | `package.json`, `package-lock.json` |
| `runtimeVersion` → `"3"` | `app.json` |
| `NSMicrophoneUsageDescription` — iOS refuses the mic without it | `app.json` |
| `UIBackgroundModes: ["audio", "voip"]` — the call keeps its audio when the screen locks | `app.json` |
| `android.permission.RECORD_AUDIO` | `app.json` |

`expo.version` stays **`1.0.0`** and `metro.config.js` is untouched.

Why a **preview** SDK: it is the only line that installs on Expo 57 / RN 0.86
without hand-editing AppDelegate. It runs through the New Architecture interop
layer, and Twilio's tracker has an open, unanswered report of audio clipping on
loud input on exactly this stack. If a call sounds bad, that is the first
suspect; the fix is "wait for 2.x stable", not code.

## What did NOT change

- No new Apple capabilities. Push Notifications (`aps-environment`) was enabled
  for build 18 and is still on the App ID; VoIP background mode is an
  Info.plist key, not a capability. **No provisioning-profile change expected.**
- No VoIP Services certificate yet — that is only needed for INCOMING calls
  (Phase 4b). Outbound works without it.
- The web app is unaffected; it already calls from the browser.

## Owner prerequisites (Devon)

None that block the build. The three Twilio secrets for in-app calling
(`TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET`, `TWILIO_TWIML_APP_SID`) are set
(2026-09-07), the TwiML App's Voice URL points at `twilio-voice-outbound`, and
the first call from the web app is the same path the phone will take.

## After the build

1. **TestFlight install, every crew phone.** Same as build 29: open TestFlight,
   install the newest build. The More tab's footer must read **runtime 3**.
2. **First real call, on a device** — nothing below can be tested on web or in
   the simulator:
   - Phone → Keypad → dial your own cell → Call. iOS asks for the microphone
     once. The iOS call screen appears (CallKit); your cell rings showing
     (816) 744-6473.
   - Speaker / earpiece toggle, then a Bluetooth headset if there is one.
   - Lock the phone mid-call: audio must continue (that is `UIBackgroundModes`).
   - Recents shows the call with its duration once it ends.
3. **Audio quality.** Speak loudly on purpose. Clipping or crackle = the known
   SDK issue; note it in HANDOFF and keep the bridge as the workaround (it is
   still there: the call screen offers it when in-app calling fails).
4. Only after a good call: publish the next OTA with `eas update` — it now
   targets runtime 3 and nobody on build 29 will see it.

## Message to the crew

> New TestFlight build is up — please install it today. This one lets you call
> customers straight from the app, from the DC Solar number, with the normal
> iPhone call screen. Until you install it your app stops getting updates. Open
> TestFlight → DC Solar KC → Install, then in the app tap More and check the
> footer says runtime 3.
