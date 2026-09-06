/**
 * In-app calling — NATIVE side of the platform split.
 *
 * `lib/voice.web.ts` is the real implementation: the Twilio Voice JS SDK
 * places the call from the browser, from the DC Solar number, with the
 * computer's mic and speakers. Metro picks that file on web and this one on
 * iOS/Android.
 *
 * On the phone there is no WebRTC without a native module, and the Twilio
 * React Native SDK is Phase 4 (a full App Store build — see HANDOFF for the
 * spike verdict). Until then this file says so, and every call button falls
 * back to the bridge (`placeBridgeCall`: Twilio rings your cell, then
 * connects them, and they still see the DC Solar number).
 *
 * The two files export the SAME API so no screen has to know which it got.
 */

export type CallState = 'connecting' | 'ringing' | 'active' | 'ended' | 'failed';

export interface ActiveCall {
  mute(on: boolean): void;
  /** DTMF, for "press 1 for…" menus. */
  sendDigits(digits: string): void;
  hangUp(): void;
}

export interface StartCallInput {
  /** E.164. */
  to: string;
  customerId?: string | null;
  contactId?: string | null;
  /** Every state change, with a human-readable detail on 'failed'. */
  onState: (state: CallState, detail?: string) => void;
}

export type StartCallResult =
  | { ok: true; call: ActiveCall }
  | { ok: false; code?: string; message: string };

/** Can THIS build place a call itself? Native: not until Phase 4. */
export function inAppCallingSupported(): boolean {
  return false;
}

export async function startInAppCall(_input: StartCallInput): Promise<StartCallResult> {
  return {
    ok: false,
    code: 'unsupported',
    message:
      'Calling straight from the app arrives with the next App Store build. For now the call rings your cell first, then connects them — they still see the DC Solar number.',
  };
}
