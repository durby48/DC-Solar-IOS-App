import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CrmWorkspace } from '@/components/crm/workspace/CrmWorkspace';
import { AppText, FadeInUp, Screen, SectionHeader, Tile } from '@/components/ui';
import { colors, hubColors, spacing } from '@/constants/theme';
import { isVisibleFor } from '@/lib/adminGate';
import { fetchUnreadCount } from '@/lib/comms';
import { hubFor, itemsIn } from '@/lib/hub';
import { useRoleGate } from '@/lib/role';

/**
 * The CRM tab.
 *
 * The file is `workspace.tsx`, not `crm.tsx`, because `/crm` is already a
 * route — `app/crm/index.tsx` redirects it to the Customers list and
 * `crm/[id]`, `crm/inbox`, `crm/settings` live under it — and two files
 * claiming one URL is exactly the ambiguity that produced the sign-out
 * redirect loop on `/`. The tab is LABELLED "CRM"; its URL is `/workspace`.
 *
 * TWO SHAPES, CHOSEN BY ROLE (2026-10-05). Admins get the
 * `components/crm/workspace/CrmWorkspace` — three columns at desk width, one
 * column at a time on a phone — on the web AND in the iPhone app, so the app
 * matches app.dcsolarkc.com. Everyone else gets the CRM HUB: the hub's
 * entries (Customers, Contacts, Leads, Sales, Email, Phone) as a grid of
 * purple-edged tiles, the same grid `hub/[key].tsx` draws for HR and Systems,
 * with the admin-only ones drawn locked and explaining themselves on tap
 * (`lib/adminGate.ts`).
 *
 * Until 2026-10-05 the split was by PLATFORM (web = workspace, phone = hub),
 * which showed crew on the web the workspace's "Admins only" wall and kept
 * the workspace off the phone entirely. The workspace itself still refuses
 * non-admins; this only stops sending them there.
 *
 * The spinner while the role resolves is deliberate: rendering the hub first
 * and swapping in the workspace a beat later is the flicker `useRoleGate()`
 * exists to prevent.
 */
export default function CrmTab() {
  const gate = useRoleGate();
  if (gate.phase === 'loading') {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={hubColors.crm.fg} />
      </View>
    );
  }
  // Sales (2026-10-05) get the workspace too — narrowed to their own records
  // by RLS and to their lenses by `CrmWorkspace`. It is their whole app.
  if (gate.role?.isAdmin || gate.role?.isSales) {
    return (
      <SafeAreaView edges={['top']} style={styles.screen}>
        <View style={styles.screen}>
          <CrmWorkspace />
        </View>
      </SafeAreaView>
    );
  }
  return <CrmHub />;
}

/** Two columns on a phone; the tablet gets three. */
const WIDE_BREAKPOINT = 900;

function CrmHub() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const gate = useRoleGate();
  const isAdmin = gate.phase === 'ready' && gate.role?.isAdmin === true;
  const columns = width >= WIDE_BREAKPOINT ? 3 : 2;

  /**
   * Unread inbound texts, for the Customers and Phone tiles. `messages` is
   * admin-only in RLS, so the crew get 0 and no badge — the gate is the
   * database's, not this screen's.
   */
  const [unread, setUnread] = useState(0);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void fetchUnreadCount().then((count) => {
        if (!cancelled) setUnread(count);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const hub = hubFor('crm');
  const accent = hubColors.crm;
  // Admin-only entries are hidden from crew (2026-10-08), not drawn locked.
  const items = itemsIn('crm').filter((item) => isVisibleFor(item.gate, gate.phase, isAdmin));

  return (
    <Screen header={<AppText variant="title">{hub.title}</AppText>}>
      <SectionHeader title={hub.title} subtitle={hub.subtitle} accent={accent.fg} />
      <View style={styles.grid}>
        {items.map((item, i) => {
          return (
            <FadeInUp key={item.key} index={i} style={[styles.cell, { width: `${100 / columns}%` }]}>
              <Tile
                title={item.title}
                subtitle={item.subtitle}
                icon={item.icon}
                tone={item.tone}
                badge={item.badge === 'unread' ? unread : undefined}
                onPress={() => router.push(item.href)}
                style={styles.tile}
              />
            </FadeInUp>
          );
        })}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // The workspace wrapper (web and phone); the workspace paints its own
  // columns over it.
  screen: { flex: 1, backgroundColor: colors.cream },
  center: { alignItems: 'center', justifyContent: 'center' },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -spacing.xs,
  },
  cell: {
    padding: spacing.xs,
  },
  tile: {
    minWidth: 0,
  },
});
