import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CrmWorkspace } from '@/components/crm/workspace/CrmWorkspace';
import { AppText, FadeInUp, Screen, SectionHeader, Tile } from '@/components/ui';
import { colors, hubColors, spacing } from '@/constants/theme';
import { explainAdminOnly, isLockedFor } from '@/lib/adminGate';
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
 * TWO SHAPES (2026-09-12 overhaul). On the web this is the three-column
 * `components/crm/workspace/CrmWorkspace`, unchanged, edge to edge. On the
 * phone — where the tab is now offered too — it is the CRM HUB: the hub's
 * entries (Customers, Leads, Sales, Email, Phone, Jobs Board) as a grid of
 * purple-edged tiles, the same grid `hub/[key].tsx` draws for HR and Systems.
 * Every role sees every tile; the admin-only ones are drawn locked and
 * explain themselves on tap (`lib/adminGate.ts`).
 */
export default function CrmTab() {
  if (Platform.OS === 'web') {
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
  const items = itemsIn('crm');

  return (
    <Screen header={<AppText variant="title">{hub.title}</AppText>}>
      <SectionHeader title={hub.title} subtitle={hub.subtitle} accent={accent.fg} />
      <View style={styles.grid}>
        {items.map((item, i) => {
          const locked = gate.phase === 'ready' && isLockedFor(item.gate, isAdmin);
          return (
            <FadeInUp key={item.key} index={i} style={[styles.cell, { width: `${100 / columns}%` }]}>
              <Tile
                title={item.title}
                subtitle={item.subtitle}
                icon={item.icon}
                tone={item.tone}
                locked={locked}
                badge={item.badge === 'unread' ? unread : undefined}
                onPress={() => {
                  if (isLockedFor(item.gate, isAdmin)) explainAdminOnly();
                  else router.push(item.href);
                }}
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
  // The web wrapper is unchanged from before the overhaul; the workspace
  // paints its own columns over it.
  screen: { flex: 1, backgroundColor: colors.cream },
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
