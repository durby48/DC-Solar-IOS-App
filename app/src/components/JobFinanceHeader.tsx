import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { accentCycle, colors, radii, shadows, spacing } from '@/constants/theme';
import { fetchJobFinance, type JobFinanceSummary } from '@/lib/data';

function formatCurrency(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

/** Pixels per second the ticker travels — slow enough to read comfortably. */
const TICKER_SPEED = 38;

interface Tile {
  label: string;
  value: string;
}

/**
 * Admin-only strip of finance stat tiles for a job. Renders nothing while
 * loading or when the finance data can't be read (non-admin / RLS / offline)
 * — the parent should additionally gate on isAdmin. Bump `refreshKey` to
 * force a refetch (e.g. after a finance entry is edited or deleted).
 *
 * The strip is a continuously looping stock-style ticker (2026-08-04): the
 * tile track is rendered TWICE end-to-end and translated by exactly one
 * track width, so the loop is seamless with no visible jump. Falls back to a
 * plain horizontal scroller when the OS reports "reduce motion".
 */
export function JobFinanceHeader({
  jobId,
  refreshKey = 0,
}: {
  jobId: string;
  refreshKey?: number;
}) {
  const [summary, setSummary] = useState<JobFinanceSummary | null>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const translateX = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let cancelled = false;
    fetchJobFinance(jobId).then((result) => {
      if (!cancelled) setSummary(result);
    });
    return () => {
      cancelled = true;
    };
  }, [jobId, refreshKey]);

  // Honor the accessibility setting — a permanently moving element is a real
  // problem for some people. Silent no-op if the API is unavailable (web).
  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((enabled) => {
        if (!cancelled) setReduceMotion(Boolean(enabled));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (trackWidth <= 0 || reduceMotion) return;
    translateX.setValue(0);
    const animation = Animated.loop(
      Animated.timing(translateX, {
        toValue: -trackWidth,
        duration: (trackWidth / TICKER_SPEED) * 1000,
        easing: Easing.linear,
        // RN-Web can't drive transforms off the JS thread.
        useNativeDriver: Platform.OS !== 'web',
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [trackWidth, reduceMotion, translateX]);

  if (!summary) return null;

  const tiles: Tile[] = [
    {
      label: 'Estimate',
      value: summary.estimate != null ? formatCurrency(summary.estimate) : '—',
    },
    { label: 'Invoiced', value: formatCurrency(summary.invoiced) },
    { label: 'Paid', value: formatCurrency(summary.paid) },
    { label: 'Expenses', value: formatCurrency(summary.expenses) },
    { label: 'Hours', value: `${summary.hours.toFixed(1)} h` },
    { label: 'Labor', value: formatCurrency(summary.labor) },
  ];

  const renderTile = (tile: Tile, index: number, keyPrefix: string) => {
    const accent = accentCycle[index % accentCycle.length];
    return (
      <View key={`${keyPrefix}-${tile.label}`} style={styles.tile}>
        <View style={[styles.tileDot, { backgroundColor: accent.fg }]} />
        <View style={styles.tileText}>
          <Text style={[styles.tileLabel, { color: accent.fg }]}>{tile.label}</Text>
          <Text style={styles.tileValue}>{tile.value}</Text>
        </View>
      </View>
    );
  };

  return (
    <View>
      {reduceMotion ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.viewport}
          contentContainerStyle={styles.staticRow}>
          {tiles.map((tile, i) => renderTile(tile, i, 'static'))}
        </ScrollView>
      ) : (
        <View style={styles.viewport} pointerEvents="none">
          <Animated.View style={[styles.track, { transform: [{ translateX }] }]}>
            <View
              style={styles.group}
              onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}>
              {tiles.map((tile, i) => renderTile(tile, i, 'a'))}
            </View>
            {/* Second copy: what the eye sees once copy one scrolls off. */}
            <View style={styles.group}>{tiles.map((tile, i) => renderTile(tile, i, 'b'))}</View>
          </Animated.View>
        </View>
      )}

      {summary.byEmployee.length > 0 ? (
        <View style={styles.breakdown}>
          <Text style={styles.breakdownTitle}>Hours by employee</Text>
          {summary.byEmployee.map((row) => (
            <View key={row.name} style={styles.breakdownRow}>
              <Text style={styles.breakdownName}>{row.name}</Text>
              <Text style={styles.breakdownHours}>{row.hours.toFixed(1)} h</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  viewport: {
    marginHorizontal: -spacing.lg,
    flexGrow: 0,
    overflow: 'hidden',
    paddingVertical: 2,
  },
  track: {
    flexDirection: 'row',
  },
  group: {
    flexDirection: 'row',
  },
  staticRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
  },
  tile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radii.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    minWidth: 132,
    // Trailing margin (not `gap`) so each copy of the track measures the same
    // width including its spacing — that's what keeps the loop seamless.
    marginRight: spacing.sm,
    ...shadows.card,
  },
  tileDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  tileText: {
    gap: 2,
  },
  tileLabel: {
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tileValue: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  breakdown: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    marginTop: spacing.sm,
    gap: 4,
    ...shadows.card,
  },
  breakdownTitle: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  breakdownName: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '600',
  },
  breakdownHours: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '700',
  },
});
