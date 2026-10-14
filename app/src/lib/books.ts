/**
 * Books review (2026-10-14) — every expense's QuickBooks account and job,
 * reviewed by an admin BEFORE the ledger is sent to QuickBooks.
 *
 * Each expense carries `extracted.book_account`, a key from BOOK_ACCOUNTS
 * below; the key maps 1:1 to an account in the company's QuickBooks chart
 * (set up by scripts/qbo/setup-accounts.mjs). Rules proposed a key for every
 * row (`book_account_by: 'rules-2026-10-14'`); the review screen confirms or
 * changes it and stamps `reviewed_at` / `reviewed_by`.
 *
 * Moving an expense between a job and overhead swaps the job-cost twin of its
 * account (Fuel ⇄ Job fuel & travel, Supplies ⇄ Job materials, …) so the
 * same purchase lands in Cost of Goods Sold when it belongs to a job and in
 * overhead when it does not.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

/** The QuickBooks books start here (Devon, 2026-10-14). */
export const BOOKS_START = '2026-06-26';
/** Money already in the accounts on BOOKS_START — QuickBooks' opening balances. */
export const OPENING_CASH = [
  { label: 'Chase checking (7086)', amount: 2029 },
  { label: 'Chase savings (1900)', amount: 100 },
] as const;

type Extracted = Record<string, unknown> | null | undefined;
const bookKey = (x: Extracted) => (x?.book_account as string | undefined) ?? null;

/** A vehicle or equipment bought — company property, not an expense. */
export function isAssetPurchase(x: Extracted): boolean {
  const k = bookKey(x);
  return k === 'vehicle_purchase' || k === 'equipment_purchase';
}

/** Money the owner took out that was booked as an expense row. */
export function isOwnerDraw(x: Extracted): boolean {
  return bookKey(x) === 'owner_draw';
}

/** Counts toward profit: an expense that is neither an asset purchase nor an owner draw. */
export function isProfitExpense(x: Extracted): boolean {
  return !isAssetPurchase(x) && !isOwnerDraw(x);
}

export interface Reimbursement {
  paid_on: string;
  /** 'bank' = paid from the company account; 'owner' = Devon paid it personally. */
  from: 'bank' | 'owner';
  method: string;
  total: number;
  batch: string;
}

/** An expense someone paid out of pocket and has not been paid back for. */
export function isOwedOutOfPocket(e: { type: string; paid_from_bank: boolean; extracted?: Extracted }): boolean {
  return e.type === 'expense' && !e.paid_from_bank && !(e.extracted as { reimbursement?: unknown } | null)?.reimbursement;
}

export interface BridgeEntry {
  type: string;
  direction: 'in' | 'out' | null;
  amount: number;
  occurred_on: string | null;
  paid_from_bank: boolean;
  extracted?: Extracted;
}

export interface CashBridge {
  income: number;
  expenses: number;
  payroll: number;
  netProfit: number;
  opening: number;
  ownerIn: number;
  ownerOut: number;
  assets: number;
  owed: number;
  cash: number;
}

/**
 * Profit → cash since the books start, the way QuickBooks' Statement of Cash
 * Flows walks it (verified to the cent against QuickBooks on 2026-10-14):
 * cash-basis net profit, plus the opening balances, plus owner money in, minus
 * owner money out, minus vehicles/equipment bought, plus what is still owed out
 * of pocket (counted as a cost, not yet paid) = cash in checking + savings.
 */
export function computeCashBridge(entries: BridgeEntry[], payrollRuns: { payday: string; totalWithdrawn: number }[]): CashBridge {
  let income = 0;
  let expenses = 0;
  let ownerIn = 0;
  let ownerOut = 0;
  let assets = 0;
  let owed = 0;
  for (const e of entries) {
    if ((e.occurred_on ?? '') < BOOKS_START) continue;
    const reimb = (e.extracted as { reimbursement?: Reimbursement } | null)?.reimbursement;
    if (e.type === 'payment') income += e.amount;
    else if (e.type === 'investment') {
      if (e.direction === 'out') ownerOut += e.amount;
      else ownerIn += e.amount;
    } else if (e.type === 'expense') {
      if (isAssetPurchase(e.extracted)) assets += e.amount;
      else if (isOwnerDraw(e.extracted)) ownerOut += e.amount;
      else expenses += e.amount;
      if (isOwedOutOfPocket(e)) owed += e.amount;
      // Paid back by the owner personally: the owner put that money in.
      if (!e.paid_from_bank && reimb?.from === 'owner') ownerIn += e.amount;
    }
  }
  const payroll = payrollRuns.filter((r) => r.payday >= BOOKS_START).reduce((s, r) => s + r.totalWithdrawn, 0);
  const opening = OPENING_CASH.reduce((s, o) => s + o.amount, 0);
  const round = (n: number) => Math.round(n * 100) / 100;
  const netProfit = round(income - expenses - payroll);
  return {
    income: round(income),
    expenses: round(expenses),
    payroll: round(payroll),
    netProfit,
    opening,
    ownerIn: round(ownerIn),
    ownerOut: round(ownerOut),
    assets: round(assets),
    owed: round(owed),
    cash: round(netProfit + opening + ownerIn - ownerOut - assets + owed),
  };
}

export type PayBackResult = { ok: true; voidedAlert: boolean } | { ok: false; message: string };

/**
 * Record that out-of-pocket expenses were paid back.
 *   from 'bank'  → the rows become bank-paid (one bank line, `bank_ref` built from
 *                  the date and total), exactly like check #8089 and the 9/14 Venmo;
 *                  a Chase "You sent $…" alert already logged for the same total is
 *                  voided so the money is not counted twice (a database trigger
 *                  voids one that arrives later).
 *   from 'owner' → Devon paid personally: the rows stay off the bank and count as
 *                  owner money put in.
 */
export async function payBackOutOfPocket(
  rows: { id: string; amount: number; description: string | null; extracted?: Extracted }[],
  params: { paidOn: string; from: 'bank' | 'owner'; method: string },
): Promise<PayBackResult> {
  if (!rows.length) return { ok: false, message: 'Pick at least one expense.' };
  const total = Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  const batch = `${params.paidOn}-${Math.random().toString(36).slice(2, 8)}`;
  const reimbursement: Reimbursement = { paid_on: params.paidOn, from: params.from, method: params.method, total, batch };
  const bankRef = `${params.paidOn}|-${total.toFixed(2)}|REIMBURSEMENT ${params.method.toUpperCase()}`;
  for (const r of rows) {
    const extracted = {
      ...(r.extracted ?? {}),
      reimbursement,
      reimbursed: true,
      ...(params.from === 'bank' ? { bank_ref: bankRef } : {}),
    };
    const description = (r.description ?? '').replace(/NOT yet reimbursed/i, `paid back ${params.paidOn} (${params.method})`);
    const { error } = await supabase
      .from('finance_entries')
      .update({ extracted, description, ...(params.from === 'bank' ? { paid_from_bank: true } : {}) })
      .eq('id', r.id);
    if (error) return { ok: false, message: error.message };
  }
  let voidedAlert = false;
  if (params.from === 'bank') {
    // The bank alert for this payment, if the email scanner already logged it.
    const from = new Date(`${params.paidOn}T12:00:00`);
    const lo = new Date(from.getTime() - 3 * 86_400_000).toISOString().slice(0, 10);
    const hi = new Date(from.getTime() + 5 * 86_400_000).toISOString().slice(0, 10);
    const { data: alerts } = await supabase
      .from('finance_entries')
      .select('id, extracted')
      .eq('type', 'expense')
      .neq('status', 'void')
      .eq('amount', total)
      .gte('occurred_on', lo)
      .lte('occurred_on', hi);
    const alert = ((alerts as { id: string; extracted: Extracted }[] | null) ?? []).find(
      (a) => a.extracted?.source === 'email-scanner' && !rows.some((r) => r.id === a.id),
    );
    if (alert) {
      const { error } = await supabase
        .from('finance_entries')
        .update({ status: 'void', extracted: { ...(alert.extracted ?? {}), void_reason: `bank side of out-of-pocket pay-back ${batch}` } })
        .eq('id', alert.id);
      voidedAlert = !error;
    }
  }
  return { ok: true, voidedAlert };
}

export type BookGroup = 'Job costs' | 'Overhead' | 'Vehicles & equipment' | 'Other';

export const BOOK_ACCOUNTS = {
  job_materials: { label: 'Job materials', group: 'Job costs', qbo: 'Job materials' },
  job_fuel: { label: 'Job fuel & travel', group: 'Job costs', qbo: 'Job fuel & travel' },
  subcontractors: { label: 'Subcontractors', group: 'Job costs', qbo: 'Subcontractors' },
  job_equipment_rental: { label: 'Job equipment rental', group: 'Job costs', qbo: 'Job equipment rental' },
  permits: { label: 'Permits & fees', group: 'Job costs', qbo: 'Permits & fees' },
  commissions: { label: 'Commissions & referral fees', group: 'Job costs', qbo: 'Commissions & fees' },

  fuel: { label: 'Fuel (vehicles)', group: 'Overhead', qbo: 'Vehicle expenses:Fuel' },
  vehicle_repairs: { label: 'Vehicle repairs & upkeep', group: 'Overhead', qbo: 'Vehicle expenses:Vehicle repairs & maintenance' },
  registration: { label: 'Registration & title', group: 'Overhead', qbo: 'Vehicle expenses:Registration & title' },
  tools: { label: 'Tools & small equipment', group: 'Overhead', qbo: 'Tools & small equipment' },
  supplies: { label: 'Shop supplies', group: 'Overhead', qbo: 'Supplies' },
  insurance: { label: 'Insurance', group: 'Overhead', qbo: 'Insurance' },
  software_phone: { label: 'Software & phone', group: 'Overhead', qbo: 'Software & phone' },
  bank_fees: { label: 'Bank & card fees', group: 'Overhead', qbo: 'Bank & card fees' },
  meals: { label: 'Meals', group: 'Overhead', qbo: 'Meals' },
  advertising: { label: 'Advertising & marketing', group: 'Overhead', qbo: 'Advertising & marketing' },
  office: { label: 'Office', group: 'Overhead', qbo: 'Office expenses' },
  legal_professional: { label: 'Legal & professional', group: 'Overhead', qbo: 'Legal & professional services' },
  contract_labor: { label: 'Contract labor (not a job)', group: 'Overhead', qbo: 'Contract labor' },
  equipment_rental: { label: 'Equipment rental', group: 'Overhead', qbo: 'Equipment rental' },
  taxes_licenses: { label: 'Taxes & licenses', group: 'Overhead', qbo: 'Taxes & licenses (non-payroll)' },
  rent: { label: 'Rent', group: 'Overhead', qbo: 'Building & land rent' },
  utilities: { label: 'Utilities', group: 'Overhead', qbo: 'Utilities' },
  travel: { label: 'Travel (lodging, airfare)', group: 'Overhead', qbo: 'Travel' },
  other: { label: 'Other', group: 'Overhead', qbo: 'Other operating expenses' },

  vehicle_purchase: { label: 'Vehicle purchase (asset)', group: 'Vehicles & equipment', qbo: 'Vehicles' },
  equipment_purchase: { label: 'Equipment purchase (asset)', group: 'Vehicles & equipment', qbo: 'General equipment' },

  owner_draw: { label: 'Personal — owner draw', group: 'Other', qbo: 'Owner draws' },
  uncategorized: { label: 'Needs an account', group: 'Other', qbo: 'Uncategorized Expense' },
} as const satisfies Record<string, { label: string; group: BookGroup; qbo: string }>;

export type BookAccount = keyof typeof BOOK_ACCOUNTS;

export const BOOK_GROUPS: BookGroup[] = ['Job costs', 'Overhead', 'Vehicles & equipment', 'Other'];

export function bookLabel(key: string | null | undefined): string {
  return key && key in BOOK_ACCOUNTS ? BOOK_ACCOUNTS[key as BookAccount].label : 'Needs an account';
}

/** Overhead account → its job-cost twin, used when an expense moves onto a job. */
const TO_JOB: Partial<Record<BookAccount, BookAccount>> = {
  fuel: 'job_fuel',
  supplies: 'job_materials',
  contract_labor: 'subcontractors',
  equipment_rental: 'job_equipment_rental',
  taxes_licenses: 'permits',
};
const TO_OVERHEAD: Partial<Record<BookAccount, BookAccount>> = Object.fromEntries(
  Object.entries(TO_JOB).map(([overhead, job]) => [job, overhead]),
) as Partial<Record<BookAccount, BookAccount>>;

/** The account an expense should carry once it is (or is not) on a job. */
export function accountForPlacement(current: BookAccount, onJob: boolean): BookAccount {
  return (onJob ? TO_JOB[current] : TO_OVERHEAD[current]) ?? current;
}

export interface ReviewJob {
  id: string;
  jobNumber: string | null;
  name: string;
  customerName: string | null;
  isInternal: boolean;
  stage: string | null;
}

export interface ReviewExpense {
  id: string;
  amount: number;
  occurredOn: string;
  /** The merchant as the bank printed it, else the app's description. */
  merchant: string;
  description: string | null;
  counterparty: string | null;
  jobId: string | null;
  job: ReviewJob | null;
  /** True when the expense sits on no job or on the internal "DC Solar Company" job. */
  isOverhead: boolean;
  account: BookAccount;
  accountBy: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  paidFromBank: boolean;
  extracted: Record<string, unknown>;
}

function cleanAlert(text: string | null | undefined): string | null {
  if (!text) return null;
  // Chase alert subjects carry no merchant — drop the boilerplate.
  return text.replace(/Your debit card transaction of \$[\d,.]+ from account ending in \(?\S*\)?/i, '').replace(/You sent \$[\d,.]+ from account ending in \(?\S*\)?/i, '').trim() || null;
}

function toJob(row: Record<string, unknown> | null | undefined): ReviewJob | null {
  if (!row) return null;
  const customer = row.customers as { name?: string | null } | { name?: string | null }[] | null;
  return {
    id: row.id as string,
    jobNumber: (row.job_number as string | null) ?? null,
    name: (row.name as string | null) ?? 'Job',
    customerName: Array.isArray(customer) ? (customer[0]?.name ?? null) : (customer?.name ?? null),
    isInternal: row.is_internal === true,
    stage: (row.stage as string | null) ?? null,
  };
}

/** Every recorded expense, newest first. Admin-only via RLS. */
export async function fetchReviewExpenses(): Promise<ReviewExpense[] | null> {
  const { data, error } = await supabase
    .from('finance_entries')
    .select(
      'id, amount, occurred_on, counterparty, description, job_id, extracted, paid_from_bank, jobs(id, job_number, name, is_internal, stage, customers(name))',
    )
    .eq('company', COMPANY)
    .eq('type', 'expense')
    .neq('status', 'void')
    .order('occurred_on', { ascending: false });
  if (error || !data) return null;
  return (data as Record<string, unknown>[]).map((row) => {
    const extracted = (row.extracted as Record<string, unknown> | null) ?? {};
    const jobRow = row.jobs as Record<string, unknown> | Record<string, unknown>[] | null;
    const job = toJob(Array.isArray(jobRow) ? jobRow[0] : jobRow);
    const key = extracted.book_account as string | undefined;
    const description = (row.description as string | null) ?? null;
    return {
      id: row.id as string,
      amount: Number(row.amount) || 0,
      occurredOn: row.occurred_on as string,
      merchant:
        (extracted.bank_desc as string | undefined) ??
        cleanAlert(description) ??
        (row.counterparty as string | null) ??
        'Card purchase',
      description,
      counterparty: (row.counterparty as string | null) ?? null,
      jobId: (row.job_id as string | null) ?? null,
      job,
      isOverhead: !job || job.isInternal,
      account: key && key in BOOK_ACCOUNTS ? (key as BookAccount) : 'uncategorized',
      accountBy: (extracted.book_account_by as string | undefined) ?? null,
      reviewedAt: (extracted.reviewed_at as string | undefined) ?? null,
      reviewedBy: (extracted.reviewed_by as string | undefined) ?? null,
      paidFromBank: row.paid_from_bank !== false,
      extracted,
    };
  });
}

/** Jobs to move an expense onto, open jobs first. */
export async function fetchReviewJobs(): Promise<ReviewJob[]> {
  const { data } = await supabase
    .from('jobs')
    .select('id, job_number, name, is_internal, stage, customers(name)')
    .eq('company', COMPANY);
  const jobs = ((data as Record<string, unknown>[] | null) ?? []).map((r) => toJob(r)!).filter(Boolean);
  const done = (j: ReviewJob) => (j.stage === 'Complete' ? 1 : 0);
  return jobs.sort(
    (a, b) => Number(b.isInternal) - Number(a.isInternal) || done(a) - done(b) || (b.jobNumber ?? '').localeCompare(a.jobNumber ?? ''),
  );
}

export interface DaySuggestion {
  jobId: string;
  jobNumber: string | null;
  /** Hours logged or clocked on the job that day (0 when only scheduled). */
  hours: number;
  scheduled: boolean;
}

/**
 * Where the crew was on each day between `from` and `to`: hours logged
 * (employee_hours), clocked (time_entries) and jobs on the schedule — so an
 * overhead fuel stop or Home Depot run can be offered the job worked that day.
 */
export async function fetchDaySuggestions(from: string, to: string): Promise<Map<string, DaySuggestion[]>> {
  const [hours, clocks, schedule] = await Promise.all([
    supabase.from('employee_hours').select('occurred_on, hours, job_id, jobs(job_number, is_internal)').gte('occurred_on', from).lte('occurred_on', to),
    supabase.from('time_entries').select('clock_in, clock_out, job_id, jobs(job_number, is_internal)').gte('clock_in', `${from}T00:00:00`).lte('clock_in', `${to}T23:59:59`),
    supabase.from('job_schedule_dates').select('work_date, job_id, jobs(job_number, is_internal)').gte('work_date', from).lte('work_date', to),
  ]);
  const byDay = new Map<string, Map<string, DaySuggestion>>();
  const add = (day: string, jobId: string | null, jobRel: unknown, h: number, scheduled: boolean) => {
    if (!jobId) return;
    const j = (Array.isArray(jobRel) ? jobRel[0] : jobRel) as { job_number?: string | null; is_internal?: boolean } | null;
    if (j?.is_internal) return;
    const day_ = byDay.get(day) ?? new Map<string, DaySuggestion>();
    const s = day_.get(jobId) ?? { jobId, jobNumber: j?.job_number ?? null, hours: 0, scheduled: false };
    s.hours += h;
    s.scheduled ||= scheduled;
    day_.set(jobId, s);
    byDay.set(day, day_);
  };
  for (const r of (hours.data as Record<string, unknown>[] | null) ?? []) {
    add(r.occurred_on as string, r.job_id as string | null, r.jobs, Number(r.hours) || 0, false);
  }
  for (const r of (clocks.data as Record<string, unknown>[] | null) ?? []) {
    const start = new Date(r.clock_in as string);
    const end = r.clock_out ? new Date(r.clock_out as string) : start;
    const day = start.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    add(day, r.job_id as string | null, r.jobs, Math.max(0, (end.getTime() - start.getTime()) / 3_600_000), false);
  }
  for (const r of (schedule.data as Record<string, unknown>[] | null) ?? []) {
    add(r.work_date as string, r.job_id as string | null, r.jobs, 0, true);
  }
  const out = new Map<string, DaySuggestion[]>();
  for (const [day, jobs] of byDay) {
    out.set(day, [...jobs.values()].sort((a, b) => b.hours - a.hours || Number(b.scheduled) - Number(a.scheduled)));
  }
  return out;
}

export type SaveReviewResult = { ok: true } | { ok: false; message: string };

/** Confirm (or change) an expense's job and account, and mark it reviewed. */
export async function saveReview(
  expense: ReviewExpense,
  change: { jobId: string | null; account: BookAccount },
): Promise<SaveReviewResult> {
  const { data: auth } = await supabase.auth.getUser();
  const extracted = {
    ...expense.extracted,
    book_account: change.account,
    book_account_by: change.account === expense.account ? (expense.accountBy ?? 'review') : 'review',
    reviewed_at: new Date().toISOString(),
    reviewed_by: auth.user?.email ?? null,
    ...(change.jobId !== expense.jobId ? { moved_from_job: expense.job?.jobNumber ?? null } : {}),
  };
  const { error } = await supabase
    .from('finance_entries')
    .update({ job_id: change.jobId, extracted })
    .eq('id', expense.id);
  return error ? { ok: false, message: error.message } : { ok: true };
}
