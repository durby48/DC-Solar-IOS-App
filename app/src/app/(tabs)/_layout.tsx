import { Tabs, useNavigation, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { TabIcon } from '@/components/ui';
import { colors, fonts } from '@/constants/theme';
import { getAccountInfo } from '@/lib/account';
import {
  clearBounceToLogin,
  hasBouncedToLogin,
  markBouncedToLogin,
} from '@/lib/authGate';
import { fetchUnreadCount } from '@/lib/comms';
import { supabase } from '@/lib/supabase';

/**
 * Staff-only gate.
 *
 * Before this, the tab routes had NO gate at all — a signed-in customer (or
 * anyone typing /pipeline on the web) reached the crew UI. It rendered empty
 * because RLS blocks the queries, but it should never have been reachable.
 *
 * RLS remains the real protection; this is about not showing people a shell
 * of an app they have no business in.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE REDIRECT LOOP THIS FIXES (2026-08-22)
 * ────────────────────────────────────────────────────────────────────────
 * Loading `/more` (or any tab) while signed out used to hang the browser tab
 * with `Throttling navigation to prevent the browser from hanging` —
 * Chrome's IPC-flood protection, crbug.com/1038223 — and the login page never
 * appeared at all.
 *
 * Two things caused it, and both are fixed here:
 *
 *   1. `/` is claimed by TWO route files: `app/index.tsx` (login) and
 *      `app/(tabs)/index.tsx` (Home). A fresh page load of `/` resolves to
 *      the login, but `router.replace('/')` called from INSIDE the tabs
 *      resolves back into `(tabs)` and replaces that stack entry with a FRESH
 *      one — so this layout unmounts, remounts, re-runs the gate, and
 *      replaces again. Instrumented, it ran ~9,000 times in a few seconds and
 *      the login screen never rendered once. `navigation.reset()` on the ROOT
 *      stack is what fixes it: it names the `index` ROUTE rather than the `/`
 *      URL, so it cannot resolve back into `(tabs)`, and it tears this layout
 *      down instead of replacing one entry underneath it.
 *
 *   2. The gate called `getAccountInfo()` first, and that returns `'unknown'`
 *      on ANY query error — which deliberately fails OPEN into the tabs. Now
 *      the SESSION is checked first: no session is not a failed lookup, it is
 *      a fact, so it short-circuits without a single REST call.
 *      `getAccountInfo()` only runs when a session exists, which is the only
 *      case its offline-tolerant `'unknown'` was ever written for.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE PERMANENT SPINNER THIS FIXES (2026-08-22, second pass)
 * ────────────────────────────────────────────────────────────────────────
 * The first fix also latched a module-scope `bouncedToLogin` that was only
 * ever cleared when a session existed. So the bounce was strictly once per app
 * session: the SECOND signed-out visit to a tab route (tap a tab link, browser
 * back, type `/more` again in an SPA history navigation) set the state to
 * `'out'`, skipped the navigation entirely, and left the spinner up forever.
 *
 * `leave()` now ALWAYS navigates. `navigation.reset({ routes: [index] })` is
 * idempotent — resetting the root stack to `index` when it is already `index`
 * is a no-op, not a loop — so there is nothing to gain by suppressing it. The
 * flag moved to `lib/authGate.ts` and now means only "a bounce was fired that
 * the login screen has not acknowledged". The login screen clears it on mount,
 * so a `true` reading here means the login never rendered, and that is the one
 * case where the `router.replace('/')` FALLBACK below must stay holstered — it
 * is the call that caused (1).
 *
 * While the bounce is in flight the layout renders its spinner rather than
 * the tab bar, so nobody sees a flash of an app they are not signed in to.
 */
function useStaffGate() {
  const router = useRouter();
  const navigation = useNavigation();
  const [state, setState] = useState<'checking' | 'staff' | 'out'>('checking');

  useEffect(() => {
    let cancelled = false;

    const leave = () => {
      setState('out');
      // Was a previous bounce never acknowledged by the login screen? Then we
      // are looping, and the fallback below must not fire.
      const unacknowledged = hasBouncedToLogin();
      markBouncedToLogin();
      try {
        // Idempotent: naming the ROUTE `index` rather than the `/` URL means
        // this cannot resolve back into `(tabs)`, and re-running it when the
        // root stack is already `[index]` changes nothing.
        navigation.reset({ index: 0, routes: [{ name: 'index' as never }] });
      } catch {
        // Only if the root navigator has no `index` route to reset to — which
        // should never happen, but stranding someone on a spinner would be
        // worse than one `replace`. Once, and never while a bounce is already
        // unaccounted for: this is the exact call that looped ~9,000 times.
        if (!unacknowledged) router.replace('/');
      }
    };

    void (async () => {
      // Session FIRST. A missing session is not a failed lookup.
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (!data.session) {
        leave();
        return;
      }
      // Somebody is signed in, so the next sign-out gets a clean slate even if
      // the login screen never mounted to clear it.
      clearBounceToLogin();

      const account = await getAccountInfo();
      if (cancelled) return;
      if (account.kind === 'employee' || account.kind === 'unknown') {
        // 'unknown' = signed in but the role lookup failed (usually no
        // signal). Let them through: RLS decides what actually loads, and
        // bouncing a crew member to the login screen mid-job would be far
        // worse.
        setState('staff');
      } else if (account.kind === 'customer') {
        router.replace('/customer');
      } else {
        leave();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [router, navigation]);

  return state;
}

export default function TabsLayout() {
  const gate = useStaffGate();
  const [unread, setUnread] = useState(0);

  /**
   * Unread inbound texts, for the badge on the Customers tab. `messages` is
   * admin-only in RLS, so the crew get 0 and no badge appears — the gate is
   * the database's, not this file's. It runs only once the gate clears, so a
   * signed-out visitor never fires the query at all.
   */
  useEffect(() => {
    if (gate !== 'staff') return;
    let cancelled = false;
    void fetchUnreadCount().then((count) => {
      if (!cancelled) setUnread(count);
    });
    return () => {
      cancelled = true;
    };
  }, [gate]);

  if (gate !== 'staff') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accentPrimary} />
      </View>
    );
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.olive,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.surfaceAlt,
          borderTopColor: colors.border,
          height: 62,
        },
        tabBarLabelStyle: { fontFamily: fonts.bold, fontSize: 11 },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ focused }) => <TabIcon name="home" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="calendar"
        options={{
          title: 'Calendar',
          tabBarIcon: ({ focused }) => <TabIcon name="calendar" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="pipeline"
        options={{
          title: 'Pipeline',
          tabBarIcon: ({ focused }) => <TabIcon name="layers" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="customers"
        options={{
          title: 'Customers',
          tabBarIcon: ({ focused }) => <TabIcon name="people" focused={focused} />,
          tabBarBadge: unread > 0 ? unread : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.danger, color: colors.white },
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          // The file is still `more.tsx` because `/more` and the `more/*`
          // directory have to coexist; only the label changed.
          title: 'Menu',
          tabBarIcon: ({ focused }) => <TabIcon name="grid" focused={focused} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
});
