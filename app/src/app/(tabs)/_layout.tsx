import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { colors } from '@/constants/theme';
import { getAccountInfo } from '@/lib/account';

/**
 * Staff-only gate.
 *
 * Before this, the tab routes had NO gate at all — a signed-in customer (or
 * anyone typing /pipeline on the web) reached the crew UI. It rendered empty
 * because RLS blocks the queries, but it should never have been reachable.
 *
 * RLS remains the real protection; this is about not showing people a shell
 * of an app they have no business in.
 */
function useStaffGate() {
  const router = useRouter();
  const [state, setState] = useState<'checking' | 'staff'>('checking');

  useEffect(() => {
    let cancelled = false;
    getAccountInfo().then((account) => {
      if (cancelled) return;
      if (account.kind === 'employee' || account.kind === 'unknown') {
        // 'unknown' = signed in but the role lookup failed (usually no signal).
        // Let them through: RLS decides what actually loads, and bouncing a
        // crew member to the login screen mid-job would be far worse.
        setState('staff');
      } else if (account.kind === 'customer') {
        router.replace('/customer' as never);
      } else {
        router.replace('/');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [router]);

  return state;
}

export default function TabsLayout() {
  const gate = useStaffGate();

  if (gate === 'checking') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cream }}>
        <ActivityIndicator color={colors.ocean} />
      </View>
    );
  }

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.ocean,
        tabBarInactiveTintColor: colors.inkSoft,
        tabBarStyle: {
          backgroundColor: colors.cream,
          borderTopColor: colors.tan,
        },
        tabBarLabelStyle: { fontWeight: '600' },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Calendar',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calendar" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="pipeline"
        options={{
          title: 'Pipeline',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="layers" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="sales"
        options={{
          title: 'Sales',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="trending-up" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="financials"
        options={{
          title: 'Financials',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="wallet" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="hours"
        options={{
          title: 'Hours',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="time" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: 'More',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="ellipsis-horizontal-circle" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
