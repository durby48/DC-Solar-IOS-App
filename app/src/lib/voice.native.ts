/**
 * In-app calling — NATIVE implementation (see `lib/voice.ts` for the split).
 *
 * Build 30 / runtime 3 (2026-09-07): the Twilio Voice React Native SDK,
 * `2.0.0-preview.2`. The phone places the call itself, from the DC Solar
 * number, and iOS shows it as a real call (CallKit: lock screen, the green
 * bar, the system call screen) — the SDK does that integration itself, which
 * is why `contactHandle` is required on iOS: it is the name CallKit shows.
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

import type { Call as TwilioCall, Voice as TwilioVoice } from '@twilio/voice-react-native-sdk';

// Type-only from './voice' (erased at runtime). The RUNTIME import comes from
// voiceToken.ts: on iOS, `./voice` resolves to THIS file, and a runtime
// self-import overflows the call stack (found on web 2026-09-07; same bug).
import type { ActiveCall, CallState, StartCallInput, StartCallResult } from './voice';
import { fetchVoiceToken } from './voiceToken';

export { fetchVoiceToken } from './voiceToken';
export type { ActiveCall, CallState, StartCallInput, StartCallResult } from './voice';

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
  const { Call, AudioDevice } = mod;

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

  call.on(Call.Event.Ringing, () => emit('ringing'));
  call.on(Call.Event.Connected, () => emit('active'));
  call.on(Call.Event.Reconnecting, () => emit('active', 'Reconnecting…'));
  call.on(Call.Event.Reconnected, () => emit('active'));
  call.on(Call.Event.ConnectFailure, (error) => emit('failed', error?.message ?? 'The call failed.'));
  call.on(Call.Event.Disconnected, (error) =>
    error ? emit('failed', error.message ?? 'The call dropped.') : emit('ended'),
  );

  const active: ActiveCall = {
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
  return { ok: true, call: active };
}
