/**
 * Google and Apple sign-in — CUSTOMERS ONLY (2026-08-22, Workstream D3).
 *
 * WHO THIS IS FOR
 *
 * A new customer should be able to reach the portal with one tap instead of
 * waiting on a temporary password, and the App Store requires Sign in with
 * Apple wherever a third-party login is offered (guideline 4.8). Staff must
 * NOT come in this way: the crew app is gated by `employees.role`, staff
 * accounts carry TOTP, and a Google login would route around the password and
 * 6-digit code that protect the money screens. `mfa.ts` records the matching
 * decision — never layer TOTP on top of an OAuth login.
 *
 * The staff block is enforced in three places, in order of authority:
 *   1. `supabase/migrations/2026-08-22_oauth_staff_block.sql` — a BEFORE
 *      INSERT trigger on `auth.identities` (errcode 42501). Auto-linking a
 *      verified same-email account never touches `auth.users`, so this is the
 *      gate that actually fires for existing staff.
 *   2. The same migration's `handle_new_auth_user()`, for brand-new accounts.
 *   3. `refuseStaff()` below — belt and braces. If a staff session somehow
 *      gets created, we sign it straight back out.
 * Only (1) and (2) are security. (3) is here so a server misconfiguration
 * shows up as a clear message instead of a half-signed-in staff member.
 *
 * PLATFORMS
 *
 *   native  Google  → `@react-native-google-signin/google-signin` (dynamic
 *                     import, so the web bundle never evaluates it) → an
 *                     `idToken` → `supabase.auth.signInWithIdToken`.
 *   native  Apple   → `expo-apple-authentication` → `identityToken` → the
 *                     same call. Web-safe to import: with no native module
 *                     present it degrades to `isAvailableAsync() === false`.
 *   web     both    → `supabase.auth.signInWithOAuth`, a full-page redirect
 *                     back to `/`, where `detectSessionInUrl` (web-only, see
 *                     `supabase.ts`) consumes the fragment and `landingRoute()`
 *                     routes the new session.
 *
 * NOTHING IN HERE THROWS. Every export resolves to an `OAuthResult` so the
 * login screens can render one inline message and move on.
 */

import * as AppleAuthentication from 'expo-apple-authentication';
import { uuid } from 'expo-modules-core';
import { Platform } from 'react-native';

import { getAccountInfo } from '@/lib/account';
import { supabase } from '@/lib/supabase';

/**
 * `'cancelled'` is deliberately a third state rather than an error: the user
 * dismissing the Apple sheet is not a failure and must not paint red text.
 * The web redirect also reports `'cancelled'` — see `startWebOAuth`.
 */
export type OAuthResult = { ok: true } | { ok: 'cancelled' } | { ok: false; message: string };

// `EXPO_PUBLIC_*` is substituted at BUILD time, so these have to be written as
// complete static member expressions — `process.env[name]` would come back
// undefined in an export.
const GOOGLE_WEB_CLIENT_ID = (process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '').trim();
const GOOGLE_IOS_CLIENT_ID = (process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '').trim();

const STAFF_MESSAGE = 'Staff sign in with your email, password and 6-digit code.';
const NOT_CONFIGURED = 'Social sign-in is not set up yet. Use your email and password.';

/**
 * Whether to show the social buttons at all.
 *
 * The web client id is the one value both platforms need — Supabase verifies
 * every Google id token against it, native and web alike. Until Devon creates
 * the OAuth clients (owner action item #4) it is unset, and the buttons stay
 * hidden rather than shipping a control that always fails.
 */
export function socialLoginConfigured(): boolean {
  return GOOGLE_WEB_CLIENT_ID.length > 0;
}

/**
 * Whether the native "Sign in with Apple" button can be shown.
 *
 * iOS only, and only when the OS agrees (`isAvailableAsync()` is false on
 * iOS < 13 and on simulators without an Apple ID). Web has its own path —
 * `signInWithApple()` redirects there — so this deliberately answers `false`
 * for web; `AuthProviderButtons` handles that case with its own pill.
 */
export async function appleAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

type GoogleSigninModule = typeof import('@react-native-google-signin/google-signin');

let googleModule: GoogleSigninModule | null = null;
let googleConfigured = false;

/**
 * Load and configure the native Google module exactly once.
 *
 * Deliberately a dynamic `import()` behind a `Platform.OS !== 'web'` guard:
 * the module reaches for native view managers, and the web bundle has no
 * business evaluating it. `configure()` is idempotent but re-running it on
 * every tap resets the signed-in user on iOS, so it is latched.
 */
async function googleSignin(): Promise<GoogleSigninModule> {
  if (!googleModule) {
    googleModule = await import('@react-native-google-signin/google-signin');
  }
  if (!googleConfigured) {
    googleModule.GoogleSignin.configure({
      webClientId: GOOGLE_WEB_CLIENT_ID,
      // Omitted rather than passed empty: an empty string makes the iOS SDK
      // throw at configure time instead of falling back to the plist.
      ...(GOOGLE_IOS_CLIENT_ID ? { iosClientId: GOOGLE_IOS_CLIENT_ID } : {}),
      scopes: ['email', 'profile'],
    });
    googleConfigured = true;
  }
  return googleModule;
}

/**
 * Continue with Google.
 *
 * Native: the account picker returns an OpenID id token, which Supabase
 * verifies against the client ids configured on the project. No nonce is
 * passed — the library does not let us set one for the original (non-One-Tap)
 * flow, so the token carries no `nonce` claim and Supabase has nothing to
 * compare. Keep `external_google_skip_nonce_check` FALSE anyway; it only
 * matters for tokens that do carry one.
 */
export async function signInWithGoogle(): Promise<OAuthResult> {
  if (!socialLoginConfigured()) return { ok: false, message: NOT_CONFIGURED };
  if (Platform.OS === 'web') return startWebOAuth('google');

  try {
    const mod = await googleSignin();
    // Android-only, and a no-op on iOS — but calling it there logs a warning.
    if (Platform.OS === 'android') {
      await mod.GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    }

    const response = await mod.GoogleSignin.signIn();
    // v16 returns a tagged union rather than throwing on cancel.
    if (response.type !== 'success') return { ok: 'cancelled' };

    const token = response.data.idToken;
    if (!token) {
      return {
        ok: false,
        message: 'Google did not return a sign-in token. Try again, or use your email and password.',
      };
    }

    const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token });
    if (error) return { ok: false, message: describeAuthError(error, 'Google') };

    return (await refuseStaff()) ?? { ok: true };
  } catch (e) {
    if (isCancellation(e)) return { ok: 'cancelled' };
    return { ok: false, message: describeAuthError(e, 'Google') };
  }
}

// ---------------------------------------------------------------------------
// Apple
// ---------------------------------------------------------------------------

/**
 * Continue with Apple.
 *
 * NONCE: Apple copies whatever string we hand it into the `nonce` claim of the
 * identity token, unmodified. Supabase then accepts either the value we send
 * it or its SHA-256 hash. So we generate a random raw nonce, give Apple
 * SHA-256(raw), and give Supabase the raw — a token replayed from somewhere
 * else can't be made to match, and the raw value never leaves the device
 * except over TLS to Supabase.
 *
 * FULL NAME: Apple sends the name exactly ONCE, on the very first
 * authorisation, and never puts it in the token. If we don't copy it into user
 * metadata right now it is gone for good (short of the user revoking the app
 * in iOS Settings). Google needs none of this — its id token carries `name`
 * and GoTrue files it automatically.
 */
export async function signInWithApple(): Promise<OAuthResult> {
  if (Platform.OS === 'web') return startWebOAuth('apple');

  try {
    const rawNonce = randomNonce();
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: sha256Hex(rawNonce),
    });

    if (!credential.identityToken) {
      return {
        ok: false,
        message: 'Apple did not return a sign-in token. Try again, or use your email and password.',
      };
    }

    const { error } = await supabase.auth.signInWithIdToken({
      provider: 'apple',
      token: credential.identityToken,
      nonce: rawNonce,
    });
    if (error) return { ok: false, message: describeAuthError(error, 'Apple') };

    const refused = await refuseStaff();
    if (refused) return refused;

    // Only ever populated on the first authorisation; skip quietly otherwise.
    const fullName = formatAppleName(credential.fullName);
    if (fullName) {
      try {
        await supabase.auth.updateUser({ data: { full_name: fullName } });
      } catch {
        // A missing display name is cosmetic. Never fail a sign-in over it.
      }
    }

    return { ok: true };
  } catch (e) {
    if (isCancellation(e)) return { ok: 'cancelled' };
    return { ok: false, message: describeAuthError(e, 'Apple') };
  }
}

/** "Jane Q. Customer" from Apple's tokenised name object, or null. */
function formatAppleName(name: AppleAuthentication.AppleAuthenticationFullName | null): string | null {
  if (!name) return null;
  const parts = [name.givenName, name.middleName, name.familyName]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(' ') : null;
}

// ---------------------------------------------------------------------------
// Web
// ---------------------------------------------------------------------------

/**
 * Web: hand the browser to the provider and let it come back to `/`.
 *
 * Returns `'cancelled'` on success, which reads backwards until you see why:
 * supabase-js sets `window.location.href` and the page is already unloading.
 * "Cancelled" is the one result whose contract is *do nothing* — anything else
 * would have the caller navigate or paint an error over a page that is on its
 * way out. The real outcome lands on the next load of `/`, where
 * `detectSessionInUrl` creates the session and `landingRoute()` routes it.
 *
 * `redirectTo` must be in the project's `uri_allow_list` (Workstream D1 set it
 * to app.dcsolarkc.com plus the localhost dev ports) or GoTrue silently sends
 * people to `site_url` instead.
 */
async function startWebOAuth(provider: 'google' | 'apple'): Promise<OAuthResult> {
  try {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: `${origin}/` },
    });
    if (error) {
      return { ok: false, message: describeAuthError(error, provider === 'google' ? 'Google' : 'Apple') };
    }
    return { ok: 'cancelled' };
  } catch (e) {
    return { ok: false, message: describeAuthError(e, provider === 'google' ? 'Google' : 'Apple') };
  }
}

// ---------------------------------------------------------------------------
// Staff guard + error mapping
// ---------------------------------------------------------------------------

/**
 * Defence in depth: if a social sign-in somehow produced a STAFF session, end
 * it. Returns the refusal, or null when the session is fine to keep.
 *
 * `getAccountInfo()` answers `'unknown'` rather than `'employee'` when the
 * lookup fails (offline, RLS hiccup), and we let `'unknown'` through on
 * purpose — the server-side triggers are the real gate, and signing a
 * legitimate customer out over a flaky connection would be the worse bug.
 */
async function refuseStaff(): Promise<OAuthResult | null> {
  try {
    const account = await getAccountInfo();
    if (account.kind !== 'employee') return null;
    await supabase.auth.signOut();
  } catch {
    // Could not check, or could not sign out. The triggers already refused
    // staff server-side; do not strand a customer here.
    return null;
  }
  return { ok: false, message: STAFF_MESSAGE };
}

/** Everything an error might be hiding a useful string in, flattened. */
function errorText(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  const e = error as {
    message?: unknown;
    code?: unknown;
    error_description?: unknown;
    status?: unknown;
  };
  return [e.message, e.code, e.error_description, e.status]
    .filter((part) => typeof part === 'string' || typeof part === 'number')
    .join(' | ');
}

/**
 * Turn a provider or Supabase failure into one sentence a customer can act on.
 *
 * The staff gates raise with errcode 42501 and the text "Staff accounts sign in
 * with a password and a 6-digit code". GoTrue usually relays that verbatim, but
 * it sometimes flattens a trigger exception into a bare "Database error…".
 * Since those triggers are the ONLY thing that raises on this path, the
 * fallback names both possibilities rather than guessing wrong in either
 * direction.
 */
function describeAuthError(error: unknown, provider: string): string {
  const text = errorText(error);
  const lower = text.toLowerCase();

  if (lower.includes('6-digit code') || lower.includes('42501')) return STAFF_MESSAGE;

  if (lower.includes('database error') || lower.includes('unexpected_failure')) {
    return `${provider} sign-in could not complete. If you work at DC Solar, sign in with your email, password and 6-digit code instead.`;
  }

  if (lower.includes('network') || lower.includes('fetch')) {
    return 'Could not reach the server. Check your connection and try again.';
  }

  const message = typeof (error as { message?: unknown })?.message === 'string'
    ? ((error as { message: string }).message)
    : '';
  return message || `Could not sign in with ${provider}. Try again, or use your email and password.`;
}

/**
 * Did the user just back out?
 *
 * `-5` / `12501` are google-signin's SIGN_IN_CANCELLED on iOS / Android;
 * `ERR_REQUEST_CANCELED` is what `expo-apple-authentication` rejects with when
 * the sheet is dismissed. Compared as strings because the native modules hand
 * back a `code` property, not a typed enum.
 */
function isCancellation(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (typeof code !== 'string' && typeof code !== 'number') return false;
  return ['-5', '12501', 'SIGN_IN_CANCELLED', 'ERR_REQUEST_CANCELED', 'ERR_CANCELED'].includes(
    String(code),
  );
}

// ---------------------------------------------------------------------------
// Nonce + SHA-256
// ---------------------------------------------------------------------------

/**
 * A random 256-bit nonce, hex encoded.
 *
 * There is no `globalThis.crypto` on native: Hermes ships none, React Native's
 * `setUpGlobals` installs none, and Expo's WinterCG runtime installs
 * TextDecoder/URL/fetch but not WebCrypto. `expo-crypto` is not a dependency of
 * this app. So the order is:
 *
 *   1. `crypto.getRandomValues` — web, and any future native polyfill.
 *   2. `expo-modules-core`'s `uuid.v4()` — backed by the platform's own
 *      generator (`UUID()` on iOS, `crypto.randomUUID()` on web), which is
 *      exactly the CSPRNG we want. Two of them, so the nonce keeps its full
 *      width.
 *   3. `Math.random` — last resort, so a sign-in never hard-fails over
 *      entropy. Weak, and knowingly so: the nonce only has to be unpredictable
 *      to an attacker replaying an Apple token, and options 1 and 2 cover
 *      every platform this app actually ships on.
 */
function randomNonce(): string {
  const bytes = new Uint8Array(32);
  const webCrypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => void } })
    .crypto;

  if (typeof webCrypto?.getRandomValues === 'function') {
    webCrypto.getRandomValues(bytes);
    return toHex(bytes);
  }

  try {
    const hex = `${uuid.v4()}${uuid.v4()}`.replace(/-/g, '');
    if (hex.length >= 64) return hex.slice(0, 64);
  } catch {
    // fall through
  }

  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return toHex(bytes);
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** UTF-8 encode without depending on `TextEncoder` being present. */
function utf8Bytes(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    let code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i += 1;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * SHA-256, hex encoded — a hand-rolled implementation on purpose.
 *
 * Apple's nonce has to be hashed on the device before the sheet opens, and
 * `crypto.subtle` (a) does not exist on native, see `randomNonce`, and (b) is
 * async and only present in secure contexts on the web. ~40 lines of FIPS
 * 180-4 costs less than a native dependency that would have to ride an EAS
 * build, and it behaves identically on both platforms. Checked against the
 * standard vectors: "" and "abc".
 */
function sha256Hex(message: string): string {
  const input = utf8Bytes(message);
  const bitLength = input.length * 8;
  const padded = new Uint8Array((((input.length + 9 + 63) / 64) | 0) * 64);
  padded.set(input);
  padded[input.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + s1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (s0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  let out = '';
  for (let i = 0; i < h.length; i += 1) out += h[i].toString(16).padStart(8, '0');
  return out;
}
