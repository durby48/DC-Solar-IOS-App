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

// NEVER add a runtime `./voice` import to a sibling: see lib/voiceToken.ts.
export { fetchVoiceToken } from './voiceToken';

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
