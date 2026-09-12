import { Tabs, router, useNavigation, useSegments } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { TabIcon } from '@/components/ui';
import { colors, fonts, hubColors } from '@/constants/theme';
import { explainAdminOnly } from '@/lib/adminGate';
import { useRoleGate } from '@/lib/role';
import { fetchUnreadCount, useCommsRealtime } from '@/lib/comms';

/**
 * `/phone` — the phone app: Messages · Recents · Keypad · Contacts.
 *
 * A NESTED `Tabs` INSIDE THE ROOT STACK. The app's own tab bar (Home /
 * Calendar / Pipeline / Customers / Menu) is untouched; this is a second,
 * iOS-Phone-style bar that only exists inside this pushed route. The root
 * Stack keeps its header (title "Phone", back arrow), so each tab hides its
 * own — two headers stacked is the thing to avoid here.
 *
 * ADMIN ONLY, by Devon's decision, and enforced twice: the Home/Menu tile is
 * gated `admin`, and this layout mounts `useAdminOnlyScreen`, so a crew
 * member who typed the URL gets the "contact your administrator" alert and
 * is sent back instead of four empty screens. Neither is the security
 * boundary — `messages` is admin-only in RLS and `phone_directory()`
 * re-checks `is_company_admin()` itself.
 *
 * Three states this must read correctly in, none of them a crash: signed
 * out, signed in as crew, signed in as an admin with Twilio switched off.
 */
export default function PhoneLayout() {
  // CONTACTS IS FOR EVERYONE (2026-09-12): the company directory — customers
  // and the imported contacts — is something Devon wants the crew to have.
  // The other three tabs (texts, calls, keypad) stay admin-only. So the gate
  // is role-aware rather than a blanket `useAdminOnlyScreen`: a crew member
  // on /phone/contacts is let through with only that tab in the bar; a crew
  // member anywhere else under /phone gets the same alert + exit as before.
  const segments = useSegments();
  const onContacts = segments[segments.length - 1] === 'contacts';
  const roleGate = useRoleGate();
  const isAdmin = roleGate.role?.isAdmin === true;
  const blocked = roleGate.phase === 'ready' && !isAdmin && !onContacts;
  const explained = useRef(false);
  const navigation = useNavigation();
  useEffect(() => {
    if (!blocked || explained.current) return;
    explained.current = true;
    explainAdminOnly();
    try {
      if (navigation.canGoBack()) router.back();
      else router.replace('/(tabs)' as never);
    } catch {
      // Already leaving.
    }
  }, [blocked, navigation]);
  const gate = { phase: roleGate.phase, isAdmin, blocked };
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

  if (gate.blocked) {
    // Explained and leaving; draw the page ground and nothing else.
    return <View style={styles.center} />;
  }

  return (
    <Tabs
      initialRouteName="keypad"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: hubColors.crm.fg,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.surfaceAlt,
          borderTopColor: colors.border,
          height: 62,
        },
        tabBarLabelStyle: { fontFamily: fonts.bold, fontSize: 11 },
        sceneStyle: { backgroundColor: colors.surfaceAlt },
      }}>
      {/* `/phone` → keypad. Exists so a hard load of the bare path has a
          page to serve; hidden from the bar so it is not a fifth tab. */}
      <Tabs.Screen name="index" options={{ href: null }} />
      {/* Order is Devon's: Messages · Recents · Keypad · Contacts. Keypad
          stays the default tab; the bar order is separate from that. */}
      <Tabs.Screen
        name="messages"
        options={{
          href: isAdmin ? undefined : null,
          title: 'Messages',
          tabBarIcon: ({ focused }) => <TabIcon name="chatbubbles" focused={focused} />,
          tabBarBadge: unread > 0 ? unread : undefined,
          tabBarBadgeStyle: { backgroundColor: colors.danger, color: colors.white },
        }}
      />
      <Tabs.Screen
        name="recents"
        options={{
          href: isAdmin ? undefined : null,
          title: 'Recents',
          tabBarIcon: ({ focused }) => <TabIcon name="time" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="keypad"
        options={{
          href: isAdmin ? undefined : null,
          title: 'Keypad',
          tabBarIcon: ({ focused }) => <TabIcon name="keypad" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="contacts"
        options={{
          title: 'Contacts',
          tabBarIcon: ({ focused }) => <TabIcon name="people" focused={focused} />,
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
