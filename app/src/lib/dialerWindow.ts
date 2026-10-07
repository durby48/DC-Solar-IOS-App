import { useEffect, useSyncExternalStore } from 'react';

import { supabase } from '@/lib/supabase';

/**
 * The keypad WINDOW (2026-10-09, Carson): the bottom-right button opens a
 * window over whatever screen you are on — Keypad and Recents tabs — instead
 * of a new screen. This module is its open/closed state, so anything can
 * open it (Recent calls → an unknown caller opens the Keypad tab with their
 * number filled in), plus the missed-call badge on the button.
 *
 * MISSED = an incoming call that did not connect, after `calls_seen_at` (when
 * you last looked at Recents; 2026-10-09_calls_seen.sql). RLS already limits
 * a rep to the calls on their own line.
 */

export type DialerTab = 'keypad' | 'recents';

export interface DialerState {
  open: boolean;
  tab: DialerTab;
  /** A number to put in the keypad, with a counter so the same number twice still applies. */
  preset: { phone: string; n: number } | null;
  missed: number;
  /** A message thread fills the phone screen: the button steps aside. */
  hidden: boolean;
  /** Extra height to sit above something along the bottom (the Lead map's pin card). */
  lift: number;
}

const COMPANY = 'dc-solar';
const MISSED_STATUSES = ['failed', 'busy', 'no-answer', 'canceled'];

let state: DialerState = { open: false, tab: 'keypad', preset: null, missed: 0, hidden: false, lift: 0 };
let presetN = 0;
const listeners = new Set<() => void>();

function set(next: Partial<DialerState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useDialerWindow(): DialerState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** Open the window; Recents first when there are missed calls, unless a tab is asked for. */
export function openDialer(opts: { tab?: DialerTab; phone?: string } = {}): void {
  const preset = opts.phone ? { phone: opts.phone, n: ++presetN } : state.preset;
  set({ open: true, tab: opts.tab ?? (opts.phone ? 'keypad' : state.missed > 0 ? 'recents' : 'keypad'), preset });
}

export function closeDialer(): void {
  set({ open: false });
}

export function setDialerTab(tab: DialerTab): void {
  set({ tab });
}

/**
 * Hide the keypad button while `active` (2026-10-09, Carson: "remove it only
 * when you are inside a CRM message thread" — it would sit on the composer).
 */
let hiders = 0;
export function useHideKeypadButton(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    hiders += 1;
    set({ hidden: true });
    return () => {
      hiders -= 1;
      set({ hidden: hiders > 0 });
    };
  }, [active]);
}

/** Lift the keypad button by `px` while this is mounted (0 = no lift). */
export function useKeypadLift(px: number): void {
  useEffect(() => {
    if (px <= 0) return;
    set({ lift: px });
    return () => set({ lift: 0 });
  }, [px]);
}

async function myEmail(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.email?.toLowerCase() ?? null;
}

/** Re-count missed calls since the person last looked. */
export async function refreshMissedCalls(): Promise<void> {
  try {
    const email = await myEmail();
    if (!email) return;
    const { data } = await supabase
      .from('staff_profiles')
      .select('calls_seen_at')
      .eq('company', COMPANY)
      .eq('email', email)
      .maybeSingle();
    const seen = (data as { calls_seen_at?: string | null } | null)?.calls_seen_at;
    // No profile row yet: only today's calls count.
    const since = seen ?? new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const { count } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('company', COMPANY)
      .eq('channel', 'call')
      .eq('direction', 'in')
      .in('status', MISSED_STATUSES)
      .gt('created_at', since);
    if (typeof count === 'number' && count !== state.missed) set({ missed: count });
  } catch {
    // The badge is a nicety; a failed count leaves the last one.
  }
}

/** The person is looking at Recents: clear the badge. */
export async function markCallsSeen(): Promise<void> {
  if (state.missed !== 0) set({ missed: 0 });
  try {
    const email = await myEmail();
    if (!email) return;
    await supabase
      .from('staff_profiles')
      .upsert({ company: COMPANY, email, calls_seen_at: new Date().toISOString() }, { onConflict: 'company,email' });
  } catch {
    // Next look tries again.
  }
}
