import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { AnimatedPressable, AppText, Card, Chip, FadeInUp, SectionHeader } from '@/components/ui';
import { colors, spacing } from '@/constants/theme';
import { formatRounded } from './format';

/** One project's profit line. Overhead and capital are NOT in here. */
export interface PnlRow {
  id: string;
  label: string;
  name: string;
  revenue: number;
  expenses: number;
  hours: number;
  labor: number;
  profit: number;
  pct: number | null;
  perHour: number | null;
}

/** The same shape, summed across every project. */
export interface PnlTotals {
  revenue: number;
  expenses: number;
  hours: number;
  labor: number;
  profit: number;
  pct: number | null;
  perHour: number | null;
}

function formatHours(hours: number): string {
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

function detailLine(row: {
  revenue: number;
  expenses: number;
  hours: number;
  labor: number;
}): string {
  return `Rev ${formatRounded(row.revenue)} · Exp ${formatRounded(row.expenses)} · ${formatHours(row.hours)} h · Labor ${formatRounded(row.labor)}`;
}

function profitLine(profit: number, perHour: number | null): string {
  const money = `${profit < 0 ? '−' : ''}${formatRounded(Math.abs(profit))}`;
  const rate =
    perHour !== null
      ? ` · ${perHour < 0 ? '−' : ''}${formatRounded(Math.abs(perHour))}/h worked`
      : '';
  return `Profit ${money}${rate}`;
}

function pctLabel(pct: number | null): string {
  return pct !== null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : '—';
}

function pctColor(pct: number | null): string {
  if (pct === null) return colors.textPrimary;
  return pct >= 0 ? colors.success : colors.danger;
}

/**
 * The collapsible per-job P&L sheet, plus the two figures that deliberately
 * sit OUTSIDE it: company overhead (a cost of running the business, charged
 * to no job) and capital invested (neither revenue nor cost).
 *
 * Every number, filter and warning is exactly what the screen showed before
 * the file was split — the warning line about payments misfiled under the
 * Company container included, because that money belongs on a project and
 * nothing else on the screen would tell you.
 */
export function PnlSheet({
  open,
  onToggle,
  rows,
  totals,
  companyOverhead,
  misfiled,
  capital,
}: {
  open: boolean;
  onToggle: () => void;
  rows: PnlRow[];
  totals: PnlTotals;
  companyOverhead: number;
  misfiled: { total: number; count: number };
  capital: {
    total: number;
    contributed: number;
    returned: number;
    byPerson: { who: string; amount: number }[];
  };
}) {
  const router = useRouter();

  return (
    <View style={styles.section}>
      {/* The hint is a sibling, not `SectionHeader`'s `action`: an action is
          itself a pressable, and nesting one inside this one would fire the
          toggle twice on web and leave the sheet exactly as it was. */}
      <AnimatedPressable
        onPress={onToggle}
        haptic="tapLight"
        scaleTo={0.995}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel="Per-job P and L"
        style={styles.toggleRow}>
        <SectionHeader
          title="Per-job P&L"
          icon={open ? 'chevron-down' : 'chevron-forward'}
          style={styles.toggleSection}
        />
        <AppText variant="caption" color={colors.textMuted}>
          {open ? 'Hide' : `${rows.length} jobs`}
        </AppText>
      </AnimatedPressable>

      {open ? (
        <Card padded={false}>
          {companyOverhead > 0 ? (
            <View style={[styles.row, styles.overheadRow]}>
              <View style={styles.topRow}>
                <AppText variant="section" color={colors.oliveDeep}>
                  Company overhead
                </AppText>
                <AppText variant="bodyStrong" style={styles.figure}>
                  {`−${formatRounded(companyOverhead)}`}
                </AppText>
              </View>
              <AppText variant="caption" color={colors.textMuted}>
                Not charged to any job — these are company costs, kept out of the per-job figures
                below.
              </AppText>
              {misfiled.count > 0 ? (
                <AppText variant="caption" color={colors.coralDeep} style={styles.misfiled}>
                  {`⚠ ${formatRounded(misfiled.total)} in ${
                    misfiled.count === 1 ? 'a payment' : `${misfiled.count} payments`
                  } is filed under Company. Company earns no revenue — open the payment in the ledger and assign it to its job.`}
                </AppText>
              ) : null}
            </View>
          ) : null}

          {capital.total > 0 ? (
            <View style={[styles.row, styles.capitalRow]}>
              <View style={styles.topRow}>
                <AppText variant="section" color={colors.tealDeep}>
                  Capital invested
                </AppText>
                <AppText variant="bodyStrong" color={colors.success} style={styles.figure}>
                  {`+${formatRounded(capital.total)}`}
                </AppText>
              </View>
              <AppText variant="caption" color={colors.textMuted} numberOfLines={2}>
                {capital.byPerson.map((p) => `${p.who} ${formatRounded(p.amount)}`).join(' · ')}
              </AppText>
              {capital.returned > 0 ? (
                <AppText variant="caption" color={colors.textMuted}>
                  {`${formatRounded(capital.contributed)} contributed · ${formatRounded(capital.returned)} taken back out`}
                </AppText>
              ) : null}
              <AppText variant="caption" color={colors.textMuted}>
                Money put into the business, net of anything withdrawn. Not revenue and not a cost
                — it is in none of the figures below.
              </AppText>
            </View>
          ) : null}

          <View style={[styles.row, styles.totalRow]}>
            <View style={styles.topRow}>
              <AppText variant="section" color={colors.ink}>
                All jobs
              </AppText>
              <AppText variant="bodyStrong" color={pctColor(totals.pct)} style={styles.figure}>
                {pctLabel(totals.pct)}
              </AppText>
            </View>
            <AppText
              variant="caption"
              color={colors.textSecondary}
              numberOfLines={1}
              style={styles.figure}>
              {detailLine(totals)}
            </AppText>
            <AppText variant="caption" numberOfLines={1} style={styles.figure}>
              {profitLine(totals.profit, totals.perHour)}
            </AppText>
          </View>

          {rows.map((row, index) => (
            <FadeInUp key={row.id} index={index}>
              <AnimatedPressable
                onPress={() => router.push({ pathname: '/job/[id]', params: { id: row.id } })}
                haptic="tapLight"
                scaleTo={0.99}
                accessibilityRole="button"
                accessibilityLabel={row.label}
                style={[styles.row, styles.rowBorder]}>
                <View style={styles.topRow}>
                  <Chip label={row.label} tone="olive" />
                  <AppText variant="bodyStrong" color={pctColor(row.pct)} style={styles.figure}>
                    {pctLabel(row.pct)}
                  </AppText>
                </View>
                <AppText
                  variant="caption"
                  color={colors.textSecondary}
                  numberOfLines={1}
                  style={styles.figure}>
                  {detailLine(row)}
                </AppText>
                {row.revenue > 0 ? (
                  <AppText variant="caption" numberOfLines={1} style={styles.figure}>
                    {profitLine(row.profit, row.perHour)}
                  </AppText>
                ) : null}
              </AnimatedPressable>
            </FadeInUp>
          ))}
        </Card>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: spacing.md,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  toggleSection: {
    flex: 1,
    marginBottom: spacing.sm,
  },
  row: {
    padding: spacing.md,
    gap: 4,
    backgroundColor: colors.surface,
  },
  rowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  figure: {
    fontVariant: ['tabular-nums'],
  },
  // Company overhead sits above the per-job rows and is visually separate from
  // them — it is a cost of running the business, not of running a job.
  overheadRow: {
    backgroundColor: colors.oliveTint,
  },
  // Capital in, distinct from both the per-job totals and overhead out.
  capitalRow: {
    backgroundColor: colors.tealSoft,
  },
  totalRow: {
    backgroundColor: colors.sunLight,
  },
  misfiled: {
    marginTop: spacing.xs,
  },
});
