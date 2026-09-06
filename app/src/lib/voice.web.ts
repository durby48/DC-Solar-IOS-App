/**
 * In-app calling — WEB implementation (see `lib/voice.ts` for the split).
 *
 * HOW A CALL HAPPENS. `twilio-voice-token` mints an Access Token for this
 * signed-in admin (identity = staff_profiles.voice_identity). The Twilio
 * Voice JS SDK opens a WebRTC leg to Twilio with it; Twilio asks the TwiML
 * App's Voice URL — `twilio-voice-outbound` — what to do, and that returns
 * <Dial callerId="+1816…"><Number>the customer</Number></Dial>. No bridge
 * leg, no personal cell: the person's audio is already on the line and the
 * customer sees the DC Solar number.
 *
 * ONE DEVICE PER CALL. A fresh token and a fresh `Device` for every call is
 * simpler than keeping a registered device alive across screens and
 * refreshing its token, and the app does not receive calls in the browser
 * (incoming is Phase 4), so there is nothing to stay registered for.
 *
 * The SDK is imported lazily so it stays out of the initial bundle for every
 * screen that never calls.
 */

import { supabase } from '@/lib/supabase';

import type { ActiveCall, CallState, StartCallInput, StartCallResult } from './voice';

export type { ActiveCall, CallState, StartCallInput, StartCallResult } from './voice';

export function inAppCallingSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

/** The JSON body supabase-js hides on `error.context`. */
async function readPayload(error: unknown): Promise<{ code?: string; error?: string } | null> {
  const context = (error as { context?: unknown })?.context;
  if (!context || typeof context !== 'object') return null;
  try {
    const response = context as Response;
    if (typeof response.clone === 'function') {
      return (await response.clone().json()) as { code?: string; error?: string };
    }
  } catch {
    // not JSON
  }
  return null;
}

async function fetchToken(): Promise<
  { ok: true; token: string } | { ok: false; code?: string; message: string }
> {
  try {
    const { data, error } = await supabase.functions.invoke('twilio-voice-token', { body: {} });
    if (error) {
      const payload = await readPayload(error);
      return {
        ok: false,
        code: payload?.code,
        message: payload?.error ?? error.message ?? 'Could not start the call.',
      };
    }
    const result = data as { ok?: boolean; token?: string; code?: string; error?: string } | null;
    if (!result?.ok || !result.token) {
      return { ok: false, code: result?.code, message: result?.error ?? 'Could not start the call.' };
    }
    return { ok: true, token: result.token };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not start the call.' };
  }
}

export async function startInAppCall(input: StartCallInput): Promise<StartCallResult> {
  if (!inAppCallingSupported()) {
    return { ok: false, code: 'unsupported', message: 'This browser cannot place calls.' };
  }

  const token = await fetchToken();
  if (!token.ok) return token;

  let Device: typeof import('@twilio/voice-sdk').Device;
  try {
    ({ Device } = await import('@twilio/voice-sdk'));
  } catch {
    return { ok: false, message: 'The calling module could not be loaded. Reload the page and try again.' };
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
    return {
      ok: false,
      code: /permission|NotAllowed/i.test(message) ? 'mic_denied' : undefined,
      message: /permission|NotAllowed/i.test(message)
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
  call.on('error', (error: { message?: string }) => finish('failed', error?.message ?? 'The call failed.'));

  const active: ActiveCall = {
    mute: (on) => call.mute(on),
    sendDigits: (digits) => call.sendDigits(digits),
    hangUp: () => call.disconnect(),
  };
  return { ok: true, call: active };
}
