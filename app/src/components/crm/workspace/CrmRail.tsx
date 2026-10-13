import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { NavigationContext } from 'expo-router/react-navigation';
import { useContext, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import CustomersTab from '@/app/(tabs)/customers';
import AssignLeadsScreen from '@/app/assign-leads';
import EmailInboxScreen from '@/app/inbox';
import LeadMapScreen from '@/app/lead-map';
import LeadsScreen from '@/app/leads/index';
import ContactsScreen from '@/app/phone/contacts';
import RemovedLeadsScreen from '@/app/removed-leads';
import ResourcesScreen from '@/app/resources/index';
import SalesScreen from '@/app/sales';
import StormReportsScreen from '@/app/storm-reports/index';
import { Inbox } from '@/components/comms/Inbox';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { itemsIn, type HubItem } from '@/lib/hub';

/**
 * The CRM rail (2026-10-12, Devon): every CRM hub entry as a bar down the
 * left of the workspace — only in the workspace, only for admins, only where
 * there is room for columns (≥ 760 px). "CRM workspace" is the usual list /
 * conversation / details; any other entry shows that screen in place, to the
 * right of the rail, and the rail highlights what is open. The bar collapses
 * to icons; both the choice and the collapse are remembered on the web.
 *
 * Embedded screens are the real route components. Several set their own
 * title with <Stack.Screen options> / navigation.setOptions — inside the
 * workspace that would rename the CRM tab, so they get a navigation object
 * whose setOptions does nothing (everything else — focus events, goBack —
 * still reaches the workspace screen). Links inside them still navigate away
 * as usual (expo-router's global router).
 */

export const WORKSPACE_SECTION = 'workspace';

const SECTION_SCREENS: Record<string, React.ComponentType> = {
  customers: CustomersTab,
  contacts: ContactsScreen,
  leads: LeadsScreen,
  'assign-leads': AssignLeadsScreen,
  'storm-reports': StormReportsScreen,
  'removed-leads': RemovedLeadsScreen,
  'sales-resources': ResourcesScreen,
  'lead-map': LeadMapScreen,
  sales: SalesScreen,
  email: EmailInboxScreen,
  phone: PhoneSection,
};

function PhoneSection() {
  // Phone → its Messages tab (the keypad is the bottom-right button).
  return <Inbox showSettingsLink />;
}

/** The CRM entries the rail offers, in the hub's order. */
export function railItems(): HubItem[] {
  return itemsIn('crm').filter((i) => SECTION_SCREENS[i.key]);
}

const STORE_KEY = 'dc.crmRail.v1';
type Stored = { section: string; collapsed: boolean };

function readStored(): Stored {
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const p = JSON.parse(raw) as Partial<Stored>;
        const section = typeof p.section === 'string' && (p.section === WORKSPACE_SECTION || SECTION_SCREENS[p.section]) ? p.section : WORKSPACE_SECTION;
        return { section, collapsed: p.collapsed === true };
      }
    }
  } catch {
    // Private mode / blocked storage: start fresh.
  }
  return { section: WORKSPACE_SECTION, collapsed: false };
}

function writeStored(s: Stored) {
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    // Remembered for this visit only.
  }
}

/** Which section is open and whether the rail is collapsed, remembered on the web. */
export function useCrmRail() {
  // Read after mount: the web build is pre-rendered (output "static"), and a
  // value read during that first render does not survive hydration.
  const [state, setState] = useState<Stored>({ section: WORKSPACE_SECTION, collapsed: false });
  useEffect(() => {
    setState(readStored());
  }, []);
  const update = (next: Partial<Stored>) =>
    setState((s) => {
      const merged = { ...s, ...next };
      writeStored(merged);
      return merged;
    });
  return {
    section: state.section,
    collapsed: state.collapsed,
    setSection: (section: string) => update({ section }),
    toggleCollapsed: () => update({ collapsed: !state.collapsed }),
  };
}

export function CrmRail({
  section,
  collapsed,
  onSection,
  onToggleCollapsed,
}: {
  section: string;
  collapsed: boolean;
  onSection: (key: string) => void;
  onToggleCollapsed: () => void;
}) {
  const items = useMemo(railItems, []);
  const entries: { key: string; title: string; icon: HubItem['icon'] }[] = [
    { key: WORKSPACE_SECTION, title: 'CRM workspace', icon: 'albums' },
    ...items.map((i) => ({ key: i.key, title: i.title, icon: i.icon })),
  ];

  return (
    <View style={[styles.rail, collapsed && styles.railCollapsed]}>
      <Pressable
        onPress={onToggleCollapsed}
        accessibilityRole="button"
        accessibilityLabel={collapsed ? 'Expand the CRM menu' : 'Collapse the CRM menu'}
        style={({ pressed }) => [styles.toggle, collapsed && styles.toggleCollapsed, pressed && styles.pressed]}>
        <Ionicons name={collapsed ? 'chevron-forward' : 'chevron-back'} size={16} color={colors.inkSoft} />
        {collapsed ? null : <Text style={styles.toggleText}>CRM</Text>}
      </Pressable>
      <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
        {entries.map((e, i) => {
          const on = e.key === section;
          return (
            <View key={e.key}>
              {i === 1 ? <View style={styles.divider} /> : null}
              <Pressable
                onPress={() => onSection(e.key)}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                accessibilityLabel={e.title}
                style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
                  styles.item,
                  collapsed && styles.itemCollapsed,
                  hovered && !on && styles.itemHover,
                  on && styles.itemOn,
                  pressed && styles.pressed,
                ]}>
                {on ? <View style={styles.marker} /> : null}
                <Ionicons name={e.icon} size={17} color={on ? hubColors.crm.fg : colors.inkSoft} />
                {collapsed ? null : (
                  <Text style={[styles.itemText, on && styles.itemTextOn]} numberOfLines={1}>
                    {e.title}
                  </Text>
                )}
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** A navigation object that ignores setOptions, so an embedded screen cannot retitle the CRM tab. */
function InertTitles({ children }: { children: React.ReactNode }) {
  const navigation = useContext(NavigationContext);
  const inert = useMemo(
    () =>
      navigation
        ? (new Proxy(navigation, {
            get(target, prop, receiver) {
              if (prop === 'setOptions') return () => undefined;
              const value = Reflect.get(target, prop, receiver);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          }) as typeof navigation)
        : navigation,
    [navigation],
  );
  return <NavigationContext.Provider value={inert}>{children}</NavigationContext.Provider>;
}

/** The chosen CRM screen, in place, with a slim title bar. */
export function CrmSectionPane({ section }: { section: string }) {
  const router = useRouter();
  const item = railItems().find((i) => i.key === section);
  const Screen = SECTION_SCREENS[section];
  if (!item || !Screen) return null;
  return (
    <View style={styles.pane}>
      <View style={styles.paneHead}>
        <Ionicons name={item.icon} size={16} color={hubColors.crm.fg} />
        <Text style={styles.paneTitle}>{item.title}</Text>
        {item.subtitle ? <Text style={styles.paneSub}>{item.subtitle}</Text> : null}
        <View style={styles.flex} />
        <Pressable
          onPress={() => router.push(item.href)}
          hitSlop={6}
          accessibilityLabel={`Open ${item.title} full screen`}
          style={({ pressed }) => [styles.paneOpen, pressed && styles.pressed]}>
          <Text style={styles.paneOpenText}>Full screen</Text>
          <Ionicons name="open-outline" size={13} color={hubColors.crm.fg} />
        </Pressable>
      </View>
      <View style={styles.paneBody}>
        <InertTitles>
          <Screen key={section} />
        </InertTitles>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    width: 196,
    backgroundColor: colors.surface,
    borderRightWidth: 1,
    borderRightColor: colors.line,
    paddingTop: spacing.sm,
  },
  railCollapsed: { width: 56 },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginHorizontal: spacing.sm,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radii.sm,
  },
  toggleCollapsed: { justifyContent: 'center', paddingHorizontal: 0 },
  toggleText: { color: hubColors.crm.fg, fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
  list: { paddingHorizontal: spacing.sm, paddingBottom: spacing.lg, gap: 2 },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: spacing.xs, marginHorizontal: spacing.xs },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 8,
    borderRadius: radii.sm,
    position: 'relative',
  },
  itemCollapsed: { justifyContent: 'center', paddingHorizontal: 0 },
  itemHover: { backgroundColor: colors.canvas },
  // The highlight: a soft CRM wash and a short accent bar on the left edge.
  itemOn: { backgroundColor: hubColors.crm.bg },
  marker: {
    position: 'absolute',
    left: 0,
    top: 7,
    bottom: 7,
    width: 3,
    borderRadius: 2,
    backgroundColor: hubColors.crm.fg,
  },
  itemText: { flex: 1, color: colors.inkSoft, fontSize: 13, fontWeight: '600' },
  itemTextOn: { color: colors.ink, fontWeight: '800' },
  pressed: { opacity: 0.6 },
  flex: { flex: 1 },
  pane: { flex: 1, backgroundColor: colors.canvas },
  paneHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    backgroundColor: colors.surface,
  },
  paneTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  paneSub: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  paneOpen: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  paneOpenText: { color: hubColors.crm.fg, fontSize: 12, fontWeight: '700' },
  paneBody: { flex: 1 },
});
