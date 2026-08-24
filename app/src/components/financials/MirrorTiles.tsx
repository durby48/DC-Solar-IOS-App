import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { AnimatedPressable, AppText, Card, CountUp, FadeInUp, SectionHeader, StatTile } from '@/components/ui';
import { colors, spacing } from '@/constants/theme';
import type { CompanyTotals } from '@/lib/pipeline';

/**
 * Pipeline-mirror tiles: the exact four numbers from the Pipeline header,
 * each one tappable through to its company-wide drill-down ledger.
 *
 * The tiles are `StatTile`s wrapped in an `AnimatedPressable` rather than
 * pressable tiles of their own — the spring under the finger plus the corner
 * chevron is what says "this goes somewhere", and it means the tile itself
 * stays the same component the Overview row uses.
 */
export function MirrorTiles({
  totals,
  expensesYtd,
  laborYtd,
}: {
  totals: CompanyTotals;
  /** All-2026 expense total from the Financials rollup. */
  expensesYtd: number;
  /** All-2026 loaded labor (actual runs + open accrual). */
  laborYtd: number;
}) {
  const router = useRouter();
  const pnl = totals.avgProfitPct;

  const tiles: {
    label: string;
    amount: number;
    view: string | null;
    tone: number;
    note?: string;
  }[] = [
    {
      label: 'Estimates YTD',
      amount: totals.estimates,
      view: 'estimates',
      tone: 3,
      // Spelled out because otherwise deleting a superseded estimate looks
      // like a broken total: only each job's NEWEST estimate is counted.
      note:
        totals.estimateCount > totals.estimateJobs
          ? `newest of ${totals.estimateCount} on ${totals.estimateJobs} jobs`
          : `${totals.estimateCount} on file`,
    },
    { label: 'Contracted YTD', amount: totals.contracted, view: 'contracted', tone: 2 },
    { label: 'Invoiced YTD', amount: totals.invoiced, view: 'invoices', tone: 5 },
    { label: 'Paid in YTD', amount: totals.paid, view: 'paid', tone: 1 },
    // The drill-down for expenses is the ledger at the bottom of the tab.
    { label: 'Expenses YTD (excl. labor)', amount: expensesYtd, view: null, tone: 4 },
    { label: 'Labor incl. taxes YTD', amount: laborYtd, view: 'labor', tone: 2 },
  ];

  return (
    <View style={styles.section}>
      <SectionHeader title="Pipeline money" icon="trending-up" />

      <View style={styles.grid}>
        {tiles.map((tile, index) => (
          <FadeInUp key={tile.label} index={index} style={styles.cell}>
            <AnimatedPressable
              onPress={tile.view ? () => router.push(`/ledger/${tile.view}` as never) : undefined}
              disabled={!tile.view}
              haptic="tapLight"
              accessibilityRole="button"
              accessibilityLabel={tile.view ? `${tile.label}, open ledger` : tile.label}
              style={styles.pressable}>
              <StatTile
                label={tile.label}
                value={tile.amount}
                prefix="$"
                tone={tile.tone}
                countUp
                style={styles.tile}
              />
              {tile.view ? (
                <Ionicons
                  name="chevron-forward"
                  size={12}
                  color={colors.textMuted}
                  style={styles.chevron}
                />
              ) : null}
              {tile.note ? (
                <AppText variant="caption" color={colors.textMuted} style={styles.note}>
                  {tile.note}
                </AppText>
              ) : null}
            </AnimatedPressable>
          </FadeInUp>
        ))}
      </View>

      <Card tone="sunk" style={styles.profitCard}>
        <View>
          <AppText variant="section" color={colors.textMuted}>
            Avg Profit
          </AppText>
          <AppText variant="caption" color={colors.textMuted}>
            completed jobs
          </AppText>
        </View>
        {pnl !== null ? (
          <CountUp
            value={pnl}
            decimals={1}
            prefix={pnl >= 0 ? '+' : ''}
            suffix="%"
            style={{ color: pnl >= 0 ? colors.success : colors.danger }}
          />
        ) : (
          <AppText variant="numeric" color={colors.textMuted}>
            {'\u2014'}
          </AppText>
        )}
      </Card>
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
    marginHorizontal: -spacing.xs,
  },
  cell: {
    width: '50%',
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm,
  },
  pressable: {
    // The chevron is positioned against this box, so it has to be the tile's
    // own bounds and nothing larger.
    alignSelf: 'stretch',
  },
  tile: {
    minWidth: 0,
  },
  chevron: {
    position: 'absolute',
    top: spacing.sm + 2,
    right: spacing.sm + 2,
  },
  note: {
    paddingTop: 2,
    paddingHorizontal: spacing.xs,
  },
  profitCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
});
