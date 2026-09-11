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
 */

import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';
const MAX_KEYS = 12;
const MAX_VALUE = 300;

export type DiagnosticKind =
  | 'voice_register'
  | 'voice_unregister'
  | 'voice_invite'
  | 'notification_tap'
  | 'js_error';

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
  if (Platform.OS === 'web') return;
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
