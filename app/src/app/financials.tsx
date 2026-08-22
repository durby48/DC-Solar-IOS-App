import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, SectionList, StyleSheet, View } from 'react-native';

import { CashPositionPanel } from '@/components/financials/CashPositionPanel';
import {
  ExpenseForm,
  ExpenseRow,
  MonthHeader,
  type JobOption,
} from '@/components/financials/ExpenseLedger';
import { formatMoney } from '@/components/financials/format';
import { MirrorTiles } from '@/components/financials/MirrorTiles';
import { OverviewTiles } from '@/components/financials/OverviewTiles';
import { PnlSheet, type PnlRow } from '@/components/financials/PnlSheet';
import { AppText, Button, Card, EmptyState, SectionHeader, SkeletonList } from '@/components/ui';
import { colors, spacing } from '@/constants/theme';
import { todayISO } from '@/lib/dates';
import { deleteFinanceEntry, updateFinanceEntry } from '@/lib/documents';
import {
  fetchFinancials,
  groupExpensesByMonth,
  recordExpense,
  type FinancialsData,
  type LedgerEntry,
} from '@/lib/financials';
import {
  fetchCompanySettings,
  fetchUnpaidWages,
  type CompanySettings,
} from '@/lib/cashPosition';
import * as haptics from '@/lib/haptics';
import { type Job } from '@/lib/types';
import { isCompanyJob } from '@/lib/stages';
import {
  fetchCompanyTotals,
  fetchLaborHoursByJob,
  fetchPipelineJobs,
  type CompanyTotals,
  type JobLaborHours,
} from '@/lib/pipeline';
import { useRole } from '@/lib/role';
import { isValidISODate } from '@/lib/time';

/**
 * Financials — every dollar the company has taken in, paid out, or is still
 * owed, plus the itemized expense ledger.
 *
 * 2026-08-22: the screen was 1,600 lines of hand-rolled cards and it is now
 * a composition of four panels under `components/financials/`:
 *
 *   OverviewTiles      the six headline figures
 *   MirrorTiles        the pipeline totals, each tappable to its ledger
 *   CashPositionPanel  bank balance reconciled down to profit retained
 *   PnlSheet           the collapsible per-job P&L, overhead and capital
 *   ExpenseLedger      the add-expense form, the month headers and the rows
 *
 * Nothing about WHAT is shown moved: the same queries, the same admin gate,
 * the same arithmetic, the same Company-overhead warning. Only the drawing
 * changed, and it changed by deleting local styles rather than restyling them.
 */
export default function FinancialsScreen() {
  const role = useRole();

  const [data, setData] = useState<FinancialsData | null>(null);
  const [totals, setTotals] = useState<CompanyTotals | null>(null);
  const [jobsFull, setJobsFull] = useState<Job[]>([]);
  const [laborMap, setLaborMap] = useState<Map<string, JobLaborHours> | null>(null);
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [unpaidWages, setUnpaidWages] = useState(0);
  // Collapsible sections: the per-job P&L sheet and each expense month.
  const [pnlOpen, setPnlOpen] = useState(false);
  const [openMonths, setOpenMonths] = useState<Set<string>>(new Set());
  const [monthsInitialized, setMonthsInitialized] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [jobOptions, setJobOptions] = useState<JobOption[]>([]);
  // The DC Solar Company container job (flagged is_internal). "Company"
  // expenses are tagged to it rather than left with a null job_id, so there is
  // exactly ONE way to say "this is overhead" (2026-08-05).
  const [companyJobId, setCompanyJobId] = useState<string | null>(null);
  const [jobLabels, setJobLabels] = useState<Map<string, string>>(new Map());
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );

  // Add-expense form.
  const [formOpen, setFormOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [paidTo, setPaidTo] = useState('');
  const [date, setDate] = useState(todayISO());
  const [jobId, setJobId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Inline row editing + two-tap delete (same behavior as JobInvoices).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editJobId, setEditJobId] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (role?.isAdmin) {
      const [financials, { jobs }, labor] = await Promise.all([
        fetchFinancials(),
        fetchPipelineJobs(),
        fetchLaborHoursByJob(),
      ]);
      const companySettings = await fetchCompanySettings();
      setSettings(companySettings);
      setUnpaidWages(await fetchUnpaidWages(companySettings?.payrollThrough ?? null));
      setData(financials);
      setLaborMap(labor);
      // Same math as the Pipeline header, fed by the same rows we just got.
      setTotals(financials ? await fetchCompanyTotals(jobs, financials.allEntries) : null);
      setJobsFull(jobs);
      const container =
        jobs.find((j) => (j as unknown as { is_internal?: boolean }).is_internal) ?? null;
      setCompanyJobId(container?.id ?? null);
      // Keep the container out of the job list — it has its own chip.
      setJobOptions(
        jobs
          .filter((j) => j.id !== container?.id)
          .map((j) => ({ id: j.id, label: j.job_number ?? j.name })),
      );
      setJobLabels(new Map(jobs.map((j) => [j.id, j.job_number ?? j.name])));
    } else {
      setData(null);
      setTotals(null);
      setJobsFull([]);
      setLaborMap(null);
    }
    setLoaded(true);
  }, [role]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  // Expense months are collapsible: a closed month contributes no rows.
  const monthGroups = useMemo(
    () => (data ? groupExpensesByMonth(data.expenseEntries) : []),
    [data],
  );

  // Open the newest month by default, once, on first load.
  useEffect(() => {
    if (monthsInitialized || monthGroups.length === 0) return;
    setOpenMonths(new Set([monthGroups[0].key]));
    setMonthsInitialized(true);
  }, [monthGroups, monthsInitialized]);

  const sections = useMemo(
    () =>
      monthGroups.map((month) => ({
        ...month,
        data: openMonths.has(month.key) ? month.entries : [],
      })),
    [monthGroups, openMonths],
  );

  const toggleMonth = (key: string) => {
    setOpenMonths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Per-job P&L rows: revenue = payments received; profit % of revenue.
  const pnlRows = useMemo<PnlRow[]>(() => {
    if (!data) return [];
    const paidByJob = new Map<string, number>();
    const expByJob = new Map<string, number>();
    for (const entry of data.allEntries) {
      if (!entry.job_id) continue;
      if (entry.type === 'payment') {
        paidByJob.set(entry.job_id, (paidByJob.get(entry.job_id) ?? 0) + entry.amount);
      } else if (entry.type === 'expense') {
        expByJob.set(entry.job_id, (expByJob.get(entry.job_id) ?? 0) + entry.amount);
      }
    }
    // Company overhead is not a job cost. The container job carries expenses
    // with no revenue, so leaving it in gave it a -100%-style row of its own AND
    // dragged the "All jobs" totals down by costs no single job incurred. It is
    // reported separately, below (2026-08-07).
    return jobsFull.filter((job) => !isCompanyJob(job)).map((job) => {
      const revenue = paidByJob.get(job.id) ?? 0;
      const expensesJob = expByJob.get(job.id) ?? 0;
      const labor = laborMap?.get(job.id)?.labor ?? 0;
      const hours = laborMap?.get(job.id)?.hours ?? 0;
      const profit = revenue - expensesJob - labor;
      const pct = revenue > 0 ? (profit / revenue) * 100 : null;
      // Honest per-hour profit: only meaningful once revenue AND hours exist.
      const perHour = revenue > 0 && hours > 0 ? profit / hours : null;
      return {
        id: job.id,
        label: job.job_number ?? job.name,
        name: job.name,
        revenue,
        expenses: expensesJob,
        hours,
        labor,
        profit,
        pct,
        perHour,
      };
    });
  }, [data, jobsFull, laborMap]);

  /**
   * Company overhead — expenses tagged to the container job. Kept out of the
   * per-job sheet above and shown on its own, so the money is still visible
   * without being charged to anybody's project.
   */
  const companyOverhead = useMemo(() => {
    if (!data || !companyJobId) return 0;
    let total = 0;
    for (const entry of data.allEntries) {
      if (entry.job_id === companyJobId && entry.type === 'expense') total += entry.amount;
    }
    return total;
  }, [data, companyJobId]);

  /**
   * Payments filed against the Company container. The container is overhead —
   * it never earns revenue — so any payment here is a deposit the email scanner
   * couldn't match to a job (2026-08-10: a $434.85 Chase deposit). Left alone it
   * gave DC-26026 a "job profit" of −5,790%. Surface it as a to-do rather than
   * hiding it: the money is real, it just belongs on a project.
   */
  const companyMisfiledPayments = useMemo(() => {
    if (!data || !companyJobId) return { total: 0, count: 0 };
    let total = 0;
    let count = 0;
    for (const entry of data.allEntries) {
      if (entry.job_id === companyJobId && entry.type === 'payment') {
        total += entry.amount;
        count += 1;
      }
    }
    return { total, count };
  }, [data, companyJobId]);

  /**
   * Capital the owners put into the business. Not revenue and not a cost, so
   * it is in none of the figures above — but it is real money that arrived,
   * and it would be worse to leave it invisible than to show it plainly.
   */
  /**
   * Capital NET of anything taken back out. An owner who puts $1,000 in and
   * later draws $800 of it has $200 in the business, not $1,800 — summing the
   * rows without regard to direction would report the money twice.
   */
  /**
   * Booked expenses somebody paid out of their own pocket and has not been paid
   * back for — including reimbursements sent but not yet cleared, because the
   * cash is still in the account until the debit lands.
   */
  const owedOutOfPocket = useMemo(() => {
    if (!data) return 0;
    return data.expenseEntries
      .filter((e) => /NOT yet reimbursed|not yet cleared/i.test(e.description ?? ''))
      .reduce((sum, e) => sum + e.amount, 0);
  }, [data]);

  /**
   * Payments recorded whose money has not arrived — a card payment is taken
   * today and deposited days later, net of the processor's fee. Both rows are
   * already in the ledger, so the net has to come back out of the balance.
   */
  const receiptsInTransit = useMemo(() => {
    if (!data) return 0;
    return data.allEntries
      .filter((e) => /awaiting deposit/i.test(e.description ?? ''))
      .reduce((sum, e) => sum + (e.type === 'payment' ? e.amount : -e.amount), 0);
  }, [data]);

  const capitalInvested = useMemo(() => {
    if (!data) {
      return { total: 0, contributed: 0, returned: 0, byPerson: [] as { who: string; amount: number }[] };
    }
    const byPerson = new Map<string, number>();
    let contributed = 0;
    let returned = 0;
    for (const entry of data.allEntries) {
      if (entry.type !== 'investment') continue;
      const out = entry.direction === 'out';
      const signed = out ? -entry.amount : entry.amount;
      if (out) returned += entry.amount;
      else contributed += entry.amount;
      const who = entry.counterparty?.trim() || 'Unattributed';
      byPerson.set(who, (byPerson.get(who) ?? 0) + signed);
    }
    return {
      total: contributed - returned,
      contributed,
      returned,
      byPerson: Array.from(byPerson.entries())
        .map(([who, amount]) => ({ who, amount }))
        .filter((p) => p.amount !== 0)
        .sort((a, b) => b.amount - a.amount),
    };
  }, [data]);

  // Totals across every PROJECT (top row of the P&L sheet). Overhead excluded.
  const pnlTotals = useMemo(() => {
    const t = { revenue: 0, expenses: 0, hours: 0, labor: 0, profit: 0 };
    for (const row of pnlRows) {
      t.revenue += row.revenue;
      t.expenses += row.expenses;
      t.hours += row.hours;
      t.labor += row.labor;
      t.profit += row.profit;
    }
    return {
      ...t,
      pct: t.revenue > 0 ? (t.profit / t.revenue) * 100 : null,
      perHour: t.revenue > 0 && t.hours > 0 ? t.profit / t.hours : null,
    };
  }, [pnlRows]);

  const resetForm = () => {
    setAmount('');
    setDescription('');
    setPaidTo('');
    setDate(todayISO());
    setJobId(null);
  };

  const saveExpense = async () => {
    const value = Number(amount.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(value) || value <= 0) {
      setStatus({ kind: 'error', message: 'Enter an amount greater than zero.' });
      return;
    }
    const desc = description.trim();
    if (desc === '') {
      setStatus({ kind: 'error', message: 'Enter a short description of the expense.' });
      return;
    }
    const day = date.trim();
    if (!isValidISODate(day)) {
      setStatus({ kind: 'error', message: 'Enter the date as YYYY-MM-DD (e.g. 2026-07-27).' });
      return;
    }
    setSaving(true);
    setStatus(null);
    const counterparty = paidTo.trim();
    const result = await recordExpense({
      amount: value,
      description: desc,
      counterparty: counterparty === '' ? null : counterparty,
      occurredOn: day,
      jobId,
    });
    setSaving(false);
    if (result.ok) {
      haptics.success();
      setFormOpen(false);
      resetForm();
      setStatus({ kind: 'success', message: `Expense of ${formatMoney(value)} recorded.` });
      await load();
    } else {
      setStatus({ kind: 'error', message: `Could not save the expense: ${result.message}` });
    }
  };

  const startEdit = (entry: LedgerEntry) => {
    setStatus(null);
    setConfirmDeleteId(null);
    setEditingId(entry.id);
    setEditAmount(entry.amount > 0 ? String(entry.amount) : '');
    setEditDate(entry.occurred_on ?? '');
    setEditDescription(entry.description ?? '');
    setEditJobId(entry.job_id);
  };

  const saveEdit = async (entry: LedgerEntry) => {
    const value = Number(editAmount.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(value) || value <= 0) {
      setStatus({ kind: 'error', message: 'Enter an amount greater than zero.' });
      return;
    }
    const day = editDate.trim();
    if (day !== '' && !isValidISODate(day)) {
      setStatus({ kind: 'error', message: 'Enter the date as YYYY-MM-DD (e.g. 2026-07-27).' });
      return;
    }
    setSavingEdit(true);
    setStatus(null);
    const desc = editDescription.trim();
    const result = await updateFinanceEntry(entry.id, {
      amount: value,
      occurred_on: day === '' ? null : day,
      description: desc === '' ? null : desc,
      job_id: editJobId,
    });
    setSavingEdit(false);
    if (result.ok) {
      haptics.success();
      setEditingId(null);
      setStatus({ kind: 'success', message: 'Expense updated.' });
      await load();
    } else {
      setStatus({ kind: 'error', message: result.message });
    }
  };

  const pressDelete = async (entry: LedgerEntry) => {
    if (confirmDeleteId !== entry.id) {
      setStatus(null);
      setConfirmDeleteId(entry.id);
      return;
    }
    setConfirmDeleteId(null);
    setDeletingId(entry.id);
    const result = await deleteFinanceEntry(entry.id);
    setDeletingId(null);
    if (result.ok) {
      if (editingId === entry.id) setEditingId(null);
      setStatus({ kind: 'success', message: 'Expense deleted.' });
      await load();
    } else {
      setStatus({ kind: 'error', message: result.message });
    }
  };

  const renderRow = ({
    item,
    index,
    section,
  }: {
    item: LedgerEntry;
    index: number;
    section: { data: LedgerEntry[] };
  }) => (
    <ExpenseRow
      entry={item}
      index={index}
      isFirst={index === 0}
      isLast={index === section.data.length - 1}
      jobLabel={item.job_id ? (jobLabels.get(item.job_id) ?? null) : null}
      editing={editingId === item.id}
      confirming={confirmDeleteId === item.id}
      busyDelete={deletingId === item.id}
      savingEdit={savingEdit}
      editAmount={editAmount}
      onEditAmount={setEditAmount}
      editDate={editDate}
      onEditDate={setEditDate}
      editDescription={editDescription}
      onEditDescription={setEditDescription}
      editJobId={editJobId}
      onEditJobId={setEditJobId}
      jobOptions={jobOptions}
      companyJobId={companyJobId}
      onToggleEdit={() => (editingId === item.id ? setEditingId(null) : startEdit(item))}
      onCancelEdit={() => setEditingId(null)}
      onSaveEdit={() => void saveEdit(item)}
      onDelete={() => void pressDelete(item)}
    />
  );

  const placeholder = (message: string) => (
    <Card>
      <EmptyState icon="wallet" title={message} />
    </Card>
  );

  const header = (
    <View>
      {!loaded ? (
        <SkeletonList count={4} height={110} />
      ) : !role ? (
        placeholder('Sign in to see company financials.')
      ) : !role.isAdmin ? (
        placeholder('Financials are available to owners and operators.')
      ) : !data ? (
        placeholder('Financials are not available right now.')
      ) : (
        <>
          <OverviewTiles data={data} />
          <CashPositionPanel
            bankBalance={settings?.bankBalance ?? null}
            asOf={settings?.bankBalanceAsOf ?? null}
            capital={capitalInvested.total}
            owed={owedOutOfPocket}
            unpaidWages={unpaidWages}
            inTransit={receiptsInTransit}
            byPerson={capitalInvested.byPerson}
          />
          {totals ? <MirrorTiles totals={totals} /> : null}

          {pnlRows.length > 0 ? (
            <PnlSheet
              open={pnlOpen}
              onToggle={() => setPnlOpen((open) => !open)}
              rows={pnlRows}
              totals={pnlTotals}
              companyOverhead={companyOverhead}
              misfiled={companyMisfiledPayments}
              capital={capitalInvested}
            />
          ) : null}
        </>
      )}

      {role?.isAdmin && data ? (
        <View style={styles.expensesHeaderRow}>
          <SectionHeader title="Expenses" icon="pricetag" style={styles.expensesTitle} />
          <Button
            label={formOpen ? 'Close' : '+ Add expense'}
            size="sm"
            variant={formOpen ? 'secondary' : 'primary'}
            onPress={() => {
              setStatus(null);
              setFormOpen((open) => !open);
            }}
          />
        </View>
      ) : null}

      {formOpen && role?.isAdmin && data ? (
        <ExpenseForm
          amount={amount}
          onAmount={setAmount}
          description={description}
          onDescription={setDescription}
          paidTo={paidTo}
          onPaidTo={setPaidTo}
          date={date}
          onDate={setDate}
          jobId={jobId}
          onJobId={setJobId}
          jobOptions={jobOptions}
          companyJobId={companyJobId}
          saving={saving}
          onSave={() => void saveExpense()}
        />
      ) : null}

      {status ? (
        <AppText
          variant="caption"
          align="center"
          color={status.kind === 'error' ? colors.danger : colors.accentPrimary}
          style={styles.status}>
          {status.message}
        </AppText>
      ) : null}
    </View>
  );

  return (
    <>
      {/* Root-stack header, same convention as every more/* screen: the
          title is declared in the body, the back arrow comes from
          app/_layout.tsx. */}
      <Stack.Screen options={{ title: 'Financials' }} />
      <SectionList
        style={styles.safe}
        sections={sections}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.container}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accentPrimary}
            colors={[colors.accentPrimary]}
            progressBackgroundColor={colors.surface}
          />
        }
        ListHeaderComponent={header}
        renderSectionHeader={({ section }) => (
          <MonthHeader
            label={section.label}
            count={section.entries.length}
            total={section.total}
            open={openMonths.has(section.key)}
            onToggle={() => toggleMonth(section.key)}
          />
        )}
        renderItem={renderRow}
        ListEmptyComponent={
          loaded && role?.isAdmin && data ? (
            <Card>
              <EmptyState
                icon="pricetag"
                title="No expenses recorded yet"
                body="Add the first one above and it will file itself into this month."
              />
            </Card>
          ) : null
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
  },
  container: {
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
  expensesHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  expensesTitle: {
    flex: 1,
    marginBottom: 0,
  },
  status: {
    marginBottom: spacing.sm,
  },
});
