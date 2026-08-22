import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Ticker } from '@/components/Ticker';
import { AppText, Card, SectionHeader } from '@/components/ui';
import { accentCycle, colors, radii, spacing } from '@/constants/theme';
import { fetchJobFinance, type JobFinanceSummary } from '@/lib/data';

function formatCurrency(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

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
 * The strip is a continuously looping stock-style ticker; the marquee itself
 * lives in components/Ticker.tsx and is shared with the pipeline hero.
 *
 * 2026-08-22: each tile is now FILLED from `accentCycle` instead of being a
 * white card with a colored dot. Six white cards sliding past each other read
 * as one long bar; six tinted ones read as six figures, which is the point of
 * a ticker. The values stay plain text on purpose — `Ticker` renders its item
 * list twice to make the loop seamless, so a `CountUp` here would mount two
 * animations racing for the same number.
 */
export function JobFinanceHeader({
  jobId,
  refreshKey = 0,
}: {
  jobId: string;
  refreshKey?: number;
}) {
  const [summary, setSummary] = useState<JobFinanceSummary | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchJobFinance(jobId).then((result) => {
      if (!cancelled) setSummary(result);
    });
    return () => {
      cancelled = true;
    };
  }, [jobId, refreshKey]);

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

  return (
    <View>
      <Ticker
        style={styles.viewport}
        items={tiles.map((tile, index) => {
          const accent = accentCycle[index % accentCycle.length];
          return (
            <View style={[styles.tile, { backgroundColor: accent.bg }]}>
              <View style={[styles.tileDot, { backgroundColor: accent.fg }]} />
              <View style={styles.tileText}>
                <AppText variant="section" color={accent.fg}>
                  {tile.label}
                </AppText>
                <AppText variant="bodyStrong" style={styles.tileValue}>
                  {tile.value}
                </AppText>
              </View>
            </View>
          );
        })}
      />

      {summary.byEmployee.length > 0 ? (
        <Card style={styles.breakdown}>
          <SectionHeader title="Hours by employee" icon="people" style={styles.breakdownTitle} />
          {summary.byEmployee.map((row) => (
            <View key={row.name} style={styles.breakdownRow}>
              <AppText variant="body">{row.name}</AppText>
              <AppText variant="bodyStrong" color={colors.textSecondary} style={styles.tileValue}>
                {row.hours.toFixed(1)} h
              </AppText>
            </View>
          ))}
        </Card>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  viewport: {
    // Full-bleed past the screen's horizontal padding.
    marginHorizontal: -spacing.lg,
    paddingVertical: 2,
  },
  tile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderRadius: radii.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    minWidth: 132,
    // Trailing margin (not `gap`) so both ticker copies measure identically.
    marginRight: spacing.sm,
  },
  tileDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  tileText: {
    gap: 2,
  },
  tileValue: {
    fontVariant: ['tabular-nums'],
  },
  breakdown: {
    marginTop: spacing.sm,
    gap: 4,
  },
  breakdownTitle: {
    marginBottom: 2,
  },
  breakdownRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});
