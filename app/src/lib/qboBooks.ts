/**
 * QuickBooks as the system of record (2026-11-21).
 *
 * The Financials tab is a mirror of QuickBooks: every number on it comes from
 * the `qbo-books` edge function, which asks QuickBooks live. The app's own
 * ledger (finance_entries) still feeds QuickBooks, but never duplicates the
 * bank feed — see the header of supabase/functions/qbo-books/index.ts.
 */

import { readFunctionError } from '@/lib/artwork';
import { supabase } from '@/lib/supabase';

export type ReportNode = {
  label: string;
  group?: string;
  id?: string;
  values: number[];
  children?: ReportNode[];
  total?: boolean;
};
export type Report = { title: string; columns: { title: string; key?: string }[]; rows: ReportNode[] };

export type BooksOverview = {
  period: { start: string; end: string };
  headline: {
    income: number;
    cogs: number;
    grossProfit: number;
    expenses: number;
    netIncome: number;
    bank: number;
    receivables: number;
    liabilities: number;
    equity: number;
  };
  months: { title: string; income: number; cogs: number; expenses: number; net: number }[];
  pnl: Report;
  balanceSheet: Report;
  receivables: Report;
};

export type JobPnl = {
  qboId: string | null;
  title: string;
  jobId: string | null;
  jobNumber: string | null;
  stage: string | null;
  income: number;
  cogs: number;
  expenses: number;
  net: number;
  marginPct: number | null;
};

export type UntaggedLine = {
  type: 'Purchase' | 'Bill';
  id: string;
  lineId: string;
  date: string;
  amount: number;
  total: number;
  payee: string | null;
  memo: string | null;
  account: string;
  accountType: string;
  /** On a Cost of Goods Sold account — it belongs on a job. */
  jobCost: boolean;
  /** Already on a job, but still on Uncategorized / Ask My Accountant. */
  hasJob: boolean;
  uncategorized: boolean;
  /** A hint only — never applied unless Devon picks it. */
  suggestion: { jobId: string; jobNumber: string | null; why: string } | null;
};

export type AccountChoice = { id: string; name: string; jobCost: boolean };

export type MatchResult = {
  matched: { key: string; total: number; date: string; qboId: string; qboDate: string; action: string; description: string | null; appIds: string[] }[];
  waiting: { key: string; total: number; date: string; description: string | null }[];
  ambiguous: { key: string; total: number; date: string; qboIds: string[]; description: string | null }[];
};

type Result<T> = { ok: true; value: T } | { ok: false; message: string };

async function call<T>(body: Record<string, unknown>): Promise<Result<T>> {
  const { data, error } = await supabase.functions.invoke('qbo-books', { body });
  if (error) return { ok: false, message: (await readFunctionError(error)) ?? 'Could not reach QuickBooks.' };
  const res = data as { ok?: boolean; error?: string } & T;
  if (!res?.ok) return { ok: false, message: res?.error ?? 'QuickBooks request failed.' };
  return { ok: true, value: res };
}

export const fetchBooksOverview = (start?: string, end?: string) =>
  call<BooksOverview>({ action: 'overview', start, end });

export const fetchJobPnl = (start?: string, end?: string) =>
  call<{ rows: JobPnl[] }>({ action: 'jobs', start, end }).then((r) => (r.ok ? { ok: true as const, value: r.value.rows } : r));

export const fetchUntaggedLines = (start?: string, end?: string) =>
  call<{ lines: UntaggedLine[]; accounts: AccountChoice[] }>({ action: 'untagged', start, end });

type LineRef = Pick<UntaggedLine, 'type' | 'id' | 'lineId'>;

export const assignLineToJob = (line: LineRef, jobId: string, accountId?: string) =>
  call<Record<string, unknown>>({ action: 'assign', type: line.type, id: line.id, lineId: line.lineId, jobId, accountId });

/** Keep the line off every job; `accountId` recategorizes it at the same time. */
export const markLineOverhead = (line: LineRef, accountId?: string) =>
  call<Record<string, unknown>>({ action: 'assign', type: line.type, id: line.id, lineId: line.lineId, overhead: true, accountId });

/** Which bank-paid app receipts fit a Chase-feed transaction in QuickBooks. Writes nothing. */
export const previewAppMatches = () => call<MatchResult>({ action: 'match_app', dryRun: true });

/** Stamp the chosen app receipts onto their bank-feed transactions. Never creates a transaction. */
export const confirmAppMatches = (keys: string[]) => call<MatchResult>({ action: 'match_app', keys });

/** Find a section of a report by QuickBooks' group tag (Income, Expenses, BankAccounts, …). */
export function findGroup(rows: ReportNode[], group: string): ReportNode | null {
  for (const r of rows) {
    if (r.group === group) return r;
    const inner = r.children ? findGroup(r.children, group) : null;
    if (inner) return inner;
  }
  return null;
}
