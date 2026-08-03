/**
 * Hours tab data — admin-only payroll overview (Devon + Isaiah).
 *
 * Combines BOTH hour sources the app already uses for labor math:
 *   - employee_hours rows (manual logs; hours × their stamped rate)
 *   - completed time_entries (clock in/out; duration × roster pay_rate)
 * and folds them into per-employee totals: YTD, per-job, and the current
 * payroll period (for running payroll in Chase/Gusto).
 *
 * Payroll periods: everything before 2026-07-18 was paid out and
 * reconciled before this tab existed. The first period is the catch-up
 * 2026-07-18 → 2026-08-03; after that, clean 14-day periods start
 * 2026-08-04 (Aug 4–17, Aug 18–31, …).
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

/** First (catch-up) payroll period. */
const FIRST_PERIOD_START = '2026-07-18';
const FIRST_PERIOD_END = '2026-08-03';
/** Biweekly periods begin the day after the catch-up period ends. */
const BIWEEKLY_ANCHOR = '2026-08-04';
const DAY_MS = 86_400_000;

export interface PayrollPeriod {
  /** YYYY-MM-DD, inclusive. */
  start: string;
  /** YYYY-MM-DD, inclusive. */
  end: string;
}

/** Noon-UTC epoch for a YYYY-MM-DD (avoids timezone off-by-one). */
function dayMs(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getTime();
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The payroll period containing `todayIso` (default: today). */
export function currentPayrollPeriod(todayIso?: string): PayrollPeriod {
  const today = todayIso ?? new Date().toISOString().slice(0, 10);
  if (today <= FIRST_PERIOD_END) {
    return { start: FIRST_PERIOD_START, end: FIRST_PERIOD_END };
  }
  const sinceAnchor = Math.floor((dayMs(today) - dayMs(BIWEEKLY_ANCHOR)) / DAY_MS);
  const periodIndex = Math.floor(sinceAnchor / 14);
  const startMs = dayMs(BIWEEKLY_ANCHOR) + periodIndex * 14 * DAY_MS;
  return { start: isoFromMs(startMs), end: isoFromMs(startMs + 13 * DAY_MS) };
}

export interface EmployeeJobHours {
  jobId: string | null;
  /** DC-26### when known, else job name, else "No job". */
  label: string;
  hours: number;
}

export interface EmployeeHoursSummary {
  /** Roster display name (or email when the roster has no name). */
  name: string;
  ytdHours: number;
  /** Hours worked inside the current payroll period. */
  periodHours: number;
  /** Dollars owed for the period: hours × rate per entry. */
  periodPay: number;
  /** True when some period hours had no known rate (pay is understated). */
  periodPayIncomplete: boolean;
  /** YTD hours per job, biggest first. */
  jobs: EmployeeJobHours[];
}

export interface HoursOverview {
  period: PayrollPeriod;
  employees: EmployeeHoursSummary[];
  totalPeriodHours: number;
  totalPeriodPay: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fetch and aggregate everything the Hours tab shows. Null on any fetch
 * failure (non-admin RLS / offline) so the screen degrades to a placeholder.
 */
export async function fetchHoursOverview(): Promise<HoursOverview | null> {
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
      supabase.from('employees').select('email, display_name, pay_rate'),
      supabase.from('jobs').select('id, job_number, name').eq('company', COMPANY),
    ]);
    if (hoursRes.error || timeRes.error || employeesRes.error || jobsRes.error) return null;

    const period = currentPayrollPeriod();
    const year = period.end.slice(0, 4);

    const roster = (employeesRes.data ?? []) as {
      email: string | null;
      display_name: string | null;
      pay_rate: unknown;
    }[];
    const nameByEmail = new Map<string, string>();
    const rateByEmail = new Map<string, number>();
    for (const row of roster) {
      const email = row.email?.toLowerCase();
      if (!email) continue;
      if (row.display_name) nameByEmail.set(email, row.display_name);
      if (row.pay_rate != null) rateByEmail.set(email, num(row.pay_rate));
    }

    const jobLabel = new Map<string, string>();
    for (const job of (jobsRes.data ?? []) as {
      id: string;
      job_number: string | null;
      name: string | null;
    }[]) {
      jobLabel.set(job.id, job.job_number ?? job.name ?? 'Job');
    }

    interface Bucket {
      ytdHours: number;
      periodHours: number;
      periodPay: number;
      periodPayIncomplete: boolean;
      jobs: Map<string, number>; // job key ('' = none) → YTD hours
    }
    const people = new Map<string, Bucket>();
    const bucket = (name: string): Bucket => {
      const existing = people.get(name);
      if (existing) return existing;
      const fresh: Bucket = {
        ytdHours: 0,
        periodHours: 0,
        periodPay: 0,
        periodPayIncomplete: false,
        jobs: new Map(),
      };
      people.set(name, fresh);
      return fresh;
    };

    const add = (params: {
      name: string;
      date: string | null; // YYYY-MM-DD
      hours: number;
      rate: number | null;
      jobId: string | null;
    }) => {
      if (!(params.hours > 0) || !params.date) return;
      const b = bucket(params.name);
      if (params.date.startsWith(year)) {
        b.ytdHours += params.hours;
        const key = params.jobId ?? '';
        b.jobs.set(key, (b.jobs.get(key) ?? 0) + params.hours);
      }
      if (params.date >= period.start && params.date <= period.end) {
        b.periodHours += params.hours;
        if (params.rate != null && params.rate > 0) b.periodPay += params.hours * params.rate;
        else b.periodPayIncomplete = true;
      }
    };

    for (const row of (hoursRes.data ?? []) as {
      employee: string | null;
      email: string | null;
      hours: unknown;
      rate: unknown;
      occurred_on: string | null;
      job_id: string | null;
    }[]) {
      const email = row.email?.toLowerCase();
      const name =
        row.employee ?? (email ? (nameByEmail.get(email) ?? row.email) : null) ?? 'Unassigned';
      const rate = num(row.rate) > 0 ? num(row.rate) : (email ? rateByEmail.get(email) : undefined);
      add({
        name,
        date: row.occurred_on,
        hours: num(row.hours),
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
      const name = (email ? nameByEmail.get(email) : null) ?? row.employee ?? 'Unassigned';
      add({
        name,
        date: row.clock_in.slice(0, 10),
        hours: ms / 3_600_000,
        rate: email ? (rateByEmail.get(email) ?? null) : null,
        jobId: row.job_id,
      });
    }

    const employees: EmployeeHoursSummary[] = [...people.entries()]
      .map(([name, b]) => ({
        name,
        ytdHours: b.ytdHours,
        periodHours: b.periodHours,
        periodPay: b.periodPay,
        periodPayIncomplete: b.periodPayIncomplete,
        jobs: [...b.jobs.entries()]
          .map(([key, hours]) => ({
            jobId: key === '' ? null : key,
            label: key === '' ? 'No job' : (jobLabel.get(key) ?? 'Job'),
            hours,
          }))
          .sort((a, b2) => b2.hours - a.hours),
      }))
      .filter((e) => e.ytdHours > 0 || e.periodHours > 0)
      .sort((a, b2) => b2.periodHours - a.periodHours || b2.ytdHours - a.ytdHours);

    let totalPeriodHours = 0;
    let totalPeriodPay = 0;
    for (const e of employees) {
      totalPeriodHours += e.periodHours;
      totalPeriodPay += e.periodPay;
    }

    return { period, employees, totalPeriodHours, totalPeriodPay };
  } catch {
    return null;
  }
}
