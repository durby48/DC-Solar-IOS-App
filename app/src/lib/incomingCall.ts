/**
 * The incoming call that was just answered, handed from the native voice
 * module to the `/call` screen (2026-09-08).
 *
 * CallKit answers the call natively (lock screen, banner, the green button)
 * before any of our screens exist; by the time `/call` mounts, the audio is
 * already flowing. So the voice module parks the live call here and pushes
 * the screen, and the screen picks it up with `takeIncomingCall()`. No
 * platform variants (see lib/voiceToken.ts for why that matters).
 */

import type { ActiveCall, CallState } from '@/lib/voice';

export interface IncomingCallSession {
  call: ActiveCall;
  /** What CallKit showed: the customer's name when we knew it, else the number. */
  name: string;
  /** E.164 of the caller. */
  phone: string;
  customerId: string | null;
  leadId: string | null;
  contactId: string | null;
  /** The last state the SDK reported; 'active' the moment it was answered. */
  state: CallState;
  detail: string | null;
  subscribe(listener: (state: CallState, detail?: string) => void): () => void;
}

let current: IncomingCallSession | null = null;

export function setIncomingCall(session: IncomingCallSession | null): void {
  current = session;
}

/** The answered call waiting for a screen, if any. Does not clear it. */
export function peekIncomingCall(): IncomingCallSession | null {
  return current;
}

/** Hand the call to the screen that will own it. */
export function takeIncomingCall(): IncomingCallSession | null {
  const session = current;
  current = null;
  return session;
}
