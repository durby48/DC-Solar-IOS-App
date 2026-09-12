/**
 * The admin door (2026-09-12 overhaul).
 *
 * Every person sees the SAME layout — the same five hubs, the same tiles,
 * the same menu rows. What differs is what happens on the tap: an admin-only
 * destination tells a crew member, in one sentence, that they need their
 * administrator, and goes nowhere. Two places enforce it:
 *
 *   1. `explainAdminOnly()` — called by Home / Menu / hub screens instead of
 *      navigating when `isLockedFor(item, isAdmin)`.
 *   2. `useAdminOnlyScreen()` — mounted by every admin-only SCREEN, so a deep
 *      link, a notification tap or a typed URL gets the same alert and is
 *      sent back to Home instead of rendering an empty admin screen.
 *
 * Neither is a security boundary. RLS is: a crew member's queries return
 * nothing they may not see whatever screen they are on. This is the polite
 * front door, not the lock.
 *
 * "Unknown" role (a session with no employees row, or the lookup failed) is
 * treated as NOT admin here — this is a UI courtesy, so failing closed costs
 * nothing — while `(tabs)/_layout.tsx` keeps failing OPEN for the tab shell
 * itself, so a crew member in a dead zone can still clock in.
 */

import { router, useNavigation } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Alert, Platform } from 'react-native';

import { type HubGate } from '@/lib/hub';
import { useRoleGate } from '@/lib/role';

export const ADMIN_ONLY_TITLE = 'Admin access needed';
export const ADMIN_ONLY_MESSAGE =
  'This part of the app is for administrators. Contact your administrator if you need access.';

/** True when this entry is an admin door and this person is not an admin. */
export function isLockedFor(gate: HubGate, isAdmin: boolean): boolean {
  return gate === 'admin' && !isAdmin;
}

/** The one alert. `Alert.alert` is a no-op on react-native-web, hence the split. */
export function explainAdminOnly(): void {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined' && typeof window.alert === 'function') {
      window.alert(`${ADMIN_ONLY_TITLE}\n\n${ADMIN_ONLY_MESSAGE}`);
    }
    return;
  }
  Alert.alert(ADMIN_ONLY_TITLE, ADMIN_ONLY_MESSAGE, [{ text: 'OK' }]);
}

/**
 * Mount on an admin-only screen. Once the role is known and the person is
 * not an admin: explain, then leave (back if possible, else Home). Renders
 * nothing; the screen should also avoid rendering admin content while
 * `blocked` is true.
 *
 * Returns `{ phase, isAdmin, blocked }` so the screen can show a skeleton
 * while loading and render nothing once blocked.
 */
export function useAdminOnlyScreen(): { phase: 'loading' | 'ready'; isAdmin: boolean; blocked: boolean } {
  const { phase, role } = useRoleGate();
  const navigation = useNavigation();
  const isAdmin = role?.isAdmin === true;
  const blocked = phase === 'ready' && !isAdmin;
  const explained = useRef(false);

  useEffect(() => {
    if (!blocked || explained.current) return;
    explained.current = true;
    explainAdminOnly();
    try {
      if (navigation.canGoBack()) router.back();
      else router.replace('/(tabs)' as never);
    } catch {
      // Already leaving, or nowhere to go: the screen renders nothing anyway.
    }
  }, [blocked, navigation]);

  return { phase, isAdmin, blocked };
}
