import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { fetchCallStatus } from '@/lib/comms';
import type { IncomingCallSession } from '@/lib/incomingCall';
import { playRingbackTone } from '@/lib/ringback';
import { startInAppCall, type ActiveCall, type CallState } from '@/lib/voice';

/**
 * The live call, owned by the app rather than by the `/call` screen
 * (2026-10-09, Carson: "full screen but you can leave it and come back with
 * the button in the bottom right").
 *
 * Until now the call lived inside `/call` and hung up when that screen went
 * away. Here it lives in this module: `/call` only SHOWS it, and can be left
 * mid-call — the bottom-right button (components/KeypadFab) turns green with
 * the timer and brings it back. Everything that must keep running while no
 * screen is watching runs here: the 30-second setup watchdog, the web
 * ringback tone, the phone's "did they pick up" poll and the "why did it
 * end" lookup.
 *
 * One call at a time. A second `startCall` while one is live returns the live
 * one (and the strict-mode double mount of `/call` lands here harmlessly).
 */

export type SessionState = CallState | 'starting';

export interface CallSession {
  id: number;
  to: string;
  name: string;
  customerId: string | null;
  contactId: string | null;
  incoming: boolean;
  state: SessionState;
  detail: string | null;
  /** When they answered (the timer's zero); null until then. */
  startedAt: number | null;
  /** Length of the call once it is over. */
  endedSeconds: number | null;
  muted: boolean;
  speaker: boolean;
  speakerSupported: boolean;
}

/** How long a call may sit at "Calling…" with no proof of life. */
const CALL_SETUP_TIMEOUT_MS = 30_000;

let current: CallSession | null = null;
let call: ActiveCall | null = null;
let nextId = 1;
const listeners = new Set<() => void>();
/** Per-call cleanups (timers, tone, poll), run when the call is over. */
let cleanups: (() => void)[] = [];
let stopTone: (() => void) | null = null;

function emit() {
  for (const l of listeners) l();
}

function patch(id: number, next: Partial<CallSession>) {
  if (!current || current.id !== id) return;
  current = { ...current, ...next };
  emit();
}

export function isLive(s: CallSession | null): boolean {
  return s !== null && (s.state === 'starting' || s.state === 'connecting' || s.state === 'ringing' || s.state === 'active');
}

export function getCallSession(): CallSession | null {
  return current;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useCallSession(): CallSession | null {
  return useSyncExternalStore(subscribe, getCallSession, getCallSession);
}

function runCleanups() {
  for (const c of cleanups) c();
  cleanups = [];
  stopTone?.();
  stopTone = null;
}

/** Apply a state reported by the SDK, with everything that follows from it. */
function onState(id: number, next: CallState, info?: string) {
  if (!current || current.id !== id) return;
  const s = current;
  const update: Partial<CallSession> = { state: next, detail: info ?? null };
  if (next === 'active' && s.startedAt === null) update.startedAt = Date.now();
  if ((next === 'ended' || next === 'failed') && s.startedAt !== null) {
    update.endedSeconds = Math.round((Date.now() - s.startedAt) / 1000);
  }
  // Ringback while dialing / ringing (web only; a no-op on the phone).
  if (next === 'connecting' || next === 'ringing') {
    if (!stopTone) stopTone = playRingbackTone();
  } else {
    stopTone?.();
    stopTone = null;
  }
  patch(id, update);
  if (next === 'ended' || next === 'failed') {
    const sid = call?.sid ?? null;
    const neverConnected = s.startedAt === null && !s.incoming;
    runCleanups();
    call = null;
    if (next === 'ended' && neverConnected && Platform.OS !== 'web' && sid) explainEnd(id, sid);
  } else if (next === 'ringing' && s.state !== 'ringing' && Platform.OS !== 'web' && !s.incoming) {
    watchForAnswer(id);
  }
}

/**
 * PHONE, OUTGOING: our leg is answered by Twilio before the other person
 * picks up (that is how the ringback gets to us), so the SDK cannot tell us
 * when they actually answer. The far leg's `answered` callback moves the
 * messages row to in-progress; poll it while ringing and promote to 'active'.
 */
function watchForAnswer(id: number) {
  let stopped = false;
  const tick = async () => {
    const sid = call?.sid;
    if (!sid || stopped) return;
    const status = await fetchCallStatus(sid);
    if (stopped || !current || current.id !== id || current.state !== 'ringing') return;
    if (status === 'in-progress') {
      stopped = true;
      patch(id, { state: 'active', startedAt: Date.now() });
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 2000);
  cleanups.push(() => {
    stopped = true;
    clearInterval(timer);
  });
}

/** Ended without ever connecting: say why, from the row's final status. */
function explainEnd(id: number, sid: string) {
  // The far leg's completed callback can land a moment after our leg ends.
  setTimeout(() => {
    void fetchCallStatus(sid).then((status) => {
      const detail =
        status === 'no-answer'
          ? 'No answer.'
          : status === 'busy'
            ? 'Line busy.'
            : status === 'failed' || status === 'canceled'
              ? 'The call could not be completed.'
              : null;
      if (detail) patch(id, { detail });
    });
  }, 1500);
}

export interface StartCallParams {
  to: string;
  name: string;
  customerId: string | null;
  contactId: string | null;
}

/** Place a call (or hand back the one already live). */
export function startCall(input: StartCallParams): CallSession {
  if (isLive(current)) return current as CallSession;
  runCleanups();
  call = null;
  const id = nextId++;
  current = {
    id,
    ...input,
    incoming: false,
    state: 'starting',
    detail: null,
    startedAt: null,
    endedSeconds: null,
    muted: false,
    speaker: false,
    speakerSupported: false,
  };
  emit();

  if (!input.to) {
    patch(id, { state: 'failed', detail: 'No number to dial.' });
    return current;
  }

  // A hung WebRTC/SDK handshake never fires an event at all; without this a
  // person is left at "Calling…" forever with no way to the bridge.
  const watchdog = setTimeout(() => {
    if (!current || current.id !== id || (current.state !== 'starting' && current.state !== 'connecting')) return;
    call?.hangUp();
    onState(id, 'failed', 'Taking too long to connect. Check your connection and try again, or ring their cell directly.');
  }, CALL_SETUP_TIMEOUT_MS);
  cleanups.push(() => clearTimeout(watchdog));

  void (async () => {
    const result = await startInAppCall({
      to: input.to,
      name: input.name,
      customerId: input.customerId,
      contactId: input.contactId,
      onState: (next, info) => {
        // 'connecting' alone is not proof of life; ringing / active / over is.
        if (next !== 'connecting') clearTimeout(watchdog);
        onState(id, next, info);
      },
    });
    if (!current || current.id !== id) {
      if (result.ok) result.call.hangUp();
      return;
    }
    if (result.ok) {
      // Hung up (or timed out) while the SDK was still starting.
      if (current.state === 'failed' || current.state === 'ended') {
        result.call.hangUp();
        return;
      }
      call = result.call;
      patch(id, { speakerSupported: result.call.speakerSupported });
    } else {
      clearTimeout(watchdog);
      onState(id, 'failed', result.message);
    }
  })();
  return current;
}

/** An incoming call CallKit already answered: adopt it and follow its state. */
export function adoptIncomingCall(incoming: IncomingCallSession): CallSession {
  runCleanups();
  const id = nextId++;
  call = incoming.call;
  current = {
    id,
    to: incoming.phone,
    name: incoming.name,
    customerId: incoming.customerId,
    contactId: incoming.contactId,
    incoming: true,
    state: incoming.state,
    detail: incoming.detail,
    startedAt: Date.now(),
    endedSeconds: null,
    muted: false,
    speaker: false,
    speakerSupported: incoming.call.speakerSupported,
  };
  emit();
  const unsubscribe = incoming.subscribe((next, info) => onState(id, next, info));
  cleanups.push(unsubscribe);
  return current;
}

export function hangUpCall(): void {
  const s = current;
  if (!s) return;
  call?.hangUp();
  if (isLive(s)) onState(s.id, 'ended');
}

export function muteCall(on: boolean): void {
  call?.mute(on);
  if (current) patch(current.id, { muted: on });
}

export function setCallSpeaker(on: boolean): void {
  if (current) patch(current.id, { speaker: on });
  void call?.setSpeaker(on);
}

export function sendCallDigits(digits: string): void {
  call?.sendDigits(digits);
}

/** Forget a call that is over (the person left its "Call ended" screen). */
export function dismissCallSession(id: number): void {
  if (!current || current.id !== id || isLive(current)) return;
  current = null;
  emit();
}
