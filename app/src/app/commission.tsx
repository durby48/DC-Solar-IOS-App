import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { AppText, Button, Card, ListRow, Screen } from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import {
  fetchCommissions,
  fetchCurrentPayPeriod,
  KIND_LABEL,
  markPeriodPaid,
  periodLabel,
  totalCents,
  type CommissionRow,
  type PayPeriod,
} from '@/lib/commission';
import { fetchEmployeeOptions } from '@/lib/myhours';
import { useRoleGate } from '@/lib/role';
import { formatCents } from '@/lib/servicePlans';

/**
 * `/commission` (2026-10-06, S4).
 *
 *   A sales rep — this pay period's commission, each payment behind it (first
 *   year / renewal / refund), and past periods with Paid / Not paid yet.
 *   An admin   — one pay period at a time (◄ ►), every rep's total and rows,
 *   and "Mark paid" once payroll has paid it, so nothing is paid twice.
 *
 * Rows come only from stripe-webhook (see lib/commission.ts); RLS decides who
 * sees which. The app works out what is owed — payroll still pays it.
 */
export default function CommissionScreen() {
  const gate = useRoleGate();
  const [rows, setRows] = useState<CommissionRow[] | null>(null);
  const [current, setCurrent] = useState<PayPeriod | null>(null);

  const load = useCallback(async () => {
    const [r, p] = await Promise.all([fetchCommissions(), fetchCurrentPayPeriod()]);
    setRows(r);
    setCurrent(p);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (rows === null || gate.phase === 'loading') {
    return (
      <Screen edges={[]}>
        <ActivityIndicator color={hubColors.crm.fg} style={styles.loading} />
      </Screen>
    );
  }
  return gate.role?.isAdmin ? (
    <AdminView rows={rows} current={current} myEmail={gate.role.email ?? null} onChanged={() => void load()} />
  ) : (
    <RepView rows={rows} current={current} />
  );
}

function CommissionLine({ row, divider, showRep }: { row: CommissionRow; divider: boolean; showRep?: string }) {
  return (
    <ListRow
      icon={row.kind === 'refund' ? 'return-down-back' : row.kind === 'renewal' ? 'refresh' : 'star'}
      iconColor={row.kind === 'refund' ? colors.danger : hubColors.crm.fg}
      iconBackground={row.kind === 'refund' ? colors.dangerSoft : hubColors.crm.bg}
      title={row.customerName ?? 'Customer'}
      subtitle={[
        showRep,
        KIND_LABEL[row.kind],
        `${formatCents(Math.abs(row.amountCents))} ${row.kind === 'refund' ? 'refunded' : 'paid'}`,
        new Date(`${row.occurredOn}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      ]
        .filter(Boolean)
        .join(' · ')}
      right={
        <AppText variant="bodyStrong" color={row.commissionCents < 0 ? colors.danger : colors.textPrimary}>
          {row.commissionCents < 0 ? '−' : ''}
          {formatCents(Math.abs(row.commissionCents))}
        </AppText>
      }
      chevron={false}
      divider={divider}
    />
  );
}

function Money({ cents }: { cents: number }) {
  return (
    <AppText variant="display" color={cents < 0 ? colors.danger : colors.textPrimary}>
      {cents < 0 ? '−' : ''}
      {formatCents(Math.abs(cents))}
    </AppText>
  );
}

function RepView({ rows, current }: { rows: CommissionRow[]; current: PayPeriod | null }) {
  const [openPeriod, setOpenPeriod] = useState<string | null>(null);
  const thisPeriod = rows.filter((r) => current && r.periodStart === current.start);
  const past = useMemo(() => {
    const map = new Map<string, CommissionRow[]>();
    for (const r of rows) {
      if (current && r.periodStart >= current.start) continue;
      map.set(r.periodStart, [...(map.get(r.periodStart) ?? []), r]);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [rows, current]);

  return (
    <Screen edges={[]} contentContainerStyle={styles.content}>
      <Card style={styles.hero}>
        <AppText variant="caption" color={colors.textSecondary}>
          This pay period{current ? ` · ${periodLabel(current.start, current.end)}` : ''}
        </AppText>
        <Money cents={totalCents(thisPeriod)} />
        <AppText variant="caption" color={colors.textSecondary}>
          {thisPeriod.length === 0
            ? 'Nothing yet. You earn 30% when a customer you sold pays, first year and every renewal.'
            : `${thisPeriod.length} ${thisPeriod.length === 1 ? 'payment' : 'payments'} · paid with this period's payroll`}
        </AppText>
      </Card>

      {thisPeriod.length > 0 ? (
        <Card padded={false}>
          {thisPeriod.map((r, i) => (
            <CommissionLine key={r.id} row={r} divider={i < thisPeriod.length - 1} />
          ))}
        </Card>
      ) : null}

      {past.length > 0 ? (
        <>
          <AppText variant="section" color={colors.textSecondary} style={styles.sectionTitle}>
            Past pay periods
          </AppText>
          <Card padded={false}>
            {past.map(([start, list], i) => {
              const paid = list.every((r) => r.paidAt);
              const open = openPeriod === start;
              return (
                <View key={start}>
                  <ListRow
                    icon={paid ? 'checkmark-circle' : 'time'}
                    iconColor={paid ? colors.mintDeep : colors.amberDeep}
                    iconBackground={paid ? colors.mintSoft : colors.amberSoft}
                    title={periodLabel(list[0].periodStart, list[0].periodEnd)}
                    subtitle={paid ? 'Paid' : 'Not paid yet'}
                    right={<AppText variant="bodyStrong">{formatCents(totalCents(list))}</AppText>}
                    onPress={() => setOpenPeriod(open ? null : start)}
                    divider={i < past.length - 1 || open}
                  />
                  {open ? list.map((r, j) => <CommissionLine key={r.id} row={r} divider={j < list.length - 1} />) : null}
                </View>
              );
            })}
          </Card>
        </>
      ) : null}
    </Screen>
  );
}

function AdminView({
  rows,
  current,
  myEmail,
  onChanged,
}: {
  rows: CommissionRow[];
  current: PayPeriod | null;
  myEmail: string | null;
  onChanged: () => void;
}) {
  // Periods that have rows, plus the current one, newest first.
  const periods = useMemo(() => {
    const map = new Map<string, PayPeriod>();
    if (current) map.set(current.start, current);
    for (const r of rows) map.set(r.periodStart, { start: r.periodStart, end: r.periodEnd });
    return [...map.values()].sort((a, b) => b.start.localeCompare(a.start));
  }, [rows, current]);
  const [index, setIndex] = useState(0);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void fetchEmployeeOptions().then((list) => setNames(new Map(list.map((e) => [e.email.toLowerCase(), e.name]))));
    }, []),
  );

  const period = periods[Math.min(index, periods.length - 1)] ?? null;
  const inPeriod = period ? rows.filter((r) => r.periodStart === period.start) : [];
  const byRep = useMemo(() => {
    const map = new Map<string, CommissionRow[]>();
    for (const r of inPeriod) map.set(r.repEmail, [...(map.get(r.repEmail) ?? []), r]);
    return [...map.entries()].sort((a, b) => totalCents(b[1]) - totalCents(a[1]));
  }, [inPeriod]);

  const pay = async (rep: string) => {
    if (!period) return;
    setBusy(rep);
    setError(null);
    const result = await markPeriodPaid(rep, period.start, myEmail);
    setBusy(null);
    if (result.ok) onChanged();
    else setError(result.message);
  };

  return (
    <Screen edges={[]} contentContainerStyle={styles.content}>
      <View style={styles.periodNav}>
        <Pressable
          onPress={() => setIndex((i) => Math.min(i + 1, periods.length - 1))}
          disabled={index >= periods.length - 1}
          hitSlop={10}
          accessibilityLabel="Earlier pay period">
          <Ionicons name="chevron-back" size={20} color={index >= periods.length - 1 ? colors.textMuted : colors.textPrimary} />
        </Pressable>
        <View style={styles.periodTitle}>
          <AppText variant="heading">{period ? periodLabel(period.start, period.end) : 'No pay periods yet'}</AppText>
          {period && current && period.start === current.start ? (
            <AppText variant="caption" color={colors.textSecondary}>
              Current pay period
            </AppText>
          ) : null}
        </View>
        <Pressable onPress={() => setIndex((i) => Math.max(i - 1, 0))} disabled={index === 0} hitSlop={10} accessibilityLabel="Later pay period">
          <Ionicons name="chevron-forward" size={20} color={index === 0 ? colors.textMuted : colors.textPrimary} />
        </Pressable>
      </View>

      <Card style={styles.hero}>
        <AppText variant="caption" color={colors.textSecondary}>
          Commission owed this period, all reps
        </AppText>
        <Money cents={totalCents(inPeriod)} />
      </Card>

      {byRep.length === 0 ? (
        <AppText variant="body" color={colors.textSecondary}>
          No commission in this pay period.
        </AppText>
      ) : (
        byRep.map(([rep, list]) => {
          const unpaid = list.some((r) => !r.paidAt);
          return (
            <Card key={rep} padded={false}>
              <View style={styles.repHead}>
                <View style={styles.repBody}>
                  <AppText variant="bodyStrong">{names.get(rep.toLowerCase()) ?? rep}</AppText>
                  <AppText variant="caption" color={unpaid ? colors.amberDeep : colors.mintDeep}>
                    {unpaid ? 'Not paid yet' : 'Paid'}
                  </AppText>
                </View>
                <AppText variant="heading">{formatCents(totalCents(list))}</AppText>
              </View>
              {list.map((r, i) => (
                <CommissionLine key={r.id} row={r} divider={i < list.length - 1} />
              ))}
              {unpaid ? (
                <View style={styles.payRow}>
                  <Button label="Mark paid" size="sm" loading={busy === rep} onPress={() => void pay(rep)} />
                </View>
              ) : null}
            </Card>
          );
        })
      )}
      {error ? (
        <AppText variant="caption" color={colors.danger}>
          {error}
        </AppText>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { width: '100%', maxWidth: 640, alignSelf: 'center', gap: spacing.md, paddingBottom: spacing.xl },
  loading: { marginVertical: spacing.xl },
  hero: { gap: spacing.xs, borderRadius: radii.md },
  sectionTitle: { marginTop: spacing.sm },
  periodNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  periodTitle: { alignItems: 'center' },
  repHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md },
  repBody: { flex: 1, gap: 2 },
  payRow: { padding: spacing.md, alignItems: 'flex-end' },
});
