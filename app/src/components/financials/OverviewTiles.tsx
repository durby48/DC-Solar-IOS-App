import { StyleSheet, View } from 'react-native';

import { FadeInUp, SectionHeader, StatTile } from '@/components/ui';
import { spacing } from '@/constants/theme';
import type { FinancialsData } from '@/lib/financials';

/**
 * The six company headline figures.
 *
 * Was a white card of hand-styled `tileLabel`/`tileValue` pairs; each figure
 * is now a `StatTile` that counts up on load, so the page tells you it just
 * refetched without a spinner. The ONLY thing the tones encode is which
 * figure is which — except Net, where lime/rose carries the sign the old
 * green/red `netPositive`/`netNegative` text colors used to.
 *
 * Labor sits next to Expenses on purpose: wages live in `employee_hours`, not
 * `finance_entries`, and Net is the three of them together.
 */
export function OverviewTiles({ data }: { data: FinancialsData }) {
  const netPositive = data.net >= 0;

  const tiles: { label: string; value: number; prefix: string; tone: number }[] = [
    { label: 'Paid in', value: data.paid, prefix: '$', tone: 1 },
    { label: 'Expenses', value: data.expenses, prefix: '$', tone: 4 },
    // Loaded cost: gross wages × employer-tax burden (lib/laborCost.ts).
    { label: 'Labor incl. taxes', value: data.labor, prefix: '$', tone: 2 },
    {
      label: 'Net',
      // Absolute value + an explicit sign in the prefix: `CountUp` formats a
      // negative as "-$1,234", and this column wants "−$1,234".
      value: Math.abs(data.net),
      prefix: netPositive ? '+$' : '\u2212$',
      tone: netPositive ? 6 : 7,
    },
    { label: 'This month', value: data.expensesThisMonth, prefix: '$', tone: 5 },
    { label: 'Contracted YTD', value: data.contractedYtd, prefix: '$', tone: 0 },
  ];

  return (
    <View style={styles.section}>
      <SectionHeader title="Overview" icon="stats-chart" />
      <View style={styles.grid}>
        {tiles.map((tile, index) => (
          <FadeInUp key={tile.label} index={index} style={styles.cell}>
            <StatTile
              label={tile.label}
              value={tile.value}
              prefix={tile.prefix}
              tone={tile.tone}
              countUp
              style={styles.tile}
            />
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
  tile: {
    // The tile's own minWidth would blow out a 2-up grid on a small phone.
    minWidth: 0,
  },
});
