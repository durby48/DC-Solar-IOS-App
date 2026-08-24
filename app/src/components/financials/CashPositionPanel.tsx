import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText, Card, ListRow, SectionHeader } from '@/components/ui';
import { colors, spacing } from '@/constants/theme';
import { formatShortDate } from '@/lib/dates';
import { formatRounded, formatSigned } from './format';

/** One ledger entry behind a reconciliation row (amount signed as displayed). */
export interface CashDetailEntry {
  id: string;
  occurred_on: string | null;
  label: string;
  amount: number;
}

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
  capitalEntries = [],
  owedEntries = [],
  adjustment,
}: {
  bankBalance: number | null;
  asOf: string | null;
  capital: number;
  owed: number;
  unpaidWages: number;
  inTransit: number;
  /** Who put the capital in, so the single figure can be broken out. */
  byPerson: { who: string; amount: number }[];
  /** The ledger entries behind "Less capital invested" — signed (returns negative). */
  capitalEntries?: CashDetailEntry[];
  /** The ledger entries behind "Less owed for out-of-pocket". */
  owedEntries?: CashDetailEntry[];
  /** Chase transactions recorded since the balance anchor, already applied. */
  adjustment?: { total: number; count: number };
}) {
  // Which reconciliation row is expanded to show its ledger entries.
  const [openDetail, setOpenDetail] = useState<string | null>(null);
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
  const rows: { label: string; amount: number; note?: string; detail?: CashDetailEntry[] }[] = [
    {
      label: 'Bank balance',
      amount: bankBalance,
      note:
        asOf && adjustment?.count
          ? `as of ${formatShortDate(asOf)} ${adjustment.total < 0 ? '−' : '+'} ${adjustment.count} Chase ${
              adjustment.count === 1 ? 'transaction' : 'transactions'
            } since`
          : asOf
            ? `as of ${formatShortDate(asOf)}`
            : undefined,
    },
    {
      label: 'Less capital invested',
      amount: -capital,
      note: 'contributed, never earned',
      detail: capitalEntries,
    },
    {
      label: 'Less owed for out-of-pocket',
      amount: -owed,
      note: 'spent, not yet paid back',
      detail: owedEntries,
    },
    { label: 'Less wages worked, unpaid', amount: -unpaidWages, note: 'earned by the crew + payroll taxes' },
    { label: 'Plus receipts in transit', amount: inTransit, note: 'earned, not yet deposited' },
  ];
  const visible = rows.filter((r) => r.amount !== 0 || r.label === 'Bank balance');

  return (
    <View style={styles.section}>
      <SectionHeader title="Cash position" icon="wallet" />
      <Card padded={false}>
        {visible.map((row, index) => {
          const expandable = (row.detail?.length ?? 0) > 0;
          const open = expandable && openDetail === row.label;
          return (
            <View key={row.label}>
              <ListRow
                title={row.label}
                subtitle={expandable ? `${row.note} · tap for detail` : row.note}
                chevron={false}
                divider={!open && index < visible.length - 1}
                onPress={
                  expandable
                    ? () => setOpenDetail(open ? null : row.label)
                    : undefined
                }
                right={
                  <AppText variant="bodyStrong" style={styles.amount}>
                    {formatSigned(row.amount)}
                  </AppText>
                }
              />
              {open ? (
                <View style={styles.detail}>
                  {row.detail!.map((entry) => (
                    <View key={entry.id} style={styles.detailRow}>
                      <AppText variant="caption" color={colors.textMuted} style={styles.detailDate}>
                        {entry.occurred_on ? formatShortDate(entry.occurred_on) : '—'}
                      </AppText>
                      <AppText
                        variant="caption"
                        color={colors.textSecondary}
                        style={styles.detailLabel}
                        numberOfLines={2}>
                        {entry.label}
                      </AppText>
                      <AppText variant="caption" style={styles.amount}>
                        {formatSigned(entry.amount)}
                      </AppText>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}

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
  detail: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: 3,
  },
  detailDate: {
    width: 52,
  },
  detailLabel: {
    flex: 1,
  },
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
