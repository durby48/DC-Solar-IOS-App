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
export function MirrorTiles({ totals }: { totals: CompanyTotals }) {
  const router = useRouter();
  const pnl = totals.avgProfitPct;

  const tiles: { label: string; amount: number; view: string; tone: number; note?: string }[] = [
    {
      label: 'Estimates',
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
    { label: 'Contracted', amount: totals.contracted, view: 'contracted', tone: 2 },
    { label: 'Invoiced', amount: totals.invoiced, view: 'invoices', tone: 5 },
    { label: 'Paid', amount: totals.paid, view: 'paid', tone: 1 },
  ];

  return (
    <View style={styles.section}>
      <SectionHeader title="Pipeline money" icon="trending-up" />

      <View style={styles.grid}>
        {tiles.map((tile, index) => (
          <FadeInUp key={tile.label} index={index} style={styles.cell}>
            <AnimatedPressable
              onPress={() => router.push(`/ledger/${tile.view}` as never)}
              haptic="tapLight"
              accessibilityRole="button"
              accessibilityLabel={`${tile.label}, open ledger`}
              style={styles.pressable}>
              <StatTile
                label={tile.label}
                value={tile.amount}
                prefix="$"
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
