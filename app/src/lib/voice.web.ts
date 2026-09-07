/**
 * In-app calling — WEB implementation (see `lib/voice.ts` for the split).
 *
 * The Twilio Voice JS SDK opens a WebRTC leg to Twilio with the token from
 * `twilio-voice-token`; Twilio asks the TwiML App's Voice URL —
 * `twilio-voice-outbound` — what to do, and that returns
 * <Dial callerId="+1816…"><Number>the customer</Number></Dial>. No bridge leg,
 * no personal cell: the person's audio is already on the line and the
 * customer sees the DC Solar number.
 *
 * ONE DEVICE PER CALL. A fresh token and a fresh `Device` for every call is
 * simpler than keeping a registered device alive across screens and
 * refreshing its token, and the browser does not receive calls (incoming is
 * Phase 4b), so there is nothing to stay registered for.
 *
 * THE DIST BUNDLE, NOT THE PACKAGE ENTRY. The package's `import` export
 * condition points Metro at an ESM build it cannot evaluate ("Cannot set
 * property default of #<Object> which has only a getter" — module-namespace
 * getters vs. the CJS interop). `dist/twilio.js` is the self-contained bundle
 * Twilio's own CDN serves: one file, no internal module graph. It is imported
 * lazily so it stays out of the initial bundle for screens that never call.
 */

// Type-only from './voice' (erased at runtime). The RUNTIME import comes from
// voiceToken.ts: on web, `./voice` resolves to THIS file, and a runtime
// self-import overflowed the call stack (2026-09-07).
import type { ActiveCall, CallState, StartCallInput, StartCallResult } from './voice';
import { fetchVoiceToken } from './voiceToken';

export { fetchVoiceToken } from './voiceToken';
export type { ActiveCall, CallState, StartCallInput, StartCallResult } from './voice';

export function inAppCallingSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

export async function startInAppCall(input: StartCallInput): Promise<StartCallResult> {
  if (!inAppCallingSupported()) {
    return { ok: false, code: 'unsupported', message: 'This browser cannot place calls.' };
  }

  const token = await fetchVoiceToken();
  if (!token.ok) return token;

  type DeviceCtor = typeof import('@twilio/voice-sdk').Device;
  let Device: DeviceCtor;
  try {
    const mod = (await import('@twilio/voice-sdk/dist/twilio.js')) as unknown as {
      Device?: DeviceCtor;
      default?: { Device?: DeviceCtor };
    };
    const fromGlobal = (globalThis as unknown as { Twilio?: { Device?: DeviceCtor } }).Twilio?.Device;
    const found = mod?.Device ?? mod?.default?.Device ?? fromGlobal;
    if (!found) throw new Error('bundle loaded but exposed no Device');
    Device = found;
  } catch (e) {
    // Say WHY. "Could not be loaded" alone sent Devon straight back to us.
    const why = e instanceof Error ? e.message : String(e);
    console.error('voice-sdk import failed', e);
    return {
      ok: false,
      message: `The calling module could not be loaded (${why}). Reload the page and try again.`,
    };
  }

  const device = new Device(token.token, { logLevel: 'error' });
  const emit = (state: CallState, detail?: string) => input.onState(state, detail);

  let call: import('@twilio/voice-sdk').Call;
  try {
    emit('connecting');
    call = await device.connect({
      params: {
        To: input.to,
        ...(input.customerId ? { customerId: input.customerId } : {}),
        ...(input.contactId ? { contactId: input.contactId } : {}),
      },
    });
  } catch (e) {
    device.destroy();
    const message = e instanceof Error ? e.message : 'Could not start the call.';
    const micDenied = /permission|NotAllowed/i.test(message);
    return {
      ok: false,
      code: micDenied ? 'mic_denied' : undefined,
      message: micDenied
        ? 'The browser blocked the microphone. Allow it for this site and try again.'
        : message,
    };
  }

  const finish = (state: CallState, detail?: string) => {
    emit(state, detail);
    try {
      device.destroy();
    } catch {
      // already gone
    }
  };

  call.on('ringing', () => emit('ringing'));
  call.on('accept', () => emit('active'));
  call.on('disconnect', () => finish('ended'));
  call.on('cancel', () => finish('ended'));
  call.on('reject', () => finish('ended', 'They declined the call.'));
  call.on('error', (error: { code?: number; message?: string }) => {
    // 31401 = the browser refused the microphone. Say that in plain words;
    // the SDK's own sentence is aimed at a developer.
    const micDenied = error?.code === 31401 || /permission|NotAllowed/i.test(error?.message ?? '');
    finish(
      'failed',
      micDenied
        ? 'The browser blocked the microphone. Allow it for this site (the lock icon by the address) and try again.'
        : (error?.message ?? 'The call failed.'),
    );
  });

  const active: ActiveCall = {
    mute: (on) => call.mute(on),
    sendDigits: (digits) => call.sendDigits(digits),
    hangUp: () => call.disconnect(),
    speakerSupported: false,
    setSpeaker: async () => {},
  };
  return { ok: true, call: active };
}
