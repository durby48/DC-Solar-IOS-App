import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, SectionList, StyleSheet, View } from 'react-native';

import {
  CashPositionPanel,
  type CashDetailEntry,
} from '@/components/financials/CashPositionPanel';
import {
  ExpenseForm,
  ExpenseRow,
  LaborReportRow,
  MonthHeader,
  type JobOption,
} from '@/components/financials/ExpenseLedger';
import { formatMoney } from '@/components/financials/format';
import { MirrorTiles } from '@/components/financials/MirrorTiles';
import { OverviewTiles, type OverviewMonth } from '@/components/financials/OverviewTiles';
import { PnlSheet, type PnlRow } from '@/components/financials/PnlSheet';
import { ReceivablesLedger } from '@/components/financials/ReceivablesLedger';
import { CompanyAssets } from '@/components/financials/CompanyAssets';
import { StockChart } from '@/components/financials/StockChart';
import { AppText, Button, Card, EmptyState, SectionHeader, SkeletonList } from '@/components/ui';
import { colors, hubColors, spacing } from '@/constants/theme';
import { useAdminOnlyScreen } from '@/lib/adminGate';
import { formatShortDate, todayISO } from '@/lib/dates';
import { deleteFinanceEntry, updateFinanceEntry } from '@/lib/documents';
import {
  fetchFinancials,
  groupExpensesByMonth,
  outstandingReceivables,
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
import { useFinanceRealtime } from '@/lib/financeRealtime';
import {
  buildValuationSeries,
  fetchCompanyAssets,
  fetchCompanyLiabilities,
  fetchDailyGrossWages,
  type CompanyAsset,
  type CompanyLiability,
} from '@/lib/valuation';

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
 *   ReceivablesLedger  the expense ledger's twin for money IN (2026-09-12):
 *                      every deposit by month, tiles, add/edit/delete
 *
 * Nothing about WHAT is shown moved: the same queries, the same admin gate,
 * the same arithmetic, the same Company-overhead warning. Only the drawing
 * changed, and it changed by deleting local styles rather than restyling them.
 */
export default function FinancialsScreen() {
  const role = useRole();
  // The admin door: a crew member who lands here by deep link gets the
  // "contact your administrator" alert and is sent back, and nothing about
  // the company's money is drawn in the meantime.
  const gate = useAdminOnlyScreen();

  const [data, setData] = useState<FinancialsData | null>(null);
  const [totals, setTotals] = useState<CompanyTotals | null>(null);
  const [jobsFull, setJobsFull] = useState<Job[]>([]);
  const [laborMap, setLaborMap] = useState<Map<string, JobLaborHours> | null>(null);
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [unpaidWages, setUnpaidWages] = useState(0);
  // Inputs to the stock chart's Value line (lib/valuation.ts): the owner's
  // vehicles/tools/loans, and gross wages per day for the labor accrual.
  const [assets, setAssets] = useState<CompanyAsset[]>([]);
  const [liabilities, setLiabilities] = useState<CompanyLiability[]>([]);
  const [dailyGross, setDailyGross] = useState<Map<string, number> | null>(null);
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
  const [paidFromBank, setPaidFromBank] = useState(true);
  const [saving, setSaving] = useState(false);

  // Inline row editing + two-tap delete (same behavior as JobInvoices).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editPaidFromBank, setEditPaidFromBank] = useState(true);
  const [editJobId, setEditJobId] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (role?.isAdmin) {
      const [financials, { jobs }, labor, assetRows, liabilityRows, gross] = await Promise.all([
        fetchFinancials(),
        fetchPipelineJobs(),
        fetchLaborHoursByJob(),
        fetchCompanyAssets(),
        fetchCompanyLiabilities(),
        fetchDailyGrossWages(),
      ]);
      const companySettings = await fetchCompanySettings();
      setSettings(companySettings);
      setUnpaidWages(await fetchUnpaidWages(companySettings?.payrollThrough ?? null));
      setAssets(assetRows ?? []);
      setLiabilities(liabilityRows ?? []);
      setDailyGross(gross);
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
          .map((j) => ({
            id: j.id,
            label: j.job_number ?? j.name,
            customerName: j.customer?.name ?? null,
            address: j.address,
          })),
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

  // Live: any change to finance_entries / payroll_runs / company_settings /
  // company_assets / company_liabilities refetches (debounced), so the stock
  // chart is never stale while the screen is open.
  useFinanceRealtime(load, Boolean(role?.isAdmin));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  // Which month the Overview header shows. Defaults to the current month;
  // the ‹ › arrows page back through every month that has any data.
  const [overviewYm, setOverviewYm] = useState(() => todayISO().slice(0, 7));

  const currentYm = todayISO().slice(0, 7);

  /** Earliest month with any money activity — the back arrow's floor. */
  const earliestYm = useMemo(() => {
    let min = currentYm;
    for (const e of data?.allEntries ?? []) {
      const ym = (e.occurred_on ?? '').slice(0, 7);
      if (ym && ym < min) min = ym;
    }
    for (const run of data?.laborRuns ?? []) {
      const ym = run.payday.slice(0, 7);
      if (ym < min) min = ym;
    }
    return min;
  }, [data, currentYm]);

  const shiftYm = (ym: string, delta: number): string => {
    const [y, m] = ym.split('-').map(Number);
    const total = y * 12 + (m - 1) + delta;
    const ny = Math.floor(total / 12);
    const nm = (total % 12) + 1;
    return `${ny}-${String(nm).padStart(2, '0')}`;
  };

  /** One selected month's headline figures, from data already fetched. */
  /**
   * Auto-adjustment of the anchored bank balance: every transaction recorded
   * after the anchor was saved that actually moved bank money adjusts the
   * displayed balance without anyone retyping it. That's either a Chase-synced
   * row (Plaid) or a manually-recorded expense explicitly toggled "Bank
   * account" (`paid_from_bank`, default true — see the expense form). An
   * expense toggled "Out of pocket" never touched the account, and is already
   * handled by "owed for out-of-pocket". Re-anchoring the balance resets the
   * adjustment to zero.
   */
  const bankAdjustment = useMemo(() => {
    if (!data || !settings) return { total: 0, count: 0 };
    // 2026-09-12 audit fix. The old version keyed on the ROW's created_at vs
    // the anchor's updated_at and only counted Chase-scanner rows and
    // manually-toggled bank expenses — so a deposit typed into the app, a
    // payroll withdrawal, or any row entered late for an earlier date never
    // moved the balance, and the display drifted thousands from Chase. Now:
    // the balance is the statement figure AS OF `bank_balance_as_of`, and
    // every bank-moving row DATED after that day adjusts it — payments in,
    // expenses that left the account (`paid_from_bank`), owner capital in/out,
    // and payroll runs by payday. Out-of-pocket receipts are excluded here and
    // shown under "owed" instead. Without an as-of date, fall back to the old
    // timestamp rule so an un-dated anchor still behaves.
    const asOf = settings.bankBalanceAsOf;
    const anchorAt = settings.anchorAt;
    let total = 0;
    let count = 0;
    const after = (e: LedgerEntry) =>
      asOf ? (e.occurred_on ?? '') > asOf : Boolean(anchorAt && e.created_at && e.created_at > anchorAt);
    for (const e of data.allEntries) {
      // fetchFinancials already drops voided rows; guard here too so a
      // cancelled deposit can never move the bank figure.
      if (e.status === 'void' || !after(e)) continue;
      const inflow = e.type === 'payment' || (e.type === 'investment' && e.direction !== 'out');
      const outflow =
        (e.type === 'expense' && e.paid_from_bank) || (e.type === 'investment' && e.direction === 'out');
      if (!inflow && !outflow) continue;
      total += inflow ? e.amount : -e.amount;
      count += 1;
    }
    for (const run of data.laborRuns) {
      if (asOf ? run.payday > asOf : false) {
        total -= run.totalWithdrawn;
        count += 1;
      }
    }
    return { total, count };
  }, [settings, data]);

  const overviewMonth = useMemo<OverviewMonth>(() => {
    const ym = overviewYm;
    let paid = 0;
    let expenses = 0;
    for (const e of data?.allEntries ?? []) {
      if (!(e.occurred_on ?? '').startsWith(ym)) continue;
      if (e.type === 'payment') paid += e.amount;
      else if (e.type === 'expense') expenses += e.amount;
    }
    // Labor lands in the month its PAYDAY falls in; the open accrual belongs
    // to the current month by construction (payroll_through is current).
    let labor = (data?.laborRuns ?? [])
      .filter((r) => r.payday.startsWith(ym))
      .reduce((sum, r) => sum + r.totalWithdrawn, 0);
    if (ym === currentYm) labor += data?.laborUnpaidEstimate ?? 0;
    return {
      ym,
      label: new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }),
      paid,
      expenses,
      labor,
      net: paid - expenses - labor,
    };
  }, [data, overviewYm, currentYm]);

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

  /**
   * Payroll runs by PAYDAY month, shaped as display rows for the "Labor
   * Report" dropdowns. The open period's accrual estimate rides in the
   * current month so August shows what August is really costing.
   */
  const laborMonthRows = useMemo(() => {
    const byMonth = new Map<string, { id: string; title: string; caption: string; amount: number }[]>();
    for (const run of data?.laborRuns ?? []) {
      const ym = run.payday.slice(0, 7);
      const rows = byMonth.get(ym) ?? [];
      rows.push({
        id: `run-${run.payday}`,
        title: `Payroll — paid ${formatShortDate(run.payday)}`,
        caption: `period ${formatShortDate(run.periodStart)} – ${formatShortDate(run.periodEnd)}`,
        amount: run.totalWithdrawn,
      });
      byMonth.set(ym, rows);
    }
    if (data && data.laborUnpaidEstimate > 0) {
      const ym = todayISO().slice(0, 7);
      const rows = byMonth.get(ym) ?? [];
      rows.push({
        id: 'run-accruing',
        title: 'Current period — accruing',
        caption: 'estimate: hours logged × rate × employer taxes',
        amount: data.laborUnpaidEstimate,
      });
      byMonth.set(ym, rows);
    }
    for (const rows of byMonth.values()) rows.sort((a, b) => b.id.localeCompare(a.id));
    return byMonth;
  }, [data]);

  const sections = useMemo(() => {
    const result: {
      key: string;
      label: string;
      total: number;
      entries: LedgerEntry[];
      kind?: 'labor';
      data: LedgerEntry[];
    }[] = [];
    const seenMonths = new Set<string>();
    const laborSection = (ym: string, monthLabel: string) => {
      const rows = laborMonthRows.get(ym);
      if (!rows) return null;
      return {
        key: `labor-${ym}`,
        kind: 'labor' as const,
        label: `Labor Report: ${monthLabel}`,
        total: rows.reduce((sum, r) => sum + r.amount, 0),
        entries: rows as unknown as LedgerEntry[],
        data: openMonths.has(`labor-${ym}`) ? (rows as unknown as LedgerEntry[]) : [],
      };
    };
    for (const month of monthGroups) {
      result.push({
        ...month,
        data: openMonths.has(month.key) ? month.entries : [],
      });
      seenMonths.add(month.key);
      const labor = laborSection(month.key, month.label);
      if (labor) result.push(labor);
    }
    // Months with payroll but no expenses (rare) still get their report.
    const extra = [...laborMonthRows.keys()]
      .filter((ym) => !seenMonths.has(ym))
      .sort((a, b) => b.localeCompare(a));
    for (const ym of extra) {
      const [y, m] = ym.split('-');
      const label = `${new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })} ${y}`;
      void m;
      const labor = laborSection(ym, label);
      if (labor) result.push(labor);
    }
    return result;
  }, [monthGroups, openMonths, laborMonthRows]);

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
    if (!data) return { total: 0, entries: [] as CashDetailEntry[] };
    const rows = data.expenseEntries.filter((e) => !e.paid_from_bank);
    return {
      total: rows.reduce((sum, e) => sum + e.amount, 0),
      entries: rows.map((e) => ({
        id: e.id,
        occurred_on: e.occurred_on,
        label: e.description ?? e.counterparty ?? 'Expense',
        amount: e.amount,
      })),
    };
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
      return {
        total: 0,
        contributed: 0,
        returned: 0,
        byPerson: [] as { who: string; amount: number }[],
        entries: [] as CashDetailEntry[],
      };
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
    const entries: CashDetailEntry[] = data.allEntries
      .filter((e) => e.type === 'investment')
      .map((e) => ({
        id: e.id,
        occurred_on: e.occurred_on,
        label:
          e.description ??
          `${e.counterparty ?? 'Owner'} ${e.direction === 'out' ? 'capital returned' : 'investment'}`,
        // Signed the way the row is displayed: returns reduce the figure.
        amount: e.direction === 'out' ? -e.amount : e.amount,
      }))
      .sort((a, b) => (a.occurred_on ?? '').localeCompare(b.occurred_on ?? ''));
    return {
      total: contributed - returned,
      contributed,
      returned,
      byPerson: Array.from(byPerson.entries())
        .map(([who, amount]) => ({ who, amount }))
        .filter((p) => p.amount !== 0)
        .sort((a, b) => b.amount - a.amount),
      entries,
    };
  }, [data]);

  /**
   * "Outstanding" on the Receivables tiles: invoiced − paid over the jobs the
   * Pipeline mirror counts as Actively Invoiced. Hidden (null) when the
   * mirror itself could not load, so the two can never disagree on screen.
   */
  const outstanding = useMemo(
    () => (data && totals ? outstandingReceivables(jobsFull, data.allEntries) : null),
    [data, totals, jobsFull],
  );

  /**
   * The stock chart's three daily series since 2026-07-01, rebuilt from the
   * rows above on every load (never stored). Formulas: docs/VALUATION.md.
   */
  const valuation = useMemo(
    () =>
      data
        ? buildValuationSeries({
            entries: data.allEntries,
            runs: data.laborRuns,
            dailyGross,
            jobs: jobsFull,
            avgProfitPct: totals?.avgProfitPct ?? null,
            settings,
            assets,
            liabilities,
          })
        : null,
    [data, dailyGross, jobsFull, totals, settings, assets, liabilities],
  );

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
    setPaidFromBank(true);
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
      paidFromBank,
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
    setEditPaidFromBank(entry.paid_from_bank);
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
      paid_from_bank: editPaidFromBank,
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
    section: { data: LedgerEntry[]; kind?: 'labor' };
  }) => {
    if (section.kind === 'labor') {
      const row = item as unknown as { title: string; caption: string; amount: number };
      return (
        <LaborReportRow
          title={row.title}
          caption={row.caption}
          amount={row.amount}
          index={index}
          isFirst={index === 0}
          isLast={index === section.data.length - 1}
        />
      );
    }
    return (
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
        editPaidFromBank={editPaidFromBank}
        onEditPaidFromBank={setEditPaidFromBank}
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
  };

  const placeholder = (message: string) => (
    <Card>
      <EmptyState icon="wallet" title={message} />
    </Card>
  );

  const header = (
    <View>
      {!loaded || gate.phase === 'loading' ? (
        <SkeletonList count={4} height={110} />
      ) : !role?.isAdmin ? null : !data ? (
        placeholder('Financials are not available right now.')
      ) : (
        <>
          {valuation ? (
            <StockChart
              series={{
                revenue: valuation.revenue,
                profit: valuation.profit,
                value: valuation.value,
              }}
              breakdown={valuation.breakdown}
            />
          ) : null}
          <OverviewTiles
            month={overviewMonth}
            canPrev={overviewYm > earliestYm}
            canNext={overviewYm < currentYm}
            onPrev={() => setOverviewYm((ym) => shiftYm(ym, -1))}
            onNext={() => setOverviewYm((ym) => shiftYm(ym, 1))}
          />
          <CashPositionPanel
            bankBalance={
              settings?.bankBalance == null
                ? null
                : settings.bankBalance + bankAdjustment.total
            }
            asOf={settings?.bankBalanceAsOf ?? null}
            adjustment={bankAdjustment}
            capital={capitalInvested.total}
            owed={owedOutOfPocket.total}
            unpaidWages={unpaidWages}
            inTransit={receiptsInTransit}
            byPerson={capitalInvested.byPerson}
            capitalEntries={capitalInvested.entries}
            owedEntries={owedOutOfPocket.entries}
          />
          {totals ? (
            <MirrorTiles totals={totals} expensesYtd={data.expenses} laborYtd={data.labor} />
          ) : null}

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
          <SectionHeader
            title="Expenses"
            icon="pricetag"
            accent={hubColors.systems.fg}
            style={styles.expensesTitle}
          />
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
          paidFromBank={paidFromBank}
          onPaidFromBank={setPaidFromBank}
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

  if (gate.blocked) {
    return (
      <>
        <Stack.Screen options={{ title: 'Financials' }} />
        <View style={styles.safe} />
      </>
    );
  }

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
        ListFooterComponent={
          loaded && role?.isAdmin && data ? (
            <View>
              <ReceivablesLedger
                entries={data.paymentEntries}
                paidYtd={data.paidYtd}
                paidThisMonth={data.paidThisMonth}
                outstanding={outstanding}
                jobs={jobsFull}
                jobOptions={jobOptions}
                companyJobId={companyJobId}
                jobLabels={jobLabels}
                onChanged={load}
              />
              <CompanyAssets assets={assets} liabilities={liabilities} onChanged={load} />
            </View>
          ) : null
        }
        renderSectionHeader={({ section }) => (
          <MonthHeader
            label={section.label}
            count={section.entries.length}
            total={section.total}
            open={openMonths.has(section.key)}
            onToggle={() => toggleMonth(section.key)}
            noun={section.kind === 'labor' ? 'payroll' : 'expense'}
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
