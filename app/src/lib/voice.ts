/**
 * In-app calling — the shared contract, and the fallback for a platform that
 * has neither implementation.
 *
 * THREE FILES, ONE API:
 *   voice.web.ts     the browser: Twilio Voice JS SDK, audio through the
 *                    computer. Metro picks it on web.
 *   voice.native.ts  iOS/Android: Twilio Voice React Native SDK (build 30,
 *                    runtime 3). CallKit shows the real phone call UI.
 *   voice.ts         this file. TypeScript resolves `@/lib/voice` here, so the
 *                    types live here; Metro only reaches it on a platform
 *                    with no better match, where it answers "unsupported" and
 *                    every call button falls back to the bridge.
 *
 * The call itself is the same in all three: `twilio-voice-token` mints an
 * Access Token for this admin, the SDK dials Twilio as `client:<identity>`,
 * Twilio asks `twilio-voice-outbound` for TwiML, and that returns a <Dial>
 * with the DC Solar number as caller ID. No bridge leg.
 */

import { supabase } from '@/lib/supabase';

export type CallState = 'connecting' | 'ringing' | 'active' | 'ended' | 'failed';

export interface ActiveCall {
  mute(on: boolean): void;
  /** DTMF, for "press 1 for…" menus. */
  sendDigits(digits: string): void;
  hangUp(): void;
  /** Phones route audio; a browser has one output and this is a no-op there. */
  speakerSupported: boolean;
  setSpeaker(on: boolean): Promise<void>;
}

export interface StartCallInput {
  /** E.164. */
  to: string;
  /** Shown by CallKit on iOS as who is being called. */
  name?: string | null;
  customerId?: string | null;
  contactId?: string | null;
  /** Every state change, with a human-readable detail on 'failed'. */
  onState: (state: CallState, detail?: string) => void;
}

export type StartCallResult =
  | { ok: true; call: ActiveCall }
  | { ok: false; code?: string; message: string };

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

/**
 * A fresh Voice Access Token from `twilio-voice-token`. Shared by the web
 * and native implementations; a 503 `not_configured` here is the honest
 * "in-app calling is not set up yet" that the call screen shows.
 */
export async function fetchVoiceToken(): Promise<
  { ok: true; token: string; identity: string } | { ok: false; code?: string; message: string }
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
    const result = data as {
      ok?: boolean;
      token?: string;
      identity?: string;
      code?: string;
      error?: string;
    } | null;
    if (!result?.ok || !result.token) {
      return { ok: false, code: result?.code, message: result?.error ?? 'Could not start the call.' };
    }
    return { ok: true, token: result.token, identity: result.identity ?? '' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not start the call.' };
  }
}

/** Can THIS build place a call itself? Only web and native say yes. */
export function inAppCallingSupported(): boolean {
  return false;
}

export async function startInAppCall(_input: StartCallInput): Promise<StartCallResult> {
  return {
    ok: false,
    code: 'unsupported',
    message:
      'Calling straight from the app is not available on this device. The call rings your cell first, then connects them — they still see the DC Solar number.',
  };
}
