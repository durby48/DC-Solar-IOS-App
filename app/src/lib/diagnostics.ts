/**
 * Client diagnostics — the phone's side of "why did that not work?"
 * (2026-09-08). Writes one small row to `client_diagnostics` per event so a
 * failure on Devon's iPhone can be read from a desk: voice registration
 * outcomes, incoming-call invites, notification taps and JS crashes.
 *
 * RULES, enforced here and not just hoped for:
 *   - never a token, secret, message body or customer record; `detail` is
 *     a flat object of short strings/numbers/booleans, clipped to 300 chars
 *     per value and 12 keys;
 *   - never throws and never awaits in the caller's way — fire and forget;
 *   - in development it also prints to the console with a `[diag]` tag so
 *     the same event is visible in Metro.
 *
 * No platform variants, no runtime import of any `lib/voice*` file.
 *
 * Phone reports (Developer Tools, 2026-10-08) read these rows: `app_open`
 * once per launch (which version/update the device runs), `js_error` for
 * uncaught errors too (not only the error screen), and `request_error` for a
 * failed request (path + status only). The web app reports as well, except
 * in development. Nothing is written while a developer is viewing as someone.
 */

import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';

import { getViewAsPerson } from '@/lib/devViewState';
import { setRequestProblemHook, supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';
const MAX_KEYS = 12;
const MAX_VALUE = 300;

export type DiagnosticKind =
  | 'voice_register'
  | 'voice_unregister'
  | 'voice_invite'
  | 'notification_tap'
  | 'js_error'
  | 'app_open'
  | 'request_error';

type Scalar = string | number | boolean | null | undefined;

function clip(value: Scalar): string | number | boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE - 1)}…` : value;
  return value;
}

/** "1.4.2 (30)" — the store version and the native build number. */
export function appVersionLabel(): string {
  const version = Constants.expoConfig?.version ?? '?';
  // `Constants.nativeBuildVersion` is deprecated in SDK 57 and came back
  // empty on build 30 (every row read "1.0.0 (?)"). expo-application is in
  // node_modules transitively; guarded because a build that did not link it
  // would throw on the require.
  let build: string | null = null;
  try {
    // deno-lint-ignore no-explicit-any
    build = (require('expo-application') as { nativeBuildVersion?: string | null }).nativeBuildVersion ?? null;
  } catch {
    build = null;
  }
  return `${version} (${build ?? Constants.nativeBuildVersion ?? '?'})`;
}

/** "3 · 932156b5" — runtime + the first 8 chars of the running OTA update. */
export function runtimeLabel(): string {
  try {
    const runtime = Updates.runtimeVersion ?? '?';
    const update = Updates.updateId ? Updates.updateId.slice(0, 8) : 'embedded';
    return `${runtime} · ${update}`;
  } catch {
    return '?';
  }
}

export function reportDiagnostic(kind: DiagnosticKind, ok: boolean | null, detail: Record<string, Scalar> = {}): void {
  const clean: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(detail).slice(0, MAX_KEYS)) clean[key] = clip(value);
  if (__DEV__) {
    console.log(`[diag] ${kind} ${ok === null ? '' : ok ? 'ok' : 'FAIL'}`, clean);
  }
  if (Platform.OS === 'web' && __DEV__) return;
  if (getViewAsPerson()) return;
  void (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const email = data.session?.user?.email;
      if (!email) return;
      await supabase.from('client_diagnostics').insert({
        company: COMPANY,
        email: email.toLowerCase(),
        kind,
        ok,
        detail: clean,
        app_version: appVersionLabel(),
        runtime: runtimeLabel(),
        platform: Platform.OS,
      });
    } catch {
      // Diagnostics must never become the problem.
    }
  })();
}

let appOpenSent = false;

/** One `app_open` per launch — as soon as somebody is signed in. */
export function reportAppOpen(): void {
  const send = () => {
    if (appOpenSent) return;
    appOpenSent = true;
    reportDiagnostic('app_open', true, { os: String(Platform.Version ?? '') });
  };
  void supabase.auth.getSession().then(({ data }) => {
    if (data.session) send();
  });
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_IN') send();
  });
}

let captureInstalled = false;
let problemsThisLaunch = 0;
const lastByKey = new Map<string, number>();

/** At most one row per kind+place a minute, and 25 a launch. */
function throttled(key: string): boolean {
  const now = Date.now();
  if (problemsThisLaunch >= 25) return true;
  const last = lastByKey.get(key) ?? 0;
  if (now - last < 60_000) return true;
  lastByKey.set(key, now);
  problemsThisLaunch += 1;
  return false;
}

/**
 * Uncaught JS errors (native global handler / web window events) and failed
 * requests, into client_diagnostics. Installed once from the root layout.
 */
export function installProblemCapture(): void {
  if (captureInstalled) return;
  captureInstalled = true;

  setRequestProblemHook(({ path, method, status }) => {
    if (throttled(`req:${method}:${path}`)) return;
    reportDiagnostic('request_error', false, { path, method, status });
  });

  const record = (message: string, stack: string, fatal: boolean | null) => {
    if (throttled(`js:${message.slice(0, 80)}`)) return;
    reportDiagnostic('js_error', false, {
      message,
      stack: stack.split('\n').slice(0, 6).join(' | '),
      fatal,
      uncaught: true,
    });
  };

  if (Platform.OS === 'web') {
    if (typeof window === 'undefined') return;
    window.addEventListener('error', (e) => {
      record(String(e.message ?? 'error'), String((e.error as Error | undefined)?.stack ?? ''), null);
    });
    window.addEventListener('unhandledrejection', (e) => {
      const reason = e.reason as Error | string | undefined;
      record(
        typeof reason === 'string' ? reason : String(reason?.message ?? 'unhandled rejection'),
        typeof reason === 'string' ? '' : String(reason?.stack ?? ''),
        null,
      );
    });
    return;
  }

  type Handler = (error: Error, isFatal?: boolean) => void;
  const errorUtils = (globalThis as { ErrorUtils?: { getGlobalHandler(): Handler; setGlobalHandler(h: Handler): void } })
    .ErrorUtils;
  if (!errorUtils) return;
  const previous = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    try {
      record(String(error?.message ?? error), String(error?.stack ?? ''), Boolean(isFatal));
    } catch {
      // fall through to the default handler
    }
    previous?.(error, isFatal);
  });
}
