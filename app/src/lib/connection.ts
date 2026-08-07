import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';

/**
 * Connectivity watcher (2026-08-06).
 *
 * `@react-native-community/netinfo` is NOT installed and adding it would be a
 * native dependency — a full App Store build instead of an OTA update. So this
 * measures the only thing that actually matters anyway: can we reach OUR
 * server, and how fast? A phone can hold four bars of LTE and still fail to
 * reach Supabase.
 *
 * Three states:
 *   online   — reachable, promptly
 *   slow     — reachable but crawling; saves will be sluggish and may time out
 *   offline  — unreachable; nothing you change is getting to the office
 *
 * Polls the auth health endpoint, which is unauthenticated and tiny. Interval
 * backs off when healthy and tightens when not, so recovery is noticed fast
 * without holding the radio open needlessly.
 */

export type ConnectionState = 'online' | 'slow' | 'offline';

const HEALTH_URL = `${process.env.EXPO_PUBLIC_SUPABASE_URL ?? ''}/auth/v1/health`;
// The health endpoint answers 401 without a key. Any response proves we can
// reach the server, so the probe would work regardless — but sending the
// (client-safe) publishable key keeps the auth logs clean and returns a 200.
const HEALTH_HEADERS = { apikey: process.env.EXPO_PUBLIC_SUPABASE_KEY ?? '' };
/** Above this, the connection is technically up but painful to use. */
const SLOW_MS = 3500;
const TIMEOUT_MS = 8000;
const POLL_OK_MS = 20_000;
const POLL_BAD_MS = 6000;

let current: ConnectionState = 'online';
const listeners = new Set<(state: ConnectionState) => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function set(next: ConnectionState) {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener(next);
}

async function probe(): Promise<ConnectionState> {
  // The browser knows for certain when the machine has no network at all.
  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'offline';
  }
  if (!HEALTH_URL.startsWith('http')) return 'online'; // misconfigured env: don't cry wolf
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started_at = Date.now();
  try {
    await fetch(HEALTH_URL, {
      method: 'GET',
      headers: HEALTH_HEADERS,
      signal: controller.signal,
      cache: 'no-store',
    });
    return Date.now() - started_at > SLOW_MS ? 'slow' : 'online';
  } catch {
    return 'offline';
  } finally {
    clearTimeout(abort);
  }
}

function schedule(delay: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(run, delay);
}

async function run() {
  const state = await probe();
  set(state);
  schedule(state === 'online' ? POLL_OK_MS : POLL_BAD_MS);
}

/** Start polling once per app, not once per subscriber. */
function start() {
  if (started) return;
  started = true;
  run();

  // Re-check the moment the app comes back to the foreground — the usual way
  // a crew member finds out they've driven back into coverage.
  AppState.addEventListener('change', (next) => {
    if (next === 'active') run();
  });

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.addEventListener('online', () => run());
    window.addEventListener('offline', () => set('offline'));
  }
}

/** Subscribe to connection state. Starts the watcher on first use. */
export function useConnection(): ConnectionState {
  const [state, setState] = useState<ConnectionState>(current);
  useEffect(() => {
    start();
    listeners.add(setState);
    setState(current);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}

/** Force an immediate re-check (e.g. the banner's Retry button). */
export function recheckConnection() {
  run();
}
