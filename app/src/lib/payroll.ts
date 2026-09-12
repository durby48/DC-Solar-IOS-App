/**
 * Hours tab data — admin-only payroll overview (Devon + Isaiah).
 *
 * Combines BOTH hour sources the app already uses for labor math:
 *   - employee_hours rows (manual logs; hours × their stamped rate)
 *   - completed time_entries (clock in/out; duration × roster pay_rate)
 *
 * Pay cycle (confirmed by Devon 2026-08-04): a period is SUBMITTED the
 * Wednesday after it closes and PAID the Friday after it closes. The period
 * that ended Mon 2026-08-03 is submitted Wed 08-05 and paid Fri 08-07.
 *
 * Payroll periods: everything before 2026-07-18 was paid out and
 * reconciled before this tab existed — it appears as one "Before Jul 18"
 * bucket. The first tracked period is the catch-up 2026-07-18 →
 * 2026-08-03; after that, clean 14-day periods start 2026-08-04
 * (Aug 4–17, Aug 18–31, …). The tab can page through every period; jobs
 * that span periods (e.g. DC-26011 removal paid before 7/18, reinstall
 * after) show a per-job split of hours already paid vs. this period.
 */

import { todayISO } from '@/lib/dates';
import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

/**
 * Calendar day of a clock-in, in Kansas City time (2026-09-12). Payroll
 * periods are local days, and `clock_in.slice(0, 10)` was the UTC day — an
 * evening clock-in after 7 pm CDT landed on tomorrow's date, which at a
 * period boundary moved the shift into the wrong payroll. lib/financials.ts
 * already buckets this way; the two now agree.
 */
function localDay(timestamp: string): string {
  return new Date(timestamp).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

/** Everything before this date was paid/reconciled outside the app. */
const FIRST_PERIOD_START = '2026-07-18';
const FIRST_PERIOD_END = '2026-08-03';
/** Biweekly periods begin the day after the catch-up period ends. */
const BIWEEKLY_ANCHOR = '2026-08-04';
const DAY_MS = 86_400_000;

export interface PayrollPeriod {
  /** YYYY-MM-DD inclusive ('' for the pre-tracking bucket's open start). */
  start: string;
  /** YYYY-MM-DD, inclusive. */
  end: string;
  /** Compact display label, e.g. "Jul 18 – Aug 3" or "Before Jul 18". */
  label: string;
  /** True for the period containing today. */
  current: boolean;
  /** True for the paid-before-tracking bucket. */
  pre: boolean;
  /**
   * The Wednesday after the period ends — the day Devon submits payroll.
   * Null for the pre-tracking bucket (paid via the old spreadsheet).
   */
  submitOn: string | null;
  /** The Friday after the period ends — the day the crew is actually paid. */
  payOn: string | null;
}

/**
 * Where a period sits in the payroll cycle:
 *   current         — still accruing hours
 *   awaiting-submit — period closed, Devon hasn't submitted it yet
 *   submitted       — submitted, payday hasn't arrived
 *   paid            — payday has passed (or it predates tracking)
 */
export type PayrollState = 'current' | 'awaiting-submit' | 'submitted' | 'paid';

const WEDNESDAY = 3;
const FRIDAY = 5;

/** First date strictly AFTER `afterIso` that falls on `targetDow` (0=Sun). */
function nextDayOfWeek(afterIso: string, targetDow: number): string {
  const ms = dayMs(afterIso);
  const dow = new Date(ms).getUTCDay();
  const delta = ((targetDow - dow + 7) % 7) || 7;
  return isoFromMs(ms + delta * DAY_MS);
}

export function payrollState(period: PayrollPeriod, todayIso?: string): PayrollState {
  // Local date, not UTC (2026-09-12): a period "closed" 7 hours early before.
  const today = todayIso ?? todayISO();
  if (period.pre) return 'paid';
  if (today <= period.end) return 'current';
  if (period.submitOn && today < period.submitOn) return 'awaiting-submit';
  if (period.payOn && today < period.payOn) return 'submitted';
  return 'paid';
}

/** "Fri, Aug 7" — the format used on the payroll card. */
export function formatPayrollDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Noon-UTC epoch for a YYYY-MM-DD (avoids timezone off-by-one). */
function dayMs(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getTime();
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "2026-07-18" → "Jul 18". */
function monthDay(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function rangeLabel(start: string, end: string): string {
  return `${monthDay(start)} – ${monthDay(end)}`;
}

/**
 * Every payroll period from the pre-tracking bucket through the period
 * containing today, oldest first (the current period is always last).
 */
export function listPayrollPeriods(todayIso?: string): PayrollPeriod[] {
  const today = todayIso ?? todayISO();
  const preEnd = isoFromMs(dayMs(FIRST_PERIOD_START) - DAY_MS);
  const periods: PayrollPeriod[] = [
    {
      start: '',
      end: preEnd,
      label: `Before ${monthDay(FIRST_PERIOD_START)}`,
      current: false,
      pre: true,
      submitOn: null,
      payOn: null,
    },
    {
      start: FIRST_PERIOD_START,
      end: FIRST_PERIOD_END,
      label: rangeLabel(FIRST_PERIOD_START, FIRST_PERIOD_END),
      current: today <= FIRST_PERIOD_END,
      pre: false,
      submitOn: nextDayOfWeek(FIRST_PERIOD_END, WEDNESDAY),
      payOn: nextDayOfWeek(FIRST_PERIOD_END, FRIDAY),
    },
  ];
  let startMs = dayMs(BIWEEKLY_ANCHOR);
  while (isoFromMs(startMs) <= today) {
    const start = isoFromMs(startMs);
    const end = isoFromMs(startMs + 13 * DAY_MS);
    periods.push({
      start,
      end,
      label: rangeLabel(start, end),
      current: today >= start && today <= end,
      pre: false,
      submitOn: nextDayOfWeek(end, WEDNESDAY),
      payOn: nextDayOfWeek(end, FRIDAY),
    });
    startMs += 14 * DAY_MS;
  }
  return periods;
}

/** One normalized hour entry from either source. */
export interface RawHourEntry {
  name: string;
  date: string; // YYYY-MM-DD
  hours: number;
  rate: number | null;
  jobId: string | null;
}

export interface HoursData {
  entries: RawHourEntry[];
  /** job id → DC-26### (or name) label. */
  jobLabels: Map<string, string>;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fetch every hour entry once, normalized. The screen aggregates per
 * selected period client-side (instant period switching). Null on any
 * fetch failure (non-admin RLS / offline).
 */
export async function fetchHoursData(): Promise<HoursData | null> {
  try {
    const [hoursRes, timeRes, employeesRes, jobsRes] = await Promise.all([
      supabase
        .from('employee_hours')
        .select('employee, email, hours, rate, occurred_on, job_id')
        .eq('company', COMPANY),
      supabase
        .from('time_entries')
        .select('employee, clock_in, clock_out, job_id')
        .eq('company', COMPANY),
      supabase.from('employees').select('email, display_name, pay_rate').eq('is_test', false),
      supabase.from('jobs').select('id, job_number, name').eq('company', COMPANY),
    ]);
    if (hoursRes.error || timeRes.error || employeesRes.error || jobsRes.error) return null;

    const nameByEmail = new Map<string, string>();
    const rateByEmail = new Map<string, number>();
    for (const row of (employeesRes.data ?? []) as {
      email: string | null;
      display_name: string | null;
      pay_rate: unknown;
    }[]) {
      const email = row.email?.toLowerCase();
      if (!email) continue;
      if (row.display_name) nameByEmail.set(email, row.display_name);
      if (row.pay_rate != null) rateByEmail.set(email, num(row.pay_rate));
    }

    const jobLabels = new Map<string, string>();
    for (const job of (jobsRes.data ?? []) as {
      id: string;
      job_number: string | null;
      name: string | null;
    }[]) {
      jobLabels.set(job.id, job.job_number ?? job.name ?? 'Job');
    }

    const entries: RawHourEntry[] = [];

    for (const row of (hoursRes.data ?? []) as {
      employee: string | null;
      email: string | null;
      hours: unknown;
      rate: unknown;
      occurred_on: string | null;
      job_id: string | null;
    }[]) {
      const hours = num(row.hours);
      if (!(hours > 0) || !row.occurred_on) continue;
      const email = row.email?.toLowerCase();
      const name =
        row.employee ?? (email ? (nameByEmail.get(email) ?? row.email) : null) ?? 'Unassigned';
      const rate = num(row.rate) > 0 ? num(row.rate) : (email ? rateByEmail.get(email) : undefined);
      entries.push({
        name,
        date: row.occurred_on,
        hours,
        rate: rate ?? null,
        jobId: row.job_id,
      });
    }

    for (const row of (timeRes.data ?? []) as {
      employee: string | null; // email
      clock_in: string | null;
      clock_out: string | null;
      job_id: string | null;
    }[]) {
      if (!row.clock_in || !row.clock_out) continue; // only completed shifts
      const ms = new Date(row.clock_out).getTime() - new Date(row.clock_in).getTime();
      if (!Number.isFinite(ms) || ms <= 0) continue;
      const email = row.employee?.toLowerCase() ?? null;
      entries.push({
        name: (email ? nameByEmail.get(email) : null) ?? row.employee ?? 'Unassigned',
        date: localDay(row.clock_in),
        hours: ms / 3_600_000,
        rate: email ? (rateByEmail.get(email) ?? null) : null,
        jobId: row.job_id,
      });
    }

    return { entries, jobLabels };
  } catch {
    return null;
  }
}

export interface EmployeeJobHours {
  /**
   * jobs.id — the Hours tab links each per-job row to
   * `/job/[id]?focus=hours`, so this must be the real uuid. Null for hours
   * logged with no job ("No job" row, which is not a link).
   */
  jobId: string | null;
  /** DC-26### when known, else job name, else "No job". */
  label: string;
  /** Hours inside the viewed period. */
  periodHours: number;
  /** Hours dated before the viewed period started (already paid). */
  paidHours: number;
}

export interface EmployeeHoursSummary {
  name: string;
  ytdHours: number;
  periodHours: number;
  /** Dollars for the period: hours × rate per entry. */
  periodPay: number;
  /** True when some period hours had no known rate (pay is understated). */
  periodPayIncomplete: boolean;
  /** Jobs touched in or before the period, biggest period share first. */
  jobs: EmployeeJobHours[];
}

export interface HoursOverview {
  period: PayrollPeriod;
  employees: EmployeeHoursSummary[];
  totalPeriodHours: number;
  totalPeriodPay: number;
}

/** Aggregate the raw entries for one payroll period (pure, instant). */
export function summarizePeriod(data: HoursData, period: PayrollPeriod): HoursOverview {
  const year = period.end.slice(0, 4);

  interface JobBucket {
    periodHours: number;
    paidHours: number;
  }
  interface Bucket {
    ytdHours: number;
    periodHours: number;
    periodPay: number;
    periodPayIncomplete: boolean;
    jobs: Map<string, JobBucket>; // '' = no job
  }
  const people = new Map<string, Bucket>();

  for (const entry of data.entries) {
    let b = people.get(entry.name);
    if (!b) {
      b = { ytdHours: 0, periodHours: 0, periodPay: 0, periodPayIncomplete: false, jobs: new Map() };
      people.set(entry.name, b);
    }
    if (entry.date.startsWith(year)) b.ytdHours += entry.hours;

    const inPeriod = entry.date >= period.start && entry.date <= period.end;
    const beforePeriod = period.start !== '' && entry.date < period.start;
    if (inPeriod) {
      b.periodHours += entry.hours;
      if (entry.rate != null && entry.rate > 0) b.periodPay += entry.hours * entry.rate;
      else b.periodPayIncomplete = true;
    }
    if (inPeriod || beforePeriod) {
      const key = entry.jobId ?? '';
      const jb = b.jobs.get(key) ?? { periodHours: 0, paidHours: 0 };
      if (inPeriod) jb.periodHours += entry.hours;
      else jb.paidHours += entry.hours;
      b.jobs.set(key, jb);
    }
  }

  const employees: EmployeeHoursSummary[] = [...people.entries()]
    .map(([name, b]) => ({
      name,
      ytdHours: b.ytdHours,
      periodHours: b.periodHours,
      periodPay: b.periodPay,
      periodPayIncomplete: b.periodPayIncomplete,
      jobs: [...b.jobs.entries()]
        .filter(([, jb]) => jb.periodHours > 0 || jb.paidHours > 0)
        .map(([key, jb]) => ({
          jobId: key === '' ? null : key,
          label: key === '' ? 'No job' : (data.jobLabels.get(key) ?? 'Job'),
          periodHours: jb.periodHours,
          paidHours: jb.paidHours,
        }))
        .sort((a, b2) => b2.periodHours - a.periodHours || b2.paidHours - a.paidHours),
    }))
    .filter((e) => e.periodHours > 0 || e.ytdHours > 0)
    .sort((a, b2) => b2.periodHours - a.periodHours || b2.ytdHours - a.ytdHours);

  let totalPeriodHours = 0;
  let totalPeriodPay = 0;
  for (const e of employees) {
    totalPeriodHours += e.periodHours;
    totalPeriodPay += e.periodPay;
  }

  return { period, employees, totalPeriodHours, totalPeriodPay };
}

// ---------------------------------------------------------------------------
// Recorded payroll runs (payroll_runs table, admin-only)
// ---------------------------------------------------------------------------

/** One completed Gusto run as recorded for the Financials rollup. */
export interface PayrollRun {
  id: string;
  period_start: string;
  period_end: string;
  payday: string;
  gross_wages: number;
  total_withdrawn: number;
  receipt_id: string | null;
  /** regular = scheduled crew period; off_cycle = a correction / transition run. */
  kind: 'regular' | 'off_cycle';
}

/**
 * Every recorded run, newest payday first. One row per Gusto receipt
 * (2026-09-12): a period can hold its regular run AND any number of off-cycle
 * corrections, so this is a list, not a map keyed by period_end — that map
 * let Ben's one-person correction pose as the whole crew's run. Empty on any
 * error.
 */
export async function fetchPayrollRuns(): Promise<PayrollRun[]> {
  try {
    const { data, error } = await supabase
      .from('payroll_runs')
      .select('id, period_start, period_end, payday, gross_wages, total_withdrawn, receipt_id, kind')
      .eq('company', COMPANY)
      .order('payday', { ascending: false });
    if (error || !data) return [];
    return (data as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      period_start: row.period_start as string,
      period_end: row.period_end as string,
      payday: row.payday as string,
      gross_wages: Number(row.gross_wages) || 0,
      total_withdrawn: Number(row.total_withdrawn) || 0,
      receipt_id: (row.receipt_id as string | null) ?? null,
      kind: row.kind === 'off_cycle' ? 'off_cycle' : 'regular',
    }));
  } catch {
    return [];
  }
}

export interface PeriodRuns {
  /**
   * The crew-wide run for the period — the regular run whose period_end
   * falls inside it (the 08/18–08/28 transition run belongs to the app's
   * Aug 18–31 period even though it closed early). Newest period_end wins
   * if there is somehow more than one.
   */
  regular: PayrollRun | undefined;
  /** Corrections / one-person runs whose period_end falls inside the period. */
  offCycle: PayrollRun[];
}

/** Split the recorded runs into what belongs to one Hours-tab period. */
export function runsForPeriod(runs: PayrollRun[], period: PayrollPeriod): PeriodRuns {
  if (period.pre) return { regular: undefined, offCycle: [] };
  const inPeriod = runs.filter((r) => r.period_end >= period.start && r.period_end <= period.end);
  const regulars = inPeriod
    .filter((r) => r.kind === 'regular')
    .sort((a, b) => b.period_end.localeCompare(a.period_end));
  return {
    regular: regulars[0],
    offCycle: inPeriod.filter((r) => r.kind === 'off_cycle'),
  };
}

export type RecordRunResult = { ok: true } | { ok: false; message: string };

/** Postgres unique_violation, surfaced by PostgREST as the error code. */
const UNIQUE_VIOLATION = '23505';

/**
 * Record (or correct) a completed payroll run. Pass `id` to edit a run the
 * screen already shows; otherwise the row is upserted on
 * (company, period_end, receipt_id) — one row per Gusto receipt — so
 * re-saving the same receipt fixes a typo instead of erroring, and a second
 * run for the same period (an off-cycle correction) gets its own row instead
 * of overwriting the first.
 *
 * A REGULAR run advances `company_settings.payroll_through` (forward only) so
 * the accrual estimate in lib/financials.ts and the cash position stop
 * counting the period's wages as unpaid. An off-cycle run never moves it: it
 * paid one person, not the crew. Admin-only via RLS.
 */
export async function recordPayrollRun(params: {
  /** Existing payroll_runs.id when editing; omit to record a new run. */
  id?: string;
  periodStart: string;
  periodEnd: string;
  payday: string;
  grossWages: number;
  totalWithdrawn: number;
  receiptId: string | null;
  /** Defaults to regular; off-cycle corrections never advance "paid through". */
  kind?: 'regular' | 'off_cycle';
}): Promise<RecordRunResult> {
  try {
    const kind = params.kind ?? 'regular';
    const row = {
      company: COMPANY,
      period_start: params.periodStart,
      period_end: params.periodEnd,
      payday: params.payday,
      gross_wages: params.grossWages,
      total_withdrawn: params.totalWithdrawn,
      receipt_id: params.receiptId,
      kind,
    };
    const { error } = params.id
      ? await supabase.from('payroll_runs').update(row).eq('id', params.id).eq('company', COMPANY)
      : await supabase
          .from('payroll_runs')
          .upsert(row, { onConflict: 'company,period_end,receipt_id' });
    if (error) {
      return {
        ok: false,
        message:
          error.code === UNIQUE_VIOLATION
            ? 'A run with this receipt ID is already recorded for this period — edit that one instead.'
            : error.message,
      };
    }
    if (kind !== 'regular') return { ok: true };

    // Forward only: recording an OLD run must never rewind the marker.
    const { data: settings } = await supabase
      .from('company_settings')
      .select('payroll_through')
      .eq('company', COMPANY)
      .maybeSingle();
    const current = (settings?.payroll_through as string | null) ?? '';
    if (params.periodEnd > current) {
      // `updated_at` is deliberately NOT touched (fixed 2026-09-12): the
      // Financials screen reads it as the moment the bank balance was
      // anchored, and every ledger row created after it auto-adjusts the
      // displayed balance. Stamping it here silently re-anchored the balance
      // without a new figure, dropping every bank transaction booked between
      // the last real anchor and this run from the adjustment. Only
      // saveBankBalance (lib/cashPosition.ts) may move it.
      const { error: settingsError } = await supabase
        .from('company_settings')
        .update({ payroll_through: params.periodEnd })
        .eq('company', COMPANY);
      if (settingsError) {
        return {
          ok: false,
          message: `Run saved, but payroll_through could not be advanced: ${settingsError.message}`,
        };
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not record the run.' };
  }
}
