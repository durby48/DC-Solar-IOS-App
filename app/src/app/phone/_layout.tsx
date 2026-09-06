import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { TabIcon } from '@/components/ui';
import { colors, fonts, radii, spacing } from '@/constants/theme';
import { fetchUnreadCount, useCommsRealtime } from '@/lib/comms';
import { useRoleGate } from '@/lib/role';

/**
 * `/phone` — the phone app: Contacts · Keypad · Recents · Messages.
 *
 * A NESTED `Tabs` INSIDE THE ROOT STACK. The app's own tab bar (Home /
 * Calendar / Pipeline / Customers / Menu) is untouched; this is a second,
 * iOS-Phone-style bar that only exists inside this pushed route. The root
 * Stack keeps its header (title "Phone", back arrow), so each tab hides its
 * own — two headers stacked is the thing to avoid here.
 *
 * ADMIN ONLY, by Devon's decision, and enforced twice: the Home/Menu tile is
 * gated `admin`, and this layout refuses to render the tabs for anyone else.
 * Neither is the security boundary — `messages` is admin-only in RLS and
 * `phone_directory()` re-checks `is_company_admin()` itself, so a viewer who
 * typed the URL would get four empty screens. This just replaces those with
 * one honest sentence.
 *
 * Three states this must read correctly in, none of them a crash: signed
 * out, signed in as crew, signed in as an admin with Twilio switched off.
 */
export default function PhoneLayout() {
  const gate = useRoleGate();
  const isAdmin = gate.role?.isAdmin ?? false;
  const [unread, setUnread] = useState(0);

  const refreshUnread = useCallback(() => {
    void fetchUnreadCount().then(setUnread);
  }, []);

  useEffect(() => {
    if (gate.phase !== 'ready' || !isAdmin) return;
    refreshUnread();
  }, [gate.phase, isAdmin, refreshUnread]);

  // Keeps the Messages badge live while any tab is open. Harmless for a
  // non-admin: RLS hands their socket nothing.
  useCommsRealtime(refreshUnread);

  if (gate.phase === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.accentPrimary} />
      </View>
    );
  }

  if (!gate.role) {
    return (
      <View style={styles.padded}>
        <View style={styles.card}>
          <View style={styles.badge}>
            <Ionicons name="call" size={26} color={colors.ocean} />
          </View>
          <Text style={styles.title}>Sign in to use the phone</Text>
          <Text style={styles.body}>
            Calling and texting from the DC Solar number needs a signed-in admin.
          </Text>
        </View>
      </View>
    );
  }

  if (!isAdmin) {
    return (
      <View style={styles.padded}>
        <View style={styles.card}>
          <View style={styles.badge}>
            <Ionicons name="lock-closed" size={26} color={colors.ocean} />
          </View>
          <Text style={styles.title}>Admins only</Text>
          <Text style={styles.body}>
            The phone carries customer threads, which hold prices and addresses, so it is
            limited to owners and operators.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <Tabs
      initialRouteName="keypad"
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
        sceneStyle: { backgroundColor: colors.cream },
      }}>
      {/* `/phone` → keypad. Exists so a hard load of the bare path has a
          page to serve; hidden from the bar so it is not a fifth tab. */}
      <Tabs.Screen name="index" options={{ href: null }} />
      <Tabs.Screen
        name="contacts"
        options={{
          title: 'Contacts',
          tabBarIcon: ({ focused }) => <TabIcon name="people" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="keypad"
        options={{
          title: 'Keypad',
          tabBarIcon: ({ focused }) => <TabIcon name="keypad" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="recents"
        options={{
          title: 'Recents',
          tabBarIcon: ({ focused }) => <TabIcon name="time" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="messages"
        options={{
          title: 'Messages',
          tabBarIcon: ({ focused }) => <TabIcon name="chatbubbles" focused={focused} />,
          tabBarBadge: unread > 0 ? unread : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.danger, color: colors.white },
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
    backgroundColor: colors.cream,
  },
  padded: { flex: 1, padding: spacing.lg, backgroundColor: colors.cream },
  card: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: radii.lg,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: colors.ink, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  body: { color: colors.inkSoft, fontSize: 14, fontWeight: '600', textAlign: 'center' },
});
