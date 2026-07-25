import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { fetchJobFinance, type JobFinanceSummary } from '@/lib/data';

function formatCurrency(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

/**
 * Admin-only strip of finance stat tiles for a job. Renders nothing while
 * loading or when the finance data can't be read (non-admin / RLS / offline)
 * — the parent should additionally gate on isAdmin. Bump `refreshKey` to
 * force a refetch (e.g. after a finance entry is edited or deleted).
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

  const tiles: { label: string; value: string }[] = [
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
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={styles.row}>
        {tiles.map((tile) => (
          <View key={tile.label} style={styles.tile}>
            <Text style={styles.tileLabel}>{tile.label}</Text>
            <Text style={styles.tileValue}>{tile.value}</Text>
          </View>
        ))}
      </ScrollView>

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
  scroll: {
    marginHorizontal: -spacing.lg,
    flexGrow: 0,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: 2,
  },
  tile: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    minWidth: 104,
    gap: 2,
    ...shadows.card,
  },
  tileLabel: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tileValue: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '800',
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
