/**
 * Financials tab data helpers — company-wide money overview plus the
 * itemized expense ledger. Everything comes from ONE bulk finance_entries
 * fetch (admin-only per RLS) and is grouped client-side, matching
 * lib/pipeline. Returns null on any failure (non-admin / offline)
 * so the screen can degrade to a friendly placeholder.
 */

import { loadedLaborCost } from '@/lib/laborCost';
import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

/**
 * Categories a finance_entries row can carry.
 *
 * 'investment' is capital the owners put into the business. It is deliberately
 * neither revenue nor a cost: counting it as a payment would inflate every
 * margin, and counting it as an expense (which is how it was originally
 * recorded) overstates overhead and reverses the sign on money that actually
 * came in. Every rollup below therefore ignores it, and it is reported on its
 * own.
 *
 * 'contract' is the signed amount — what the customer agreed to pay, which can
 * differ from both the estimate and what eventually gets invoiced. It is the
 * middle of the funnel and drives estimate→contract conversion on the Sales
 * tab. Like investment, it is not revenue: money is only earned when invoiced
 * and only received when paid, so the rollups below ignore it too.
 *
 * NOTE: `contractedYtd` and /ledger/contracted still derive "under contract"
 * from invoice rows on jobs in a contracted stage. That predates this type and
 * is left alone for now — see the Sales tab for the signed-amount figure.
 */
export type FinanceType =
  | 'invoice'
  | 'estimate'
  | 'contract'
  | 'payment'
  | 'expense'
  | 'investment';

/** One finance_entries row as shown on the Financials tab. */
export interface LedgerEntry {
  id: string;
  type: FinanceType;
  amount: number;
  /**
   * Which way the money moved. Amounts are always positive, so for capital this
   * is the only thing distinguishing a contribution ('in') from money taken
   * back out ('out') — netting them wrong overstates what is in the business.
   */
  direction: 'in' | 'out' | null;
  counterparty: string | null;
  description: string | null;
  occurred_on: string | null; // YYYY-MM-DD
  /** Tie-breaker for same-day estimate revisions (see lib/pipeline.ts). */
  created_at?: string | null;
  job_id: string | null;
  document_number: string | null;
  document_path: string | null;
  /** True if this money moved through the bank account. Expenses paid out of
   *  pocket (pending reimbursement) or in cash are false. */
  paid_from_bank: boolean;
  /** 1 = as first created; the document NUMBER never changes, this does. */
  revision?: number | null;
  /**
   * `finance_entries.document_meta` — carries `pdf_state`, so the ledger can
   * warn that a PDF's bytes are older than the row beside them. Typed loosely
   * here on purpose: lib/documents.ts owns the shape, and importing it would
   * point the money layer at the document layer.
   */
  document_meta?: { pdf_state?: string | null } | null;
}

/** One completed payroll run, as the Financials views consume it. */
export interface LaborRun {
  periodStart: string;
  periodEnd: string;
  payday: string;
  /** Everything that left the bank for the run: net pay + all taxes. */
  totalWithdrawn: number;
  receiptId: string | null;
}

/** Company money overview + the full expense ledger. */
export interface FinancialsData {
  /** Sum of all payment entries (money in). */
  paid: number;
  /** Payments dated in the current calendar month. */
  paidThisMonth: number;
  /** Sum of all expense entries (money out). Excludes wages — see `labor`. */
  expenses: number;
  /**
   * Fully-loaded wages from employee_hours (hours × rate × employer burden —
   * see lib/laborCost.ts), across every job.
   *
   * Payroll deliberately does NOT live in finance_entries — booking it in both
   * places double-counted it once already. But it is a real cost, so `net` has
   * to subtract it or the headline reports a profit the business never made.
   */
  labor: number;
  /** Labor for the current month: runs PAID this month + the open accrual. */
  laborThisMonth: number;
  /** Every recorded payroll run, newest payday first. */
  laborRuns: LaborRun[];
  /** Loaded estimate for hours worked after the last recorded run. */
  laborUnpaidEstimate: number;
  /** paid − expenses − labor. The per-job P&L uses the same formula. */
  net: number;
  /** This month's paid − expenses − labor. */
  netThisMonth: number;
  /** Expense total for the current calendar month. */
  expensesThisMonth: number;
  /** Contract value signed this calendar year: invoice-type entries
   *  (documents + contract-value rows) dated Jan 1 → today, any stage. */
  contractedYtd: number;
  /** Every expense entry, newest first (null dates last). */
  expenseEntries: LedgerEntry[];
  /** EVERY finance entry (all types), newest first — feeds the pipeline
   *  mirror card (via fetchCompanyTotals) and the ledger drill-downs. */
  allEntries: LedgerEntry[];
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Newest-first ledger sort; entries without a date sink to the bottom. */
function byDateDesc(a: LedgerEntry, b: LedgerEntry): number {
  return (b.occurred_on ?? '').localeCompare(a.occurred_on ?? '');
}

/**
 * Fetch the company's full ledger and fold it into the overview + expense
 * list. Null when the query fails (non-admin RLS / offline).
 */
export async function fetchFinancials(): Promise<FinancialsData | null> {
  try {
    const [{ data, error }, hoursResult, timeResult, employeesResult, runsResult] = await Promise.all([
      supabase
        .from('finance_entries')
        .select(
          'id, type, direction, amount, counterparty, description, occurred_on, created_at, job_id, document_number, document_path, paid_from_bank, revision, document_meta',
        )
        .eq('company', COMPANY),
      // Wages live here, not in finance_entries. Fetched alongside so `net`
      // can subtract them — the headline overstated profit by every wage
      // dollar ever paid without this.
      supabase.from('employee_hours').select('hours, rate, occurred_on').eq('company', COMPANY),
      // Clock in/out hours are the OTHER half of labor — the Hours tab and the
      // per-job view both count them, and until 2026-08-23 this headline did
      // not, so Net overstated profit by every clocked (never hand-logged)
      // hour. Priced at the roster pay_rate, same as fetchJobFinance.
      supabase
        .from('time_entries')
        .select('employee, clock_in, clock_out')
        .eq('company', COMPANY),
      supabase.from('employees').select('email, pay_rate').eq('is_test', false),
      // Completed Gusto runs (admin-only). When present, labor for the covered
      // periods is the money that ACTUALLY left the bank, to the penny.
      supabase
        .from('payroll_runs')
        .select('period_start, period_end, payday, total_withdrawn, receipt_id')
        .eq('company', COMPANY),
    ]);
    if (error || !data) return null;
    // Labor = actual withdrawals for every completed payroll run, plus the
    // loaded ESTIMATE (gross × employer burden, lib/laborCost.ts) only for
    // hours worked after the newest run's period end. With the runs recorded,
    // the estimate never covers more than the current pay period, so the
    // Financials headline matches the bank to the penny for everything paid.
    const runRows = (runsResult.data ?? []) as {
      period_start: string;
      period_end: string;
      payday: string;
      total_withdrawn: unknown;
      receipt_id: string | null;
    }[];
    const laborRuns: LaborRun[] = runRows
      .map((r) => ({
        periodStart: r.period_start,
        periodEnd: r.period_end,
        payday: r.payday,
        totalWithdrawn: num(r.total_withdrawn),
        receiptId: r.receipt_id ?? null,
      }))
      .sort((a, b) => b.payday.localeCompare(a.payday));
    const paidThrough = laborRuns.reduce((max, r) => (r.periodEnd > max ? r.periodEnd : max), '');
    const laborPaid = laborRuns.reduce((sum, r) => sum + r.totalWithdrawn, 0);

    let unpaidGross = 0;
    for (const row of (hoursResult.data ?? []) as {
      hours: unknown;
      rate: unknown;
      occurred_on: string | null;
    }[]) {
      if ((row.occurred_on ?? '') > paidThrough) unpaidGross += num(row.hours) * num(row.rate);
    }

    const rateByEmail = new Map<string, number>();
    for (const row of (employeesResult.data ?? []) as { email: string; pay_rate: unknown }[]) {
      if (row.email && row.pay_rate != null) rateByEmail.set(row.email.toLowerCase(), num(row.pay_rate));
    }
    for (const row of (timeResult.data ?? []) as {
      employee: string | null;
      clock_in: string | null;
      clock_out: string | null;
    }[]) {
      if (!row.clock_in || !row.clock_out) continue; // only completed entries
      const ms = new Date(row.clock_out).getTime() - new Date(row.clock_in).getTime();
      if (!Number.isFinite(ms) || ms <= 0) continue;
      // Payroll periods are Kansas City days; bucket the entry by its local date.
      const day = new Date(row.clock_in).toLocaleDateString('en-CA', {
        timeZone: 'America/Chicago',
      });
      if (day <= paidThrough) continue; // covered by a recorded run already
      const rate = rateByEmail.get((row.employee ?? '').toLowerCase());
      if (rate != null) unpaidGross += (ms / 3_600_000) * rate;
    }

    const laborUnpaidEstimate = loadedLaborCost(unpaidGross);
    const labor = laborPaid + laborUnpaidEstimate;

    const rows = (data as Record<string, unknown>[]).map((row) => ({
      ...row,
      amount: num(row.amount),
    })) as LedgerEntry[];

    const thisMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    const thisYear = thisMonth.slice(0, 4);
    let paid = 0;
    let paidThisMonth = 0;
    let expenses = 0;
    let expensesThisMonth = 0;
    let contractedYtd = 0;
    const expenseEntries: LedgerEntry[] = [];
    for (const row of rows) {
      if (row.type === 'payment') {
        paid += row.amount;
        if ((row.occurred_on ?? '').startsWith(thisMonth)) paidThisMonth += row.amount;
      }
      if (row.type === 'invoice' && (row.occurred_on ?? '').startsWith(thisYear)) {
        contractedYtd += row.amount;
      }
      if (row.type === 'expense') {
        expenses += row.amount;
        if ((row.occurred_on ?? '').startsWith(thisMonth)) expensesThisMonth += row.amount;
        expenseEntries.push(row);
      }
    }
    expenseEntries.sort(byDateDesc);
    const allEntries = [...rows].sort(byDateDesc);

    // Runs land in the month their PAYDAY falls in — the same month the
    // money left the account. The open period's accrual estimate belongs to
    // the current month by construction (payroll_through is current).
    const laborThisMonth =
      laborRuns
        .filter((r) => r.payday.startsWith(thisMonth))
        .reduce((sum, r) => sum + r.totalWithdrawn, 0) + laborUnpaidEstimate;

    return {
      paid,
      paidThisMonth,
      expenses,
      labor,
      laborThisMonth,
      laborRuns,
      laborUnpaidEstimate,
      net: paid - expenses - labor,
      netThisMonth: paidThisMonth - expensesThisMonth - laborThisMonth,
      expensesThisMonth,
      contractedYtd,
      expenseEntries,
      allEntries,
    };
  } catch {
    return null;
  }
}

/** One month's worth of expenses for the sectioned ledger list. */
export interface ExpenseMonth {
  /** Section key, YYYY-MM ('none' for undated entries). */
  key: string;
  /** Human label, e.g. "July 2026". */
  label: string;
  total: number;
  entries: LedgerEntry[];
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function monthLabel(key: string): string {
  const [year, month] = key.split('-');
  const name = MONTH_NAMES[Number(month) - 1];
  return name ? `${name} ${year}` : key;
}

/** Group newest-first expenses into month sections (undated last). */
export function groupExpensesByMonth(entries: LedgerEntry[]): ExpenseMonth[] {
  const months = new Map<string, ExpenseMonth>();
  for (const entry of entries) {
    const key = entry.occurred_on ? entry.occurred_on.slice(0, 7) : 'none';
    const section = months.get(key) ?? {
      key,
      label: key === 'none' ? 'No date' : monthLabel(key),
      total: 0,
      entries: [],
    };
    section.total += entry.amount;
    section.entries.push(entry);
    months.set(key, section);
  }
  // Newest month first; the undated bucket always last.
  return [...months.values()].sort((a, b) => {
    if (a.key === 'none') return 1;
    if (b.key === 'none') return -1;
    return b.key.localeCompare(a.key);
  });
}

export type RecordExpenseResult = { ok: true } | { ok: false; message: string };

/**
 * Insert a company expense (admin-only per RLS). jobId null = company
 * overhead — same shape the receipts approval flow writes, so the Pipeline
 * per-job profit math picks job-tied entries up automatically.
 */
export async function recordExpense(params: {
  amount: number;
  description: string;
  counterparty: string | null;
  occurredOn: string; // YYYY-MM-DD
  jobId: string | null;
  /** False if paid out of pocket / in cash rather than from the bank account. */
  paidFromBank: boolean;
}): Promise<RecordExpenseResult> {
  try {
    const { error } = await supabase.from('finance_entries').insert({
      company: COMPANY,
      type: 'expense',
      direction: 'out',
      amount: params.amount,
      currency: 'USD',
      counterparty: params.counterparty,
      description: params.description,
      occurred_on: params.occurredOn,
      status: 'recorded',
      job_id: params.jobId,
      paid_from_bank: params.paidFromBank,
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the expense.' };
  }
}
