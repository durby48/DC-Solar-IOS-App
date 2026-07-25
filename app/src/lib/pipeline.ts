/**
 * Pipeline tab data helpers — the full project breakdown. Everything here is
 * bulk-fetched (one query per table for the whole company) and grouped
 * client-side so the list renders without a per-job request fan-out. All
 * fetches degrade gracefully: money returns null (hide the row), hours and
 * next-dates return empty maps.
 */

import { fetchJobs } from '@/lib/data';
import { todayISO } from '@/lib/dates';
import { MOCK_SCHEDULE_DATES, type Job } from '@/lib/mockData';
import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

/** A job's next upcoming scheduled work day. */
export interface NextDate {
  work_date: string; // YYYY-MM-DD
  start_time: string | null; // HH:MM:SS, null = time TBD
}

/** Per-job money summary from finance_entries (admin-only table). */
export interface JobMoney {
  /** Most recent estimate amount, or null when there is none. */
  estimate: number | null;
  invoiced: number;
  paid: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Sort jobs for the pipeline: job_number descending (newest project — e.g.
 * DC-26018 — first, scroll down to DC-26001), then jobs without a number
 * last, newest created_at first (created_at is present on server rows; mock
 * jobs without one keep their bundled order).
 */
export function sortPipelineJobs(jobs: Job[]): Job[] {
  const createdAt = (j: Job) =>
    (j as unknown as { created_at?: string | null }).created_at ?? '';
  return [...jobs].sort((a, b) => {
    if (a.job_number && b.job_number) return b.job_number.localeCompare(a.job_number);
    if (a.job_number) return -1;
    if (b.job_number) return 1;
    return createdAt(b).localeCompare(createdAt(a));
  });
}

/** All company jobs in pipeline order. Falls back to mock data (isMock). */
export async function fetchPipelineJobs(): Promise<{ jobs: Job[]; isMock: boolean }> {
  const { jobs, isMock } = await fetchJobs();
  return { jobs: sortPipelineJobs(jobs), isMock };
}

/**
 * Next upcoming scheduled day per job, from one bulk job_schedule_dates
 * query (mock schedule rows when in demo mode). Empty map on error.
 */
export async function fetchNextDates(isMock: boolean): Promise<Map<string, NextDate>> {
  const today = todayISO();
  const map = new Map<string, NextDate>();
  const sortKey = (d: { work_date: string; start_time: string | null }) =>
    `${d.work_date}~${d.start_time ?? '99'}`;

  if (isMock) {
    const upcoming = MOCK_SCHEDULE_DATES.filter((d) => d.work_date >= today).sort(
      (a, b) => sortKey(a).localeCompare(sortKey(b)),
    );
    for (const d of upcoming) {
      if (!map.has(d.job_id)) {
        map.set(d.job_id, { work_date: d.work_date, start_time: d.start_time });
      }
    }
    return map;
  }

  try {
    const { data, error } = await supabase
      .from('job_schedule_dates')
      .select('job_id, work_date, start_time')
      .eq('company', COMPANY)
      .gte('work_date', today)
      .order('work_date', { ascending: true })
      .order('start_time', { ascending: true });
    if (error || !data) return map;
    for (const row of data as {
      job_id: string;
      work_date: string;
      start_time: string | null;
    }[]) {
      if (!map.has(row.job_id)) {
        map.set(row.job_id, { work_date: row.work_date, start_time: row.start_time });
      }
    }
    return map;
  } catch {
    return map;
  }
}

/** One finance_entries row (includes null-job_id company overhead rows). */
export interface FinanceRow {
  job_id: string | null;
  type: string;
  amount: unknown;
  occurred_on: string | null;
}

/**
 * ALL of the company's finance_entries rows in ONE bulk fetch (admin-only
 * per RLS) — including rows with null job_id (company overhead). Feeds both
 * the per-card money rows and the company totals header. Returns null when
 * the query fails (non-admin / offline) so callers can hide money UI.
 */
export async function fetchFinanceEntries(): Promise<FinanceRow[] | null> {
  try {
    const { data, error } = await supabase
      .from('finance_entries')
      .select('job_id, type, amount, occurred_on')
      .eq('company', COMPANY);
    if (error || !data) return null;
    return data as FinanceRow[];
  } catch {
    return null;
  }
}

/**
 * Money summary per job from prefetched finance rows. Est = most recent
 * estimate (by occurred_on), Inv/Paid = sums. Null-job_id rows are skipped —
 * they belong to the company, not any card.
 */
export function moneyByJobFromEntries(rows: FinanceRow[]): Map<string, JobMoney> {
  const map = new Map<string, JobMoney>();
  const estimateDates = new Map<string, string>();
  for (const row of rows) {
    if (!row.job_id) continue;
    const entry = map.get(row.job_id) ?? { estimate: null, invoiced: 0, paid: 0 };
    const amount = num(row.amount);
    switch (row.type) {
      case 'estimate': {
        const when = row.occurred_on ?? '';
        const prev = estimateDates.get(row.job_id);
        if (entry.estimate === null || prev === undefined || when >= prev) {
          entry.estimate = amount;
          estimateDates.set(row.job_id, when);
        }
        break;
      }
      case 'invoice':
        entry.invoiced += amount;
        break;
      case 'payment':
        entry.paid += amount;
        break;
    }
    map.set(row.job_id, entry);
  }
  return map;
}

/** Company-wide totals for the Pipeline header (admin only). */
export interface CompanyTotals {
  /** Sum of each job's current (most recent) estimate + null-job estimates. */
  estimates: number;
  /** Sum of all invoice entries. */
  invoiced: number;
  /** Sum of all payment entries. */
  paid: number;
  /** (paid − expenses − labor) / paid × 100, or null when paid is 0. */
  avgPnlPct: number | null;
}

/**
 * Company-wide totals across ALL finance entries (including null-job_id
 * overhead rows) plus labor from employee_hours (hours × rate) and completed
 * time_entries (duration × the employee's pay_rate, matched by email
 * case-insensitively; entries with unknown rates are skipped). At most 4
 * queries; pass prefetched finance rows to reuse the per-card fetch. Returns
 * null on any fetch failure (non-admin / offline) so the header hides.
 */
export async function fetchCompanyTotals(
  prefetched?: FinanceRow[] | null,
): Promise<CompanyTotals | null> {
  try {
    const rows = prefetched ?? (await fetchFinanceEntries());
    if (!rows) return null;

    // Estimates: current (latest by occurred_on) per job; null-job estimate
    // entries each count individually.
    const latestByJob = new Map<string, { amount: number; when: string }>();
    let nullJobEstimates = 0;
    let invoiced = 0;
    let paid = 0;
    let expenses = 0;
    for (const row of rows) {
      const amount = num(row.amount);
      switch (row.type) {
        case 'estimate':
          if (row.job_id) {
            const when = row.occurred_on ?? '';
            const prev = latestByJob.get(row.job_id);
            if (!prev || when >= prev.when) latestByJob.set(row.job_id, { amount, when });
          } else {
            nullJobEstimates += amount;
          }
          break;
        case 'invoice':
          invoiced += amount;
          break;
        case 'payment':
          paid += amount;
          break;
        case 'expense':
          expenses += amount;
          break;
      }
    }
    let estimates = nullJobEstimates;
    for (const { amount } of latestByJob.values()) estimates += amount;

    const [hoursRes, timeRes, employeesRes] = await Promise.all([
      supabase.from('employee_hours').select('hours, rate').eq('company', COMPANY),
      supabase
        .from('time_entries')
        .select('employee, clock_in, clock_out')
        .eq('company', COMPANY),
      supabase.from('employees').select('email, pay_rate'),
    ]);
    if (hoursRes.error || timeRes.error || employeesRes.error) return null;

    let labor = 0;
    for (const row of (hoursRes.data ?? []) as { hours: unknown; rate: unknown }[]) {
      labor += num(row.hours) * num(row.rate);
    }

    const rateByEmail = new Map<string, number>();
    for (const row of (employeesRes.data ?? []) as { email: string | null; pay_rate: unknown }[]) {
      if (row.email && row.pay_rate != null) {
        rateByEmail.set(row.email.toLowerCase(), num(row.pay_rate));
      }
    }
    for (const row of (timeRes.data ?? []) as {
      employee: string | null;
      clock_in: string | null;
      clock_out: string | null;
    }[]) {
      if (!row.clock_in || !row.clock_out) continue; // only completed entries
      const ms = new Date(row.clock_out).getTime() - new Date(row.clock_in).getTime();
      if (!Number.isFinite(ms) || ms <= 0) continue;
      const rate = row.employee ? rateByEmail.get(row.employee.toLowerCase()) : undefined;
      if (rate != null) labor += (ms / 3_600_000) * rate; // skip unknown rates
    }

    const avgPnlPct = paid > 0 ? ((paid - expenses - labor) / paid) * 100 : null;
    return { estimates, invoiced, paid, avgPnlPct };
  } catch {
    return null;
  }
}

/**
 * The signed-in (non-admin) user's own hours per job: their employee_hours
 * rows (matched by display_name) plus their completed time_entries (matched
 * by email), summed by job_id. Each source degrades to zero on error.
 */
export async function fetchMyHoursByJob(params: {
  email: string;
  displayName: string | null;
}): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  const add = (jobId: string | null, hours: number) => {
    if (!jobId || !(hours > 0)) return;
    totals.set(jobId, (totals.get(jobId) ?? 0) + hours);
  };

  if (params.displayName) {
    try {
      const { data, error } = await supabase
        .from('employee_hours')
        .select('job_id, hours')
        .eq('company', COMPANY)
        .eq('employee', params.displayName);
      if (!error && data) {
        for (const row of data as { job_id: string | null; hours: unknown }[]) {
          add(row.job_id, num(row.hours));
        }
      }
    } catch {
      // ignore — hours row simply omits this source
    }
  }

  try {
    const { data, error } = await supabase
      .from('time_entries')
      .select('job_id, clock_in, clock_out')
      .eq('company', COMPANY)
      .eq('employee', params.email);
    if (!error && data) {
      for (const row of data as {
        job_id: string | null;
        clock_in: string | null;
        clock_out: string | null;
      }[]) {
        if (!row.clock_in || !row.clock_out) continue; // only completed entries
        const ms = new Date(row.clock_out).getTime() - new Date(row.clock_in).getTime();
        if (!Number.isFinite(ms) || ms <= 0) continue;
        add(row.job_id, ms / 3_600_000);
      }
    }
  } catch {
    // ignore — hours row simply omits this source
  }

  return totals;
}
