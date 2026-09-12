import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs, router, useNavigation, useSegments } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { TabIcon } from '@/components/ui';
import { colors, fonts, hubColors, spacing } from '@/constants/theme';
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
 * own — two native headers stacked is the thing to avoid here.
 *
 * ADMIN ONLY except Contacts (see the role-aware gate in the component): the
 * Home/Menu Phone tile is gated `admin`, and a crew member who reaches any
 * tab other than Contacts gets the "contact your administrator" alert and is
 * sent back instead of three empty screens. Neither is the security
 * boundary — `messages` is admin-only in RLS and `phone_directory()`
 * decides per role what it answers.
 *
 * Three states this must read correctly in, none of them a crash: signed
 * out, signed in as crew, signed in as an admin with Twilio switched off.
 *
 * TWO WAYS OUT, ALWAYS (2026-09-12, owner's feedback: "no way of returning
 * to the rest of the app"). The root Stack header is the first: this layout
 * re-asserts `headerShown: true` on its own route through `setOptions`, so
 * no screen option elsewhere can switch it off. The `SectionBar` below the
 * header is the second: a plain `‹ Back` (or `‹ Home` when this is the first
 * screen — a cold deep link or a notification tap has nothing under it, and
 * the native header draws NO back arrow in that case) plus a Home button.
 * The app's own bottom tab bar is not expected here — /phone is a pushed
 * route, not a tab — so the way home has to be drawn by this file.
 */

const TAB_TITLES: Record<string, string> = {
  messages: 'Messages',
  recents: 'Recents',
  keypad: 'Keypad',
  contacts: 'Contacts',
};

function leavePhone() {
  try {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)' as never);
  } catch {
    router.replace('/(tabs)' as never);
  }
}

function goHome() {
  try {
    router.replace('/(tabs)' as never);
  } catch {
    // Already leaving.
  }
}

/** The exit row above the phone's tabs: ‹ Back / ‹ Home · tab name · Home. */
function SectionBar({ tab }: { tab: string }) {
  const canGoBack = router.canGoBack();
  return (
    <View style={styles.bar}>
      <Pressable
        onPress={leavePhone}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={canGoBack ? 'Back' : 'Home'}
        style={({ pressed }) => [styles.barBack, pressed && styles.pressed]}>
        <Ionicons name="chevron-back" size={20} color={hubColors.crm.fg} />
        <Text style={styles.barBackText}>{canGoBack ? 'Back' : 'Home'}</Text>
      </Pressable>
      <Text style={styles.barTitle} numberOfLines={1}>
        {TAB_TITLES[tab] ?? 'Phone'}
      </Text>
      <Pressable
        onPress={goHome}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Go to Home"
        style={({ pressed }) => [styles.barHome, pressed && styles.pressed]}>
        <Ionicons name="home-outline" size={18} color={hubColors.crm.fg} />
      </Pressable>
    </View>
  );
}

export default function PhoneLayout() {
  // CONTACTS IS FOR EVERYONE (2026-09-12): the company directory — customers
  // and the imported contacts — is something Devon wants the crew to have.
  // The other three tabs (texts, calls, keypad) stay admin-only. So the gate
  // is role-aware rather than a blanket `useAdminOnlyScreen`: a crew member
  // on /phone/contacts is let through with only that tab in the bar; a crew
  // member anywhere else under /phone gets the same alert + exit as before.
  const segments = useSegments();
  const currentTab = segments[segments.length - 1] ?? 'keypad';
  const onContacts = currentTab === 'contacts';
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

  // The root Stack header for THIS route (`useNavigation` in a layout file is
  // the parent's navigation object). Re-asserted here so the header with
  // the back arrow is on no matter what the root declaration says.
  useEffect(() => {
    try {
      navigation.setOptions({ headerShown: true, title: 'Phone' });
    } catch {
      // Not mounted inside a stack (never, in practice).
    }
  }, [navigation]);

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
    <View style={styles.root}>
      <SectionBar tab={currentTab} />
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
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surfaceAlt },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  barBack: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    paddingRight: spacing.sm,
    minWidth: 72,
  },
  barBackText: { color: hubColors.crm.fg, fontSize: 15, fontWeight: '700' },
  barTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  barHome: { minWidth: 72, alignItems: 'flex-end', paddingVertical: spacing.xs, paddingLeft: spacing.sm },
  pressed: { opacity: 0.6 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
});
