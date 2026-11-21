import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, View } from 'react-native';

import { formatMoney, formatRounded, formatSigned } from '@/components/financials/format';
import { LegacyFinancials } from '@/components/financials/LegacyFinancials';
import { AnimatedPressable, AppText, Button, Card, Chip, EmptyState, SectionHeader, StatTile } from '@/components/ui';
import { colors, hubColors, spacing } from '@/constants/theme';
import { useAdminOnlyScreen } from '@/lib/adminGate';
import { todayISO } from '@/lib/dates';
import { syncFinanceWidget } from '@/lib/financeWidget';
import {
  fetchBooksOverview,
  fetchJobPnl,
  fetchUntaggedLines,
  previewAppMatches,
  type BooksOverview,
  type JobPnl,
  type ReportNode,
} from '@/lib/qboBooks';

/**
 * Financials — a mirror of QuickBooks (2026-11-21, Devon).
 *
 * QuickBooks is the system of record. Every figure here is QuickBooks'
 * own (cash basis), read live through the `qbo-books` edge function:
 * headline P&L, month by month, profit and loss per job (project), the
 * balance sheet and what customers owe. Nothing in this view is computed
 * from the app's ledger.
 *
 * The app-ledger Financials (cash bridge, pipeline tiles, expense and
 * receivables ledgers, assets) sits underneath, behind a "Show app ledger"
 * switch that is remembered on the device.
 *
 * Nothing is tagged to a job automatically (Devon): the screen only COUNTS
 * expenses without a job and app receipts that match a bank-feed line; Devon
 * confirms each one on /books-jobs (or does it in QuickBooks).
 */

const LEDGER_KEY = 'financials.showAppLedger';

export default function FinancialsScreen() {
  const gate = useAdminOnlyScreen();
  const [showLedger, setShowLedger] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    AsyncStorage.getItem(LEDGER_KEY)
      .then((v) => setShowLedger(v === '1'))
      .catch(() => {});
  }, []);
  const toggleLedger = (next: boolean) => {
    setShowLedger(next);
    AsyncStorage.setItem(LEDGER_KEY, next ? '1' : '0').catch(() => {});
  };

  if (gate.blocked) return null;
  return (
    <>
      <Stack.Screen options={{ title: 'Financials' }} />
      <LegacyFinancials
        visible={showLedger}
        onRefreshTop={() => setRefreshKey((k) => k + 1)}
        top={
          gate.phase === 'ready' && gate.isAdmin ? (
            <View style={styles.content}>
              <QboMirror refreshKey={refreshKey} />
              <Card style={styles.toggleCard}>
                <View style={styles.flex}>
                  <AppText variant="bodyStrong">Show app ledger</AppText>
                  <AppText variant="caption" color={colors.textSecondary}>
                    The app's own books: cash bridge, pipeline totals, expense and payment ledgers, assets.
                  </AppText>
                </View>
                <Switch value={showLedger} onValueChange={toggleLedger} />
              </Card>
            </View>
          ) : null
        }
      />
    </>
  );
}

type PeriodKey = 'month' | 'quarter' | 'ytd' | 'all';
const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'month', label: 'This month' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'ytd', label: 'Year to date' },
  { key: 'all', label: 'Since books start' },
];

function periodRange(key: PeriodKey): { start: string; end: string } {
  const end = todayISO();
  const y = end.slice(0, 4);
  const m = Number(end.slice(5, 7));
  if (key === 'month') return { start: `${end.slice(0, 7)}-01`, end };
  if (key === 'quarter') return { start: `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`, end };
  if (key === 'ytd') return { start: `${y}-01-01`, end };
  return { start: '2026-06-26', end };
}

function QboMirror({ refreshKey }: { refreshKey: number }) {
  const [period, setPeriod] = useState<PeriodKey>('ytd');
  const [overview, setOverview] = useState<BooksOverview | null>(null);
  const [jobs, setJobs] = useState<JobPnl[] | null>(null);
  const [needsJob, setNeedsJob] = useState<number | null>(null);
  const [matchNote, setMatchNote] = useState<string | null>(null);
  const [toConfirm, setToConfirm] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [showAllJobs, setShowAllJobs] = useState(false);

  const load = useCallback(async (key: PeriodKey) => {
    setLoading(true);
    setError(null);
    const { start, end } = periodRange(key);
    // Dry run only: count app receipts that fit a bank-feed line. Devon confirms them on /books-jobs.
    const [o, j, u, match] = await Promise.all([
      fetchBooksOverview(start, end),
      fetchJobPnl(start, end),
      fetchUntaggedLines(start, end),
      previewAppMatches(),
    ]);
    if (match.ok) {
      const n = match.value.matched.length + match.value.ambiguous.length;
      const w = match.value.waiting.length;
      const parts = [
        n ? `${n} app receipt${n === 1 ? '' : 's'} ready to match to bank lines` : null,
        w ? `${w} waiting for the bank feed` : null,
      ].filter(Boolean);
      setMatchNote(parts.length ? parts.join(' · ') : null);
      setToConfirm(n);
    }
    if (o.ok) {
      setOverview(o.value);
      // Keep the home-screen widget in step with what Devon just looked at.
      void syncFinanceWidget(true);
    } else setError(o.message);
    if (j.ok) setJobs(j.value);
    if (u.ok) setNeedsJob(u.value.lines.length);
    setLoadedAt(new Date());
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load(period);
    }, [load, period, refreshKey]),
  );

  const sortedJobs = useMemo(
    () => [...(jobs ?? [])].sort((a, b) => Number(Boolean(b.jobId)) - Number(Boolean(a.jobId)) || b.income - a.income),
    [jobs],
  );

  const h = overview?.headline;
  const margin = h && h.income ? Math.round((h.netIncome / h.income) * 1000) / 10 : null;

  return (
    <View style={styles.content}>

      <View style={styles.chips}>
        {PERIODS.map((p) => (
          <Chip key={p.key} label={p.label} selected={period === p.key} tone="olive" onPress={() => setPeriod(p.key)} />
        ))}
      </View>

      <View style={styles.sourceRow}>
        <Ionicons name="link" size={14} color={colors.textMuted} />
        <AppText variant="caption" color={colors.textMuted} style={styles.flex}>
          Live from QuickBooks · cash basis{loadedAt ? ` · ${loadedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}
        </AppText>
        {loading ? <ActivityIndicator size="small" color={hubColors.systems.fg} /> : null}
      </View>

      {error ? (
        <Card style={styles.errorCard}>
          <AppText variant="bodyStrong">Could not read QuickBooks</AppText>
          <AppText variant="caption" color={colors.textSecondary}>{error}</AppText>
          <View style={styles.buttonRow}>
            <Button label="Try again" size="sm" onPress={() => void load(period)} />
            <Button label="QuickBooks connection" size="sm" variant="secondary" onPress={() => router.push('/quickbooks' as never)} />
          </View>
        </Card>
      ) : null}

      {!overview && !error ? (
        <ActivityIndicator color={hubColors.systems.fg} style={styles.loading} />
      ) : null}

      {h ? (
        <>
          <View style={styles.tiles}>
            <StatTile label="Income" value={h.income} prefix="$" tone={1} style={styles.tile} />
            <StatTile label="Net profit" value={h.netIncome} prefix="$" tone="olive" note={margin != null ? `${margin}% of income` : undefined} style={styles.tile} />
            <StatTile label="Job costs" value={h.cogs} prefix="$" tone={3} compact style={styles.tileThird} />
            <StatTile label="Overhead" value={h.expenses} prefix="$" tone={4} compact style={styles.tileThird} />
            <StatTile label="Gross profit" value={h.grossProfit} prefix="$" tone={2} compact style={styles.tileThird} />
            <StatTile label="In the bank" value={h.bank} prefix="$" tone={5} note={`as of ${overview!.period.end}`} style={styles.tile} />
            <StatTile label="Customers owe" value={h.receivables} prefix="$" tone={6} style={styles.tile} />
            <StatTile
              label="Company value"
              value={h.equity}
              prefix="$"
              tone="olive"
              note="Equity on the balance sheet (what the company owns minus what it owes)"
              style={styles.tileWide}
            />
          </View>

          {matchNote ? (
            <AppText variant="caption" color={colors.textSecondary} style={styles.matchNote}>{matchNote}</AppText>
          ) : null}

          {needsJob || toConfirm ? (
            <AnimatedPressable onPress={() => router.push('/books-jobs' as never)}>
              <Card style={styles.alertCard}>
                <Ionicons name="pricetags" size={20} color={colors.amber} />
                <View style={styles.flex}>
                  <AppText variant="bodyStrong">
                    {[
                      needsJob ? `${needsJob} expense${needsJob === 1 ? '' : 's'} with no job` : null,
                      toConfirm ? `${toConfirm} app receipt${toConfirm === 1 ? '' : 's'} to match` : null,
                    ].filter(Boolean).join(' · ')}
                  </AppText>
                  <AppText variant="caption" color={colors.textSecondary}>
                    Pick a job (or overhead) for each one — here or in QuickBooks.
                  </AppText>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
              </Card>
            </AnimatedPressable>
          ) : null}

          <SectionHeader title="Month by month" icon="calendar" />
          <Card padded={false}>
            <View style={[styles.tableRow, styles.tableHead]}>
              <AppText variant="caption" color={colors.textMuted} style={styles.cellLabel}>Month</AppText>
              <AppText variant="caption" color={colors.textMuted} style={styles.cell}>Income</AppText>
              <AppText variant="caption" color={colors.textMuted} style={styles.cell}>Costs</AppText>
              <AppText variant="caption" color={colors.textMuted} style={styles.cell}>Net</AppText>
            </View>
            {overview!.months.map((m) => (
              <View key={m.title} style={styles.tableRow}>
                <AppText variant="body" style={styles.cellLabel}>{m.title}</AppText>
                <AppText variant="numeric" style={styles.cell}>{formatRounded(m.income)}</AppText>
                <AppText variant="numeric" style={styles.cell}>{formatRounded(m.cogs + m.expenses)}</AppText>
                <AppText variant="numeric" color={m.net < 0 ? colors.danger : colors.olive} style={styles.cell}>{formatSigned(m.net)}</AppText>
              </View>
            ))}
          </Card>

          <SectionHeader
            title="Profit by job"
            subtitle="QuickBooks P&L by project"
            icon="construct"
            action={sortedJobs.length > 8 ? { label: showAllJobs ? 'Fewer' : `All ${sortedJobs.length}`, onPress: () => setShowAllJobs((v) => !v) } : undefined}
          />
          {sortedJobs.length ? (
            <Card padded={false}>
              {(showAllJobs ? sortedJobs : sortedJobs.slice(0, 8)).map((j) => (
                <Pressable
                  key={j.qboId ?? j.title}
                  disabled={!j.jobId}
                  onPress={() => j.jobId && router.push({ pathname: '/job/[id]', params: { id: j.jobId } })}
                  style={({ pressed }) => [styles.jobRow, pressed && styles.pressed]}>
                  <View style={styles.flex}>
                    <AppText variant="bodyStrong" numberOfLines={1}>{j.title}</AppText>
                    <AppText variant="caption" color={colors.textMuted}>
                      {[j.stage, `in ${formatRounded(j.income)}`, `costs ${formatRounded(j.cogs + j.expenses)}`].filter(Boolean).join(' · ')}
                    </AppText>
                  </View>
                  <View style={styles.right}>
                    <AppText variant="numeric" color={j.net < 0 ? colors.danger : colors.olive}>{formatSigned(j.net)}</AppText>
                    {j.marginPct != null ? <AppText variant="caption" color={colors.textMuted}>{j.marginPct}%</AppText> : null}
                  </View>
                </Pressable>
              ))}
            </Card>
          ) : (
            <EmptyState icon="construct" title="No job activity" body="Nothing was booked to a project in this period." />
          )}

          <SectionHeader title="Balance sheet" subtitle={`as of ${overview!.period.end}`} icon="business" />
          <Card padded={false}>
            <ReportTree rows={overview!.balanceSheet.rows} />
          </Card>

          <SectionHeader title="Profit & loss" subtitle="every account, this period" icon="document-text" />
          <Card padded={false}>
            <ReportTree rows={overview!.pnl.rows} lastColumnOnly />
          </Card>
        </>
      ) : null}
    </View>
  );
}

/** A QuickBooks report as collapsible sections; the figure shown is the Total column. */
function ReportTree({ rows, depth = 0, lastColumnOnly = true }: { rows: ReportNode[]; depth?: number; lastColumnOnly?: boolean }) {
  return (
    <>
      {rows.map((r, i) => (
        <ReportRow key={`${r.label}-${i}`} node={r} depth={depth} lastColumnOnly={lastColumnOnly} />
      ))}
    </>
  );
}

function ReportRow({ node, depth, lastColumnOnly }: { node: ReportNode; depth: number; lastColumnOnly: boolean }) {
  const [open, setOpen] = useState(depth === 0);
  const hasKids = !!node.children?.length;
  const value = lastColumnOnly ? node.values.at(-1) ?? 0 : node.values[0] ?? 0;
  if (!node.label && !hasKids) return null;
  return (
    <>
      <Pressable
        disabled={!hasKids}
        onPress={() => setOpen((v) => !v)}
        style={[styles.reportRow, { paddingLeft: spacing.md + depth * spacing.md }]}>
        {hasKids ? (
          <Ionicons name={open ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.textMuted} />
        ) : (
          <View style={styles.chevronSpace} />
        )}
        <AppText variant={depth === 0 || node.total ? 'bodyStrong' : 'body'} style={styles.flex} numberOfLines={1}>
          {node.label}
        </AppText>
        {!hasKids || !open ? <AppText variant="numeric">{formatMoney(value)}</AppText> : null}
      </Pressable>
      {hasKids && open ? <ReportTree rows={node.children!} depth={depth + 1} lastColumnOnly={lastColumnOnly} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.md, paddingBottom: spacing.lg },
  toggleCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  sourceRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  flex: { flex: 1 },
  loading: { marginTop: spacing.xl },
  errorCard: { gap: spacing.sm, borderColor: colors.danger, borderWidth: 1 },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: { flexBasis: '48%', flexGrow: 1 },
  tileThird: { flexBasis: '30%', flexGrow: 1 },
  tileWide: { flexBasis: '100%' },
  matchNote: { marginTop: -spacing.xs },
  alertCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderColor: colors.amber, borderWidth: 1 },
  tableRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  tableHead: { paddingVertical: spacing.xs },
  cellLabel: { flex: 1.2 },
  cell: { flex: 1, textAlign: 'right' },
  jobRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  pressed: { opacity: 0.6 },
  right: { alignItems: 'flex-end' },
  reportRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingRight: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  chevronSpace: { width: 14 },
});

// A render error replaces only this screen; the header / tab bar stay (2026-11-08).
export { ScreenErrorBoundary as ErrorBoundary } from '@/components/ScreenErrorBoundary';
