import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { AnimatedPressable, FadeInUp, SectionHeader, StatTile } from '@/components/ui';
import { colors, spacing } from '@/constants/theme';
import type { FinancialsData } from '@/lib/financials';

/**
 * The company headline figures — CURRENT MONTH only (2026-08-23 redesign).
 * Year-to-date lives in the Pipeline money section below; this row answers
 * "how is this month going". Labor taps through to the payroll-by-month
 * ledger.
 *
 * Labor sits next to Expenses on purpose: wages live in `employee_hours` and
 * `payroll_runs`, not `finance_entries`, and Net is the three together.
 */
export function OverviewTiles({ data }: { data: FinancialsData }) {
  const router = useRouter();
  const netPositive = data.netThisMonth >= 0;

  const tiles: {
    label: string;
    value: number;
    prefix: string;
    tone: number;
    view?: string;
  }[] = [
    { label: 'Paid in this month', value: data.paidThisMonth, prefix: '$', tone: 1 },
    { label: 'Expenses this month', value: data.expensesThisMonth, prefix: '$', tone: 4 },
    // Actual run withdrawals paid this month + the open period's accrual.
    {
      label: 'Labor incl. taxes this month',
      value: data.laborThisMonth,
      prefix: '$',
      tone: 2,
      view: 'labor',
    },
    {
      label: 'Net this month',
      // Absolute value + an explicit sign in the prefix: `CountUp` formats a
      // negative as "-$1,234", and this column wants "−$1,234".
      value: Math.abs(data.netThisMonth),
      prefix: netPositive ? '+$' : '\u2212$',
      tone: netPositive ? 6 : 7,
    },
  ];

  return (
    <View style={styles.section}>
      <SectionHeader title="Overview — this month" icon="stats-chart" />
      <View style={styles.grid}>
        {tiles.map((tile, index) => (
          <FadeInUp key={tile.label} index={index} style={styles.cell}>
            {tile.view ? (
              <AnimatedPressable
                onPress={() => router.push(`/ledger/${tile.view}` as never)}
                haptic="tapLight"
                accessibilityRole="button"
                accessibilityLabel={`${tile.label}, open payroll ledger`}
                style={styles.pressable}>
                <StatTile
                  label={tile.label}
                  value={tile.value}
                  prefix={tile.prefix}
                  tone={tile.tone}
                  countUp
                  style={styles.tile}
                />
                <Ionicons
                  name="chevron-forward"
                  size={12}
                  color={colors.textMuted}
                  style={styles.chevron}
                />
              </AnimatedPressable>
            ) : (
              <StatTile
                label={tile.label}
                value={tile.value}
                prefix={tile.prefix}
                tone={tile.tone}
                countUp
                style={styles.tile}
              />
            )}
          </FadeInUp>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: spacing.md,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    // Negative gutters so the outer tiles sit flush with the page padding.
    marginHorizontal: -spacing.xs,
  },
  cell: {
    width: '50%',
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm,
  },
  pressable: {
    position: 'relative',
  },
  chevron: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
  },
  tile: {
    // The tile's own minWidth would blow out a 2-up grid on a small phone.
    minWidth: 0,
  },
});
