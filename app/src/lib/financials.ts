/**
 * Financials tab data helpers — company-wide money overview plus the
 * itemized expense ledger. Everything comes from ONE bulk finance_entries
 * fetch (admin-only per RLS) and is grouped client-side, matching
 * lib/pipeline. Returns null on any failure (non-admin / offline / demo)
 * so the screen can degrade to a friendly placeholder.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

/** One finance_entries row as shown on the Financials tab. */
export interface LedgerEntry {
  id: string;
  type: 'invoice' | 'estimate' | 'payment' | 'expense';
  amount: number;
  counterparty: string | null;
  description: string | null;
  occurred_on: string | null; // YYYY-MM-DD
  /** Tie-breaker for same-day estimate revisions (see lib/pipeline.ts). */
  created_at?: string | null;
  job_id: string | null;
  document_number: string | null;
  document_path: string | null;
}

/** Company money overview + the full expense ledger. */
export interface FinancialsData {
  /** Sum of all payment entries (money in). */
  paid: number;
  /** Sum of all expense entries (money out; labor is not included). */
  expenses: number;
  /** paid − expenses */
  net: number;
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
    const { data, error } = await supabase
      .from('finance_entries')
      .select(
        'id, type, amount, counterparty, description, occurred_on, created_at, job_id, document_number, document_path',
      )
      .eq('company', COMPANY);
    if (error || !data) return null;

    const rows = (data as Record<string, unknown>[]).map((row) => ({
      ...row,
      amount: num(row.amount),
    })) as LedgerEntry[];

    const thisMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    const thisYear = thisMonth.slice(0, 4);
    let paid = 0;
    let expenses = 0;
    let expensesThisMonth = 0;
    let contractedYtd = 0;
    const expenseEntries: LedgerEntry[] = [];
    for (const row of rows) {
      if (row.type === 'payment') paid += row.amount;
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

    return {
      paid,
      expenses,
      net: paid - expenses,
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
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the expense.' };
  }
}
