import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs, router, useNavigation, useSegments } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';

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
 * ONE WAY OUT (Build 33). This used to draw a second bar under the native
 * header — a CRM-coloured ‹ Back plus a Home button — which, whenever the
 * header ALSO had its arrow, meant two back arrows and a Home button on one
 * screen. Now the native header is the only navigation control: it carries
 * the tab's title and its own back arrow (re-asserted with `headerShown: true`
 * so nothing elsewhere can switch it off), and in the one case where it has
 * no arrow — a cold deep link or a notification tap, nothing underneath —
 * this layout gives it a single back chevron that goes Home instead. The web
 * keeps the root layout's `WebBackButton`.
 */

const TAB_TITLES: Record<string, string> = {
  messages: 'Messages',
  recents: 'Recents',
  keypad: 'Keypad',
  contacts: 'Contacts',
};

/** The header's back control when there is nothing underneath to go back to. */
function HomeBackButton() {
  return (
    <Pressable
      onPress={() => {
        try {
          router.replace('/(tabs)' as never);
        } catch {
          // Already leaving.
        }
      }}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel="Back to Home"
      style={({ pressed }) => [styles.headerBack, pressed && styles.pressed]}>
      <Ionicons name="chevron-back" size={26} color={colors.ocean} />
    </Pressable>
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
      const nothingUnderneath = Platform.OS !== 'web' && !navigation.canGoBack();
      navigation.setOptions({
        headerShown: true,
        title: TAB_TITLES[currentTab] ?? 'Phone',
        ...(nothingUnderneath ? { headerLeft: () => <HomeBackButton /> } : {}),
      });
    } catch {
      // Not mounted inside a stack (never, in practice).
    }
  }, [navigation, currentTab]);

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
  headerBack: { paddingRight: spacing.sm },
  pressed: { opacity: 0.6 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
});
