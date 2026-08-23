/**
 * Sign out and land on the login screen — from ANY screen, reliably.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THE OLD `await signOut(); router.replace('/')` DID NOTHING (2026-08-23)
 * ──────────────────────────────────────────────────────────────────────────
 * `/` is claimed by two route files: `app/index.tsx` (login) and
 * `app/(tabs)/index.tsx` (Home). `router.replace('/')` issued from INSIDE the
 * tabs resolves to the Home tab, so the session was ended but the screen never
 * changed — the button looked dead. The tabs gate had already hit the same
 * thing (see `(tabs)/_layout.tsx`) and fixed it with `navigation.reset()` on
 * the ROOT stack, naming the `index` ROUTE rather than the `/` URL. This does
 * the same, walking up from whatever navigator the caller is in.
 *
 * Two more things that could leave the button looking dead are handled here:
 *
 *   - `supabase.auth.signOut()` can hang on web (auth lock held elsewhere) or
 *     wait a long time offline for the `/logout` round-trip. It is raced
 *     against a short timeout; either way the LOCAL session is dropped and we
 *     navigate. The server token simply expires on its own if the revoke
 *     never reached it.
 *   - Cached role/account info would otherwise survive into the next sign-in.
 */

import { clearRoleCache } from '@/lib/role';
import { supabase } from '@/lib/supabase';

const SIGN_OUT_TIMEOUT_MS = 4000;

/** The slice of a React Navigation `navigation` object this needs. */
export interface Resettable {
  getParent(): Resettable | undefined;
  getState(): { routeNames?: readonly string[] } | undefined;
  // `never` matches React Navigation's typed `reset()` — route names are
  // typed per-navigator and this is generic over all of them.
  reset(state: { index: number; routes: { name: never }[] }): void;
}

/**
 * The app's root `Stack` from `app/_layout.tsx` — the HIGHEST navigator that
 * owns an `index` route.
 *
 * Not simply the topmost: expo-router wraps the app in a hidden outer stack
 * (`__root`, `_sitemap`, `+not-found`) which has no `index`, and a RESET sent
 * there is "not handled by any navigator" — a silent no-op that is exactly
 * what the sign-out button did before this existed. And not simply the
 * nearest: inside the tabs the nearest navigator is the tab bar, whose own
 * `index` is the HOME tab.
 */
function rootOf(navigation: Resettable): Resettable {
  let best = navigation;
  for (let nav: Resettable | undefined = navigation; nav; nav = nav.getParent()) {
    if (nav.getState()?.routeNames?.includes('index')) best = nav;
  }
  return best;
}

/** Reset the ROOT stack to the login route. Idempotent. */
export function resetToLogin(navigation: Resettable): void {
  rootOf(navigation).reset({ index: 0, routes: [{ name: 'index' as never }] });
}

/** End the session locally and remotely, never hanging the caller. */
export async function endSession(): Promise<void> {
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, SIGN_OUT_TIMEOUT_MS));
  try {
    // Global revoke first; if it stalls, the local-scope call below is
    // storage-only and cannot.
    await Promise.race([supabase.auth.signOut().then(() => undefined), timeout]);
  } catch {
    // Signed out already, or no session to end — the destination is the same.
  }
  try {
    await Promise.race([supabase.auth.signOut({ scope: 'local' }).then(() => undefined), timeout]);
  } catch {
    // Same.
  }
  clearRoleCache();
}

/** The whole thing: sign out, drop caches, land on the login screen. */
export async function signOutAndLeave(navigation: Resettable): Promise<void> {
  await endSession();
  resetToLogin(navigation);
}
