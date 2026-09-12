/**
 * Valuation — the three daily series behind the Financials stock chart
 * (revenue, profit, company value) plus the fixed-asset / liability rows that
 * feed the value line.
 *
 * Pure builders over rows the screen has ALREADY fetched (`fetchFinancials`,
 * `fetchPipelineJobs`, `fetchCompanyTotals`, `fetchCompanySettings`). Nothing
 * here stores a series: every point is recomputed from rows on every call, so
 * adding a payment, a payroll run or a vehicle moves the chart the next time
 * the screen loads (and, with `useFinanceRealtime`, the moment the row lands).
 *
 * The formulas in words live in docs/VALUATION.md — keep the two in step.
 *
 * Conventions borrowed from lib/financials.ts, on purpose:
 *   - a "payment" row is revenue, whatever job it sits on — including the
 *     Company container. The app FLAGS a payment there as a misfiling but
 *     still counts it in `paid` (the money is real, only the job is wrong),
 *     so the chart counts it too and never disagrees with the tiles.
 *   - `finance_entries.status = 'void'` marks a cancelled row. fetchFinancials
 *     excludes those before they reach `entries`, so this module — like every
 *     other ledger — never sees one; every other status is summed.
 *   - `investment` rows are owner capital: never revenue, never a cost.
 *   - labor = recorded payroll runs (money that actually left the bank) plus
 *     the loaded estimate for hours after the newest run's period end.
 */

import { loadedLaborCost } from '@/lib/laborCost';
import type { LaborRun, LedgerEntry } from '@/lib/financials';
import { CONTRACTED_STAGES } from '@/lib/pipeline';
import { isCompanyJob, stageOrDefault } from '@/lib/stages';
import { supabase } from '@/lib/supabase';
import type { Job } from '@/lib/types';

const COMPANY = 'dc-solar';
const DAY_MS = 86_400_000;

/** First day on the chart — the company's books start here. */
export const SERIES_START = '2026-07-01';

export type SeriesKey = 'revenue' | 'profit' | 'value';

export interface SeriesPoint {
  /** YYYY-MM-DD (local calendar day). */
  day: string;
  value: number;
}

// ---------------------------------------------------------------------------
// Fixed assets and liabilities
// ---------------------------------------------------------------------------

export type AssetCategory = 'vehicle' | 'tool' | 'equipment' | 'other';
export type LiabilityKind = 'loan' | 'credit' | 'other';

export interface CompanyAsset {
  id: string;
  name: string;
  category: AssetCategory;
  purchaseDate: string; // YYYY-MM-DD
  cost: number;
  usefulLifeYears: number;
  salvageValue: number;
  disposedOn: string | null;
  note: string | null;
}

export interface CompanyLiability {
  id: string;
  name: string;
  kind: LiabilityKind;
  balance: number;
  asOf: string; // YYYY-MM-DD
  monthlyPayment: number | null;
  note: string | null;
}

/** Default straight-line life by category (years). Change here, not in the UI. */
export const DEFAULT_LIFE_YEARS: Record<AssetCategory, number> = {
  vehicle: 7,
  tool: 5,
  equipment: 5,
  other: 5,
};

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function noonMs(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getTime();
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

/**
 * Straight-line book value of one asset on a given day. Zero before purchase
 * and from the disposal day on; never below salvage.
 */
export function assetBookValue(asset: CompanyAsset, day: string): number {
  if (asset.purchaseDate > day) return 0;
  if (asset.disposedOn && asset.disposedOn <= day) return 0;
  const lifeDays = Math.max(asset.usefulLifeYears, 0.1) * 365.25;
  const age = Math.max(0, (noonMs(day) - noonMs(asset.purchaseDate)) / DAY_MS);
  const depreciable = Math.max(asset.cost - asset.salvageValue, 0);
  const written = depreciable * Math.min(1, age / lifeDays);
  return Math.max(asset.cost - written, asset.salvageValue);
}

/** Liabilities are subtracted at face value on every day of the series. */
export function liabilityBalance(liability: CompanyLiability, _day: string): number {
  return liability.balance;
}

export async function fetchCompanyAssets(): Promise<CompanyAsset[] | null> {
  try {
    const { data, error } = await supabase
      .from('company_assets')
      .select('id, name, category, purchase_date, cost, useful_life_years, salvage_value, disposed_on, note')
      .eq('company', COMPANY)
      .order('purchase_date', { ascending: false });
    if (error || !data) return null;
    return (data as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ''),
      category: (r.category as AssetCategory) ?? 'other',
      purchaseDate: String(r.purchase_date ?? ''),
      cost: num(r.cost),
      usefulLifeYears: num(r.useful_life_years) || 5,
      salvageValue: num(r.salvage_value),
      disposedOn: (r.disposed_on as string | null) ?? null,
      note: (r.note as string | null) ?? null,
    }));
  } catch {
    return null;
  }
}

export async function fetchCompanyLiabilities(): Promise<CompanyLiability[] | null> {
  try {
    const { data, error } = await supabase
      .from('company_liabilities')
      .select('id, name, kind, balance, as_of, monthly_payment, note')
      .eq('company', COMPANY)
      .order('balance', { ascending: false });
    if (error || !data) return null;
    return (data as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      name: String(r.name ?? ''),
      kind: (r.kind as LiabilityKind) ?? 'other',
      balance: num(r.balance),
      asOf: String(r.as_of ?? ''),
      monthlyPayment: r.monthly_payment == null ? null : num(r.monthly_payment),
      note: (r.note as string | null) ?? null,
    }));
  } catch {
    return null;
  }
}

export type SaveResult = { ok: true } | { ok: false; message: string };

export interface AssetInput {
  name: string;
  category: AssetCategory;
  purchaseDate: string;
  cost: number;
  usefulLifeYears: number;
  salvageValue: number;
  disposedOn: string | null;
  note: string | null;
}

export interface LiabilityInput {
  name: string;
  kind: LiabilityKind;
  balance: number;
  asOf: string;
  monthlyPayment: number | null;
  note: string | null;
}

function assetRow(input: AssetInput) {
  return {
    name: input.name,
    category: input.category,
    purchase_date: input.purchaseDate,
    cost: input.cost,
    useful_life_years: input.usefulLifeYears,
    salvage_value: input.salvageValue,
    disposed_on: input.disposedOn,
    note: input.note,
  };
}

function liabilityRow(input: LiabilityInput) {
  return {
    name: input.name,
    kind: input.kind,
    balance: input.balance,
    as_of: input.asOf,
    monthly_payment: input.monthlyPayment,
    note: input.note,
  };
}

async function wrap(run: () => Promise<{ error: { message: string } | null }>): Promise<SaveResult> {
  try {
    const { error } = await run();
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save.' };
  }
}

export function saveAsset(input: AssetInput, id?: string | null): Promise<SaveResult> {
  return wrap(async () =>
    id
      ? supabase.from('company_assets').update(assetRow(input)).eq('id', id)
      : supabase.from('company_assets').insert({ company: COMPANY, ...assetRow(input) }),
  );
}

export function deleteAsset(id: string): Promise<SaveResult> {
  return wrap(async () => supabase.from('company_assets').delete().eq('id', id));
}

export function saveLiability(input: LiabilityInput, id?: string | null): Promise<SaveResult> {
  return wrap(async () =>
    id
      ? supabase.from('company_liabilities').update(liabilityRow(input)).eq('id', id)
      : supabase.from('company_liabilities').insert({ company: COMPANY, ...liabilityRow(input) }),
  );
}

export function deleteLiability(id: string): Promise<SaveResult> {
  return wrap(async () => supabase.from('company_liabilities').delete().eq('id', id));
}

// ---------------------------------------------------------------------------
// Gross wages per day — the one input the Financials screen does not already
// hold per day. Same three sources, same pricing as lib/financials.ts:
// employee_hours (hours × stamped rate) + completed time_entries (duration ×
// roster pay_rate, matched by email), bucketed by Kansas City calendar day.
// ---------------------------------------------------------------------------

export async function fetchDailyGrossWages(): Promise<Map<string, number> | null> {
  try {
    const [hoursResult, timeResult, employeesResult] = await Promise.all([
      supabase.from('employee_hours').select('hours, rate, occurred_on').eq('company', COMPANY),
      supabase.from('time_entries').select('employee, clock_in, clock_out').eq('company', COMPANY),
      supabase.from('employees').select('email, pay_rate').eq('is_test', false),
    ]);
    if (hoursResult.error || timeResult.error || employeesResult.error) return null;
    const byDay = new Map<string, number>();
    const bump = (day: string, gross: number) => byDay.set(day, (byDay.get(day) ?? 0) + gross);
    for (const row of (hoursResult.data ?? []) as {
      hours: unknown;
      rate: unknown;
      occurred_on: string | null;
    }[]) {
      if (!row.occurred_on) continue;
      bump(row.occurred_on, num(row.hours) * num(row.rate));
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
      if (!row.clock_in || !row.clock_out) continue;
      const ms = new Date(row.clock_out).getTime() - new Date(row.clock_in).getTime();
      if (!Number.isFinite(ms) || ms <= 0) continue;
      const day = new Date(row.clock_in).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      const rate = rateByEmail.get((row.employee ?? '').toLowerCase());
      if (rate != null) bump(day, (ms / 3_600_000) * rate);
    }
    return byDay;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The series
// ---------------------------------------------------------------------------

export interface ValuationInputs {
  /** Every finance_entries row (`FinancialsData.allEntries`). */
  entries: LedgerEntry[];
  /** Recorded payroll runs (`FinancialsData.laborRuns`). */
  runs: LaborRun[];
  /** Gross wages per day (`fetchDailyGrossWages`). Null → accrual skipped. */
  dailyGross: Map<string, number> | null;
  /** Every job, for stages and the Company container. */
  jobs: Job[];
  /** The Pipeline's "Avg Profit" (`CompanyTotals.avgProfitPct`). Null → backlog worth 0. */
  avgProfitPct: number | null;
  /** The anchored bank balance (`fetchCompanySettings`). */
  settings: { bankBalance: number | null; bankBalanceAsOf: string | null; anchorAt: string | null } | null;
  assets: CompanyAsset[];
  liabilities: CompanyLiability[];
  /** Override for tests; defaults to the local calendar day. */
  today?: string;
}

/** Where today's company value comes from — the caption under the chart. */
export interface ValueBreakdown {
  cash: number;
  /** False when no bank balance has ever been anchored (cash = net bank flows). */
  cashAnchored: boolean;
  receivables: number;
  backlog: number;
  assets: number;
  liabilities: number;
  total: number;
}

export interface ValuationSeries {
  revenue: SeriesPoint[];
  profit: SeriesPoint[];
  value: SeriesPoint[];
  breakdown: ValueBreakdown;
}

/** Every calendar day from SERIES_START through `today`, inclusive. */
export function seriesDays(today: string): string[] {
  const days: string[] = [];
  if (today < SERIES_START) return days;
  for (let ms = noonMs(SERIES_START); ; ms += DAY_MS) {
    const day = isoFromMs(ms);
    if (day > today) break;
    days.push(day);
  }
  return days;
}

/**
 * Which way a finance row moves the BANK, if it moves it at all. Mirrors the
 * Cash Position panel's adjustment rule: payments and capital always move the
 * account; an expense only when it was paid from the account (not out of
 * pocket); documents (estimate / invoice / contract) never do.
 */
function bankFlow(e: LedgerEntry): number {
  switch (e.type) {
    case 'payment':
      return e.amount;
    case 'expense':
      return e.paid_from_bank ? -e.amount : 0;
    case 'investment':
      return e.direction === 'out' ? -e.amount : e.amount;
    default:
      return 0;
  }
}

/**
 * Build the three cumulative daily series. One pass per input list; each
 * output is `days.length` points long, so the chart can index them together.
 */
export function buildValuationSeries(inputs: ValuationInputs): ValuationSeries {
  const today = inputs.today ?? localToday();
  const days = seriesDays(today);
  const n = days.length;
  const idx = new Map<string, number>();
  days.forEach((d, i) => idx.set(d, i));

  // Per-day deltas, then a prefix sum. A row dated before SERIES_START lands
  // in the first bucket (it is part of the cumulative total on day one); a
  // row dated after today is ignored (it hasn't happened on the chart yet).
  const bucket = (day: string | null): number => {
    if (n === 0) return -1;
    if (!day || day < SERIES_START) return 0;
    if (day > today) return -1;
    return idx.get(day) ?? -1;
  };

  const revenueDelta = new Array<number>(n).fill(0);
  const expenseDelta = new Array<number>(n).fill(0);
  const paidRunDelta = new Array<number>(n).fill(0);

  const invoicedByJob = new Map<string, number[]>();
  const paidByJob = new Map<string, number[]>();
  const perJob = (map: Map<string, number[]>, jobId: string): number[] => {
    let arr = map.get(jobId);
    if (!arr) {
      arr = new Array<number>(n).fill(0);
      map.set(jobId, arr);
    }
    return arr;
  };

  for (const e of inputs.entries) {
    const b = bucket(e.occurred_on);
    if (b < 0) continue;
    if (e.type === 'payment') {
      revenueDelta[b] += e.amount;
      if (e.job_id) perJob(paidByJob, e.job_id)[b] += e.amount;
    } else if (e.type === 'expense') {
      expenseDelta[b] += e.amount;
    } else if (e.type === 'invoice' && e.job_id) {
      perJob(invoicedByJob, e.job_id)[b] += e.amount;
    }
  }

  // Payroll: a run counts on its PAYDAY (the money left the bank that day).
  // `paidThroughByDay[i]` = the newest period_end covered by a run paid on or
  // before day i — hours after it are still accruing on that day.
  const runsByPayday = [...inputs.runs].sort((a, b) => a.payday.localeCompare(b.payday));
  const paidThroughByDay = new Array<string>(n).fill('');
  {
    let cursor = 0;
    let through = '';
    for (const run of runsByPayday) {
      if (run.kind === 'regular' && run.payday < SERIES_START && run.periodEnd > through) through = run.periodEnd;
    }
    for (let i = 0; i < n; i++) {
      while (cursor < runsByPayday.length && runsByPayday[cursor].payday <= days[i]) {
        const run = runsByPayday[cursor];
        const b = bucket(run.payday);
        if (b >= 0) paidRunDelta[b] += run.totalWithdrawn;
        if (run.kind === 'regular' && run.periodEnd > through) through = run.periodEnd;
        cursor += 1;
      }
      paidThroughByDay[i] = through;
    }
  }

  // Gross wages per day, as a prefix sum keyed by day index, so the accrual
  // for "hours after paidThrough up to day i" is one subtraction.
  const grossPrefix = new Array<number>(n + 1).fill(0);
  const grossBeforeStart = (() => {
    let sum = 0;
    for (const [day, gross] of inputs.dailyGross ?? []) if (day < SERIES_START) sum += gross;
    return sum;
  })();
  for (let i = 0; i < n; i++) {
    grossPrefix[i + 1] = grossPrefix[i] + (inputs.dailyGross?.get(days[i]) ?? 0);
  }
  /** Σ gross wages on days d with `through < d ≤ days[i]`. */
  const accruedGross = (i: number, through: string): number => {
    const upTo = grossPrefix[i + 1] + grossBeforeStart;
    if (!through) return upTo;
    if (through >= days[i]) return 0;
    const t = through < SERIES_START ? -1 : (idx.get(through) ?? -1);
    // `through` is a real payroll period end, so it is always a calendar day
    // in the index once it is inside the series window.
    const paidPart = t < 0 ? grossBeforeStart : grossPrefix[t + 1] + grossBeforeStart;
    return Math.max(0, upTo - paidPart);
  };

  // Stages as of today (the app keeps a stage history, but the chart uses the
  // current board — documented in docs/VALUATION.md).
  const stageById = new Map<string, string>();
  for (const job of inputs.jobs) {
    if (isCompanyJob(job)) continue;
    stageById.set(job.id, stageOrDefault(job.stage, job.status));
  }
  const margin = Math.max(0, (inputs.avgProfitPct ?? 0) / 100);

  // Cash: walk out from the anchored balance. Rows the anchor already
  // reflects (created before it) are UNDONE for days before they occurred;
  // rows added after the anchor are APPLIED from the day they occurred.
  // Payroll runs are not finance rows, so they are keyed on the as-of date.
  const settings = inputs.settings;
  const anchored = settings?.bankBalance != null;
  const anchorAt = settings?.anchorAt ?? '';
  const asOf = settings?.bankBalanceAsOf ?? today;
  const cashDelta = new Array<number>(n).fill(0); // applied forward from day
  const cashUndo = new Array<number>(n).fill(0); // undone for days before
  let cashBase = anchored ? (settings?.bankBalance ?? 0) : 0;
  for (const e of inputs.entries) {
    const flow = bankFlow(e);
    if (flow === 0) continue;
    const day = e.occurred_on ?? '';
    if (!anchored) {
      // No anchor: cash is the running net of every bank flow ever recorded.
      const b = bucket(e.occurred_on);
      if (b >= 0) cashDelta[b] += flow;
      else if (day && day < SERIES_START) cashBase += flow;
      continue;
    }
    const reflected = !e.created_at || !anchorAt || e.created_at <= anchorAt;
    if (reflected) {
      // Already inside the balance. Walking backwards past its date removes it.
      const b = bucket(e.occurred_on);
      if (b >= 0) cashUndo[b] += flow;
    } else {
      const b = bucket(e.occurred_on);
      if (b >= 0) cashDelta[b] += flow;
      else if (day && day < SERIES_START) cashBase += flow;
    }
  }
  for (const run of inputs.runs) {
    const b = bucket(run.payday);
    if (!anchored) {
      if (b >= 0) cashDelta[b] -= run.totalWithdrawn;
      else if (run.payday < SERIES_START) cashBase -= run.totalWithdrawn;
    } else if (run.payday <= asOf) {
      if (b >= 0) cashUndo[b] -= run.totalWithdrawn;
    } else if (b >= 0) {
      cashDelta[b] -= run.totalWithdrawn;
    }
  }
  // Undo prefix: cash on day i = base + Σ delta[≤i] − Σ undo[>i].
  const undoSuffix = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) undoSuffix[i] = undoSuffix[i + 1] + cashUndo[i];

  const revenue: SeriesPoint[] = [];
  const profit: SeriesPoint[] = [];
  const value: SeriesPoint[] = [];
  let rev = 0;
  let exp = 0;
  let paidRuns = 0;
  let cashRun = 0;
  let breakdown: ValueBreakdown = {
    cash: 0,
    cashAnchored: anchored,
    receivables: 0,
    backlog: 0,
    assets: 0,
    liabilities: 0,
    total: 0,
  };

  const invoicedCum = new Map<string, number>();
  const paidCum = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    const day = days[i];
    rev += revenueDelta[i];
    exp += expenseDelta[i];
    paidRuns += paidRunDelta[i];
    cashRun += cashDelta[i];

    const labor = paidRuns + loadedLaborCost(accruedGross(i, paidThroughByDay[i]));
    revenue.push({ day, value: rev });
    profit.push({ day, value: rev - exp - labor });

    // Receivables + backlog from per-job cumulative invoice/payment totals.
    let receivables = 0;
    let backlog = 0;
    for (const [jobId, stage] of stageById) {
      const invArr = invoicedByJob.get(jobId);
      const paidArr = paidByJob.get(jobId);
      if (!invArr && !paidArr) continue;
      const inv = (invoicedCum.get(jobId) ?? 0) + (invArr?.[i] ?? 0);
      const paid = (paidCum.get(jobId) ?? 0) + (paidArr?.[i] ?? 0);
      invoicedCum.set(jobId, inv);
      paidCum.set(jobId, paid);
      if (stage === 'Pending Payment' || stage === 'Complete') {
        receivables += Math.max(inv - paid, 0);
      } else if ((CONTRACTED_STAGES as readonly string[]).includes(stage)) {
        backlog += Math.max(inv * margin, 0);
      }
    }

    let assets = 0;
    for (const a of inputs.assets) assets += assetBookValue(a, day);
    let liabilities = 0;
    for (const l of inputs.liabilities) liabilities += liabilityBalance(l, day);

    const cash = cashBase + cashRun - undoSuffix[i + 1];
    const total = cash + receivables + backlog + assets - liabilities;
    value.push({ day, value: total });
    if (i === n - 1) {
      breakdown = { cash, cashAnchored: anchored, receivables, backlog, assets, liabilities, total };
    }
  }

  return { revenue, profit, value, breakdown };
}
