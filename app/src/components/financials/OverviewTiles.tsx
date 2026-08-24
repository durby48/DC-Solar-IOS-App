import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { AnimatedPressable, AppText, FadeInUp, StatTile } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';

/** One month's headline figures, computed by the Financials screen. */
export interface OverviewMonth {
  /** YYYY-MM. */
  ym: string;
  /** "August 2026". */
  label: string;
  paid: number;
  /** Expense entries only — wages are the labor figure, not an expense row. */
  expenses: number;
  /** Runs PAID this month + the open accrual when this is the current month. */
  labor: number;
  net: number;
}

/**
 * The company headline figures — ONE MONTH at a time (2026-08-23 redesign),
 * with ‹ › arrows to page into past months. Year-to-date lives in the
 * Pipeline money section below; this row answers "how did this month go".
 * Labor taps through to the payroll-by-month ledger.
 *
 * Labor sits next to Expenses on purpose: wages live in `employee_hours` and
 * `payroll_runs`, not `finance_entries`, and Net is the three together —
 * which is also why the expenses tile says "excluding labor".
 */
export function OverviewTiles({
  month,
  canPrev,
  canNext,
  onPrev,
  onNext,
}: {
  month: OverviewMonth;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const router = useRouter();
  const netPositive = month.net >= 0;

  const tiles: {
    label: string;
    value: number;
    prefix: string;
    tone: number;
    view?: string;
  }[] = [
    { label: 'Paid in', value: month.paid, prefix: '$', tone: 1 },
    { label: 'Expenses excluding labor', value: month.expenses, prefix: '$', tone: 4 },
    // Actual run withdrawals paid this month + the open period's accrual.
    { label: 'Labor incl. taxes', value: month.labor, prefix: '$', tone: 2, view: 'labor' },
    {
      label: 'Net',
      // Absolute value + an explicit sign in the prefix: `CountUp` formats a
      // negative as "-$1,234", and this column wants "−$1,234".
      value: Math.abs(month.net),
      prefix: netPositive ? '+$' : '−$',
      tone: netPositive ? 6 : 7,
    },
  ];

  return (
    <View style={styles.section}>
      <View style={styles.headerRow}>
        <View style={styles.headerTitle}>
          <Ionicons name="stats-chart" size={16} color={colors.oliveDeep} />
          <AppText variant="section" color={colors.ink}>
            {`Overview — ${month.label}`}
          </AppText>
        </View>
        <View style={styles.pager}>
          <AnimatedPressable
            onPress={onPrev}
            disabled={!canPrev}
            haptic="tapLight"
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Previous month"
            style={[styles.arrow, !canPrev && styles.arrowDisabled]}>
            <Ionicons
              name="chevron-back"
              size={16}
              color={canPrev ? colors.oliveDeep : colors.textMuted}
            />
          </AnimatedPressable>
          <AnimatedPressable
            onPress={onNext}
            disabled={!canNext}
            haptic="tapLight"
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Next month"
            style={[styles.arrow, !canNext && styles.arrowDisabled]}>
            <Ionicons
              name="chevron-forward"
              size={16}
              color={canNext ? colors.oliveDeep : colors.textMuted}
            />
          </AnimatedPressable>
        </View>
      </View>

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
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  headerTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 1,
  },
  pager: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  arrow: {
    width: 28,
    height: 28,
    borderRadius: radii.sm,
    backgroundColor: colors.oliveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowDisabled: {
    opacity: 0.4,
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
