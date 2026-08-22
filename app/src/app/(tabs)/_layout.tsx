import { Tabs, useNavigation, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { TabIcon } from '@/components/ui';
import { colors, fonts } from '@/constants/theme';
import { getAccountInfo } from '@/lib/account';
import { fetchUnreadCount } from '@/lib/comms';
import { supabase } from '@/lib/supabase';

/**
 * Fires the bounce to the login screen at most ONCE per app session.
 *
 * It is module scope, not a `useRef`, and that is the whole point. See the
 * loop note in `useStaffGate` — the layout is UNMOUNTED and REMOUNTED by the
 * very navigation it triggers, so any guard living inside the component is
 * reset before it can do its job. It goes back to `false` the moment a
 * session exists again, so signing out twice in one session still bounces
 * twice.
 */
let bouncedToLogin = false;

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
 *      the login screen never rendered once. `bouncedToLogin` above breaks
 *      the cycle: the navigation happens once and is not repeated on the
 *      remount.
 *
 *   2. The gate called `getAccountInfo()` first, and that returns `'unknown'`
 *      on ANY query error — which deliberately fails OPEN into the tabs. Now
 *      the SESSION is checked first: no session is not a failed lookup, it is
 *      a fact, so it short-circuits without a single REST call.
 *      `getAccountInfo()` only runs when a session exists, which is the only
 *      case its offline-tolerant `'unknown'` was ever written for.
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
      if (bouncedToLogin) return;
      bouncedToLogin = true;
      navigation.reset({ index: 0, routes: [{ name: 'index' as never }] });
    };

    void (async () => {
      // Session FIRST. A missing session is not a failed lookup.
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      if (!data.session) {
        leave();
        return;
      }
      // Somebody is signed in, so the next sign-out gets its own bounce.
      bouncedToLogin = false;

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
