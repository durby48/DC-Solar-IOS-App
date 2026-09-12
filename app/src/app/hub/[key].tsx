import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View, useWindowDimensions, Platform } from 'react-native';

import { FadeInUp, Screen, SectionHeader, Tile, AppText } from '@/components/ui';
import { colors, hubColors, spacing } from '@/constants/theme';
import { explainAdminOnly, isLockedFor } from '@/lib/adminGate';
import { HUBS, hubFor, itemsIn, type HubKey } from '@/lib/hub';
import { useRoleGate } from '@/lib/role';
import { router } from 'expo-router';

/**
 * A hub's front page (2026-09-12): the entries of one Home hub as a grid of
 * colour-edged tiles. Human Resources and Systems Management land here; CRM,
 * Pipeline and Operations have their own screens. Same grid for every role —
 * admin-only entries are drawn locked and explain themselves on tap.
 */
const WIDE_BREAKPOINT = 900;

function isHubKey(value: unknown): value is HubKey {
  return typeof value === 'string' && HUBS.some((h) => h.key === value);
}

export default function HubScreen() {
  const { key } = useLocalSearchParams<{ key?: string }>();
  const { width } = useWindowDimensions();
  const gate = useRoleGate();
  const isAdmin = gate.role?.isAdmin === true;
  const compact = Platform.OS === 'web' && width >= WIDE_BREAKPOINT;
  const columns = width >= WIDE_BREAKPOINT ? 4 : 2;

  if (!isHubKey(key)) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Hub' }} />
        <AppText variant="body" color={colors.textMuted}>
          That section does not exist.
        </AppText>
      </Screen>
    );
  }

  const hub = hubFor(key);
  const accent = hubColors[key];
  const items = itemsIn(key);

  return (
    <Screen>
      <Stack.Screen options={{ title: hub.title, headerTintColor: accent.fg }} />
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
                compact={compact}
                locked={locked}
                onPress={() => {
                  if (locked) explainAdminOnly();
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
