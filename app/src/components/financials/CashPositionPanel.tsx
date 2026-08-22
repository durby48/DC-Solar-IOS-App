import { StyleSheet, View } from 'react-native';

import { AppText, Card, ListRow, SectionHeader } from '@/components/ui';
import { colors, spacing } from '@/constants/theme';
import { formatShortDate } from '@/lib/dates';
import { formatRounded, formatSigned } from './format';

/**
 * Cash position — why the bank balance is not the same number as profit.
 *
 * Each subtraction is money physically in the account that the business has not
 * earned, and each addition is money earned that has not arrived. Working down
 * the list turns a balance into profit retained, which is the figure most
 * people mean when they ask "how are we doing".
 *
 * The reconciliation is a grouped `ListRow` stack now: same rows, same order,
 * same arithmetic — it just reads as a statement instead of a wall of text.
 */
export function CashPositionPanel({
  bankBalance,
  asOf,
  capital,
  owed,
  unpaidWages,
  inTransit,
  byPerson,
}: {
  bankBalance: number | null;
  asOf: string | null;
  capital: number;
  owed: number;
  unpaidWages: number;
  inTransit: number;
  /** Who put the capital in, so the single figure can be broken out. */
  byPerson: { who: string; amount: number }[];
}) {
  if (bankBalance === null) {
    return (
      <View style={styles.section}>
        <SectionHeader title="Cash position" icon="wallet" />
        <Card>
          <AppText variant="body" color={colors.textMuted}>
            No bank balance recorded yet. Add one and this panel will reconcile it against the
            ledger.
          </AppText>
        </Card>
      </View>
    );
  }

  const profitRetained = bankBalance - capital - owed - unpaidWages + inTransit;
  const rows: { label: string; amount: number; note?: string }[] = [
    {
      label: 'Bank balance',
      amount: bankBalance,
      note: asOf ? `as of ${formatShortDate(asOf)}` : undefined,
    },
    { label: 'Less capital invested', amount: -capital, note: 'contributed, never earned' },
    { label: 'Less owed for out-of-pocket', amount: -owed, note: 'spent, not yet paid back' },
    { label: 'Less wages worked, unpaid', amount: -unpaidWages, note: 'earned by the crew' },
    { label: 'Plus receipts in transit', amount: inTransit, note: 'earned, not yet deposited' },
  ];
  const visible = rows.filter((r) => r.amount !== 0 || r.label === 'Bank balance');

  return (
    <View style={styles.section}>
      <SectionHeader title="Cash position" icon="wallet" />
      <Card padded={false}>
        {visible.map((row, index) => (
          <ListRow
            key={row.label}
            title={row.label}
            subtitle={row.note}
            chevron={false}
            divider={index < visible.length - 1}
            right={
              <AppText variant="bodyStrong" style={styles.amount}>
                {formatSigned(row.amount)}
              </AppText>
            }
          />
        ))}

        {byPerson.length ? (
          <View style={styles.breakdown}>
            <AppText variant="caption" color={colors.textMuted}>
              {`Invested: ${byPerson.map((p) => `${p.who} ${formatRounded(p.amount)}`).join(' \u00b7 ')}`}
            </AppText>
          </View>
        ) : null}

        <View style={styles.totalRow}>
          <AppText variant="bodyStrong" color={colors.oliveDeep}>
            Profit retained
          </AppText>
          <AppText
            variant="numeric"
            color={profitRetained >= 0 ? colors.success : colors.danger}>
            {formatRounded(profitRetained)}
          </AppText>
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: spacing.md,
  },
  amount: {
    fontVariant: ['tabular-nums'],
  },
  breakdown: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surface,
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    backgroundColor: colors.oliveTint,
  },
});
