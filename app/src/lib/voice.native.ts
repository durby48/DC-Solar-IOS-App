/**
 * In-app calling — NATIVE implementation (see `lib/voice.ts` for the split).
 *
 * Build 30 / runtime 3 (2026-09-07): the Twilio Voice React Native SDK,
 * `2.0.0-preview.2`. The phone places the call itself, from the DC Solar
 * number, and iOS shows it as a real call (CallKit: lock screen, the green
 * bar, the system call screen) — the SDK does that integration itself, which
 * is why `contactHandle` is required on iOS: it is the name CallKit shows.
 *
 * INCOMING CALLS (2026-09-08). The same SDK owns PushKit (VoIP pushes) and
 * reports an invite to CallKit natively — lock screen, ringtone, Answer /
 * Decline — before any JavaScript runs, and it needs no Info.plist config
 * for that (defaults: one call at a time, generic + phone-number handles).
 * What we add: `registerForIncomingCalls()` registers this device with a
 * token that carries the push credential, and when the person ANSWERS, the
 * SDK hands us the live `Call`; we park it in lib/incomingCall.ts and push
 * the `/call` screen, which picks it up. Caller display comes from the TwiML
 * (`<Parameter name="displayName">`) through `setIncomingCallContactHandleTemplate`.
 *
 * WHY A PREVIEW. It is the only line of the SDK that installs on Expo 57 /
 * RN 0.86 without a custom config plugin; the stable 1.x needs AppDelegate
 * edits. It runs through the New Architecture interop layer and there is an
 * open report of audio clipping on loud input on exactly this stack — see the
 * spike in HANDOFF. If a call sounds bad, that is the first suspect.
 *
 * ONE `Voice` FOR THE APP. The SDK's `Voice` is the native singleton's
 * handle; creating one per call is harmless but pointless. Kept lazy so a
 * build without the native module (build 29 never receives this code — it is
 * frozen on runtime 2 — but belt and braces) reports "unsupported" instead
 * of crashing at import.
 */

import { router } from 'expo-router';

import type { Call as TwilioCall, CallInvite as TwilioCallInvite, Voice as TwilioVoice } from '@twilio/voice-react-native-sdk';

import { setIncomingCall, type IncomingCallSession } from './incomingCall';
// Type-only from './voice' (erased at runtime). The RUNTIME import comes from
// voiceToken.ts: on iOS, `./voice` resolves to THIS file, and a runtime
// self-import overflows the call stack (found on web 2026-09-07; same bug).
import type { ActiveCall, CallState, IncomingRegistration, StartCallInput, StartCallResult } from './voice';
import { fetchVoiceToken } from './voiceToken';

export { fetchVoiceToken } from './voiceToken';
export type { ActiveCall, CallState, IncomingRegistration, StartCallInput, StartCallResult } from './voice';

type Sdk = typeof import('@twilio/voice-react-native-sdk');

let sdk: Sdk | null = null;
let voice: TwilioVoice | null = null;

function loadSdk(): Sdk | null {
  if (sdk) return sdk;
  try {
    // Static require, resolved at bundle time; wrapped so a missing native
    // module surfaces as "unsupported", not a red screen.
    sdk = require('@twilio/voice-react-native-sdk') as Sdk;
    return sdk;
  } catch {
    return null;
  }
}

function getVoice(): TwilioVoice | null {
  if (voice) return voice;
  const mod = loadSdk();
  if (!mod) return null;
  try {
    voice = new mod.Voice();
    return voice;
  } catch {
    return null;
  }
}

export function inAppCallingSupported(): boolean {
  return getVoice() !== null;
}

/**
 * Wire one SDK `Call` to our ActiveCall shape and state callback — shared by
 * outgoing calls and answered incoming ones, so both screens behave the same.
 */
function wrapCall(mod: Sdk, v: TwilioVoice, call: TwilioCall, emit: (state: CallState, detail?: string) => void): ActiveCall {
  const { Call, AudioDevice } = mod;
  call.on(Call.Event.Ringing, () => emit('ringing'));
  call.on(Call.Event.Connected, () => emit('active'));
  call.on(Call.Event.Reconnecting, () => emit('active', 'Reconnecting…'));
  call.on(Call.Event.Reconnected, () => emit('active'));
  call.on(Call.Event.ConnectFailure, (error) => emit('failed', error?.message ?? 'The call failed.'));
  call.on(Call.Event.Disconnected, (error) =>
    error ? emit('failed', error.message ?? 'The call dropped.') : emit('ended'),
  );
  return {
    mute: (on) => {
      void call.mute(on);
    },
    sendDigits: (digits) => {
      void call.sendDigits(digits);
    },
    hangUp: () => {
      void call.disconnect();
    },
    speakerSupported: true,
    setSpeaker: async (on) => {
      try {
        const { audioDevices } = await v.getAudioDevices();
        const want = on ? AudioDevice.Type.Speaker : AudioDevice.Type.Earpiece;
        const target =
          audioDevices.find((d) => d.type === want) ??
          // No earpiece reported (an iPad, a headset): fall back to whatever
          // is not the speaker rather than doing nothing.
          (on ? undefined : audioDevices.find((d) => d.type !== AudioDevice.Type.Speaker));
        await target?.select();
      } catch {
        // Audio routing is a convenience; a failure must not end the call.
      }
    },
  };
}

export async function startInAppCall(input: StartCallInput): Promise<StartCallResult> {
  const mod = loadSdk();
  const v = getVoice();
  if (!mod || !v) {
    return {
      ok: false,
      code: 'unsupported',
      message:
        'Calling straight from the app needs the latest build from TestFlight. Until then the call rings your cell first, then connects them.',
    };
  }

  const token = await fetchVoiceToken();
  if (!token.ok) return token;

  const emit = (state: CallState, detail?: string) => input.onState(state, detail);

  let call: TwilioCall;
  try {
    emit('connecting');
    call = await v.connect(token.token, {
      // CallKit's display name on iOS. A bare number is fine; "" is not.
      contactHandle: input.name?.trim() || input.to,
      params: {
        To: input.to,
        ...(input.customerId ? { customerId: input.customerId } : {}),
        ...(input.contactId ? { contactId: input.contactId } : {}),
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not start the call.';
    const micDenied = /permission|microphone|record_audio/i.test(message);
    return {
      ok: false,
      code: micDenied ? 'mic_denied' : undefined,
      message: micDenied
        ? 'The microphone is switched off for DC Solar. Allow it in Settings → DC Solar → Microphone and try again.'
        : message,
    };
  }

  return { ok: true, call: wrapCall(mod, v, call, emit) };
}

// ---------------------------------------------------------------------------
// Incoming calls
// ---------------------------------------------------------------------------

let inviteListenerAttached = false;
let registeredToken: string | null = null;

/** "+18178232944" → "(817) 823-2944"; anything else unchanged. */
function pretty(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

function attachInviteListener(mod: Sdk, v: TwilioVoice): void {
  if (inviteListenerAttached) return;
  inviteListenerAttached = true;
  const { Voice, CallInvite } = mod;

  v.on(Voice.Event.CallInvite, (invite: TwilioCallInvite) => {
    // CallKit is already ringing; the SDK reported the invite natively. We
    // only care about the answer.
    invite.on(CallInvite.Event.Accepted, (call: TwilioCall) => {
      const custom = (invite.getCustomParameters?.() ?? {}) as Record<string, string | undefined>;
      const from = invite.getFrom?.() ?? '';
      const phone = /^\+/.test(from) ? from : (custom.phone ?? from);
      const name = custom.displayName?.trim() || pretty(phone);

      const listeners = new Set<(state: CallState, detail?: string) => void>();
      const session: IncomingCallSession = {
        call: null as unknown as ActiveCall,
        name,
        phone,
        customerId: custom.customerId ?? null,
        leadId: custom.leadId ?? null,
        contactId: custom.contactId ?? null,
        state: 'active',
        detail: null,
        subscribe: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      };
      session.call = wrapCall(mod, v, call, (state, detail) => {
        session.state = state;
        session.detail = detail ?? null;
        for (const fn of listeners) fn(state, detail);
        if (state === 'ended' || state === 'failed') setIncomingCall(null);
      });
      setIncomingCall(session);
      try {
        router.push({ pathname: '/call', params: { incoming: '1' } } as never);
      } catch {
        // The screen will find the session on its next mount.
      }
    });
    invite.on(CallInvite.Event.Rejected, () => setIncomingCall(null));
    invite.on(CallInvite.Event.Cancelled, () => setIncomingCall(null));
  });
}

/**
 * Register this device for incoming calls (CallKit + VoIP push). Called from
 * Home for admins on every open; the registration is a Twilio-side binding
 * so calling it again is a refresh, not a duplicate. Returns why it did
 * not happen when it did not — the UI never shows that, the logs do.
 */
export async function registerForIncomingCalls(): Promise<IncomingRegistration> {
  const mod = loadSdk();
  const v = getVoice();
  if (!mod || !v) return { ok: false, code: 'unsupported', message: 'No native voice module in this build.' };

  const token = await fetchVoiceToken();
  if (!token.ok) {
    return {
      ok: false,
      code: token.code === 'forbidden' ? 'not_admin' : 'not_configured',
      message: token.message,
    };
  }
  if (!token.incoming) {
    return {
      ok: false,
      code: 'not_configured',
      message: 'Incoming calls need TWILIO_PUSH_CREDENTIAL_SID on the edge functions (docs/TWILIO_SETUP.md § 8).',
    };
  }

  try {
    attachInviteListener(mod, v);
    // CallKit shows this instead of the raw From; the TwiML sets displayName
    // to the customer's name when the number is known, else the number.
    await v.setIncomingCallContactHandleTemplate('${displayName}');
    await v.register(token.token);
    registeredToken = token.token;
    return { ok: true };
  } catch (e) {
    return { ok: false, code: 'error', message: e instanceof Error ? e.message : 'Could not register for calls.' };
  }
}

/** Stop ringing this device (sign-out). Needs a valid token; best-effort. */
export async function unregisterForIncomingCalls(): Promise<void> {
  const v = getVoice();
  if (!v) return;
  try {
    const token = registeredToken ?? (await fetchVoiceToken().then((t) => (t.ok ? t.token : null)));
    if (token) await v.unregister(token);
  } catch {
    // The binding expires on Twilio's side on its own.
  } finally {
    registeredToken = null;
  }
}
