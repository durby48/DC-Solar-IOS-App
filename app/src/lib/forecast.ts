/**
 * Labour forecasting: "how long will this job take?" (2026-08-05).
 *
 * The model is learned at runtime from finished work rather than hardcoded —
 * for each job_type, total hours ÷ total modules across COMPLETE jobs that
 * have both numbers. As Devon fills in module_count and job_type across the
 * back catalogue, the forecast improves on its own with no code change.
 *
 * ⚠️ Read this before trusting the output. As of 2026-08-05 there are only
 * THREE completed R&R jobs with hours logged:
 *     DC-26003  22 modules / 45 h = 2.05 h per module
 *     DC-26008  23 modules / 32 h = 1.39
 *     DC-26010  38 modules / 72 h = 1.89
 * That is a ±25% spread on n=3, and DC-26011's removal hours were never
 * logged at all. So this module deliberately returns a RANGE and the sample
 * size alongside the point estimate, and the UI always shows both. A single
 * confident number here would be false precision.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';
/** Below this many samples we stop showing a range (see Forecast.low). */
const MIN_SAMPLES_FOR_RANGE = 2;

export interface TypeModel {
  perModule: number;
  /** Lowest and highest per-module rate observed, for the range. */
  lowPerModule: number;
  highPerModule: number;
  samples: number;
}

export type ForecastModel = Map<string, TypeModel>;

export interface Forecast {
  /** Point estimate in hours. */
  hours: number;
  /**
   * Observed spread, or null when only ONE finished job informs this type —
   * a single sample would render as "51–51 h", which looks like precision we
   * do not have. The sample count carries the caveat instead.
   */
  low: number | null;
  high: number | null;
  samples: number;
  /** The job_type the coefficient actually came from (may be borrowed). */
  basis: string;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build the model from complete jobs. Null when nothing can be learned
 * (no finished jobs with both hours and modules) — callers show "—".
 */
export async function fetchForecastModel(): Promise<ForecastModel | null> {
  try {
    const [jobsRes, hoursRes, timeRes] = await Promise.all([
      supabase
        .from('jobs')
        .select('id, stage, status, job_type, module_count, is_internal')
        .eq('company', COMPANY),
      supabase.from('employee_hours').select('job_id, hours').eq('company', COMPANY),
      supabase
        .from('time_entries')
        .select('job_id, clock_in, clock_out')
        .eq('company', COMPANY)
        .not('clock_out', 'is', null),
    ]);
    if (jobsRes.error || hoursRes.error || timeRes.error) return null;

    const hoursByJob = new Map<string, number>();
    for (const row of (hoursRes.data ?? []) as { job_id: string | null; hours: unknown }[]) {
      if (!row.job_id) continue;
      hoursByJob.set(row.job_id, (hoursByJob.get(row.job_id) ?? 0) + num(row.hours));
    }
    for (const row of (timeRes.data ?? []) as {
      job_id: string | null;
      clock_in: string | null;
      clock_out: string | null;
    }[]) {
      if (!row.job_id || !row.clock_in || !row.clock_out) continue;
      const ms = new Date(row.clock_out).getTime() - new Date(row.clock_in).getTime();
      if (Number.isFinite(ms) && ms > 0) {
        hoursByJob.set(row.job_id, (hoursByJob.get(row.job_id) ?? 0) + ms / 3_600_000);
      }
    }

    interface Acc {
      hours: number;
      modules: number;
      rates: number[];
    }
    const byType = new Map<string, Acc>();
    for (const row of (jobsRes.data ?? []) as Record<string, unknown>[]) {
      if (row.is_internal === true) continue;
      const complete =
        row.stage === 'Complete' || (row.stage == null && row.status === 'completed');
      if (!complete) continue;
      const modules = num(row.module_count);
      const hours = hoursByJob.get(row.id as string) ?? 0;
      if (modules <= 0 || hours <= 0) continue;
      const type = (row.job_type as string | null) ?? 'Other';
      const acc = byType.get(type) ?? { hours: 0, modules: 0, rates: [] };
      acc.hours += hours;
      acc.modules += modules;
      acc.rates.push(hours / modules);
      byType.set(type, acc);
    }

    if (byType.size === 0) return null;

    const model: ForecastModel = new Map();
    for (const [type, acc] of byType) {
      model.set(type, {
        perModule: acc.hours / acc.modules,
        lowPerModule: Math.min(...acc.rates),
        highPerModule: Math.max(...acc.rates),
        samples: acc.rates.length,
      });
    }
    return model;
  } catch {
    return null;
  }
}

/**
 * Forecast one job. Returns null when there's no usable coefficient or no
 * module count — the card then shows "—" rather than a made-up number.
 */
export function forecastJob(
  model: ForecastModel | null,
  jobType: string | null | undefined,
  modules: number | null | undefined,
): Forecast | null {
  if (!model || !modules || modules <= 0) return null;
  const type = jobType ?? 'Other';
  let basis = type;
  let entry = model.get(type);
  // Borrow R&R ONLY when this type has no finished jobs at all. Borrowing on a
  // merely-thin sample was worse: a Reinstall-only job would be costed at the
  // R&R rate (1.80 h/module vs its own 1.24), overstating it by ~45%. A thin
  // sample of the RIGHT kind of work beats a fat sample of the wrong kind —
  // and the UI always shows how many jobs are behind the number.
  if (!entry) {
    const fallback = model.get('R&R');
    if (fallback) {
      entry = fallback;
      basis = 'R&R';
    }
  }
  if (!entry) return null;
  const hasRange = entry.samples >= MIN_SAMPLES_FOR_RANGE;
  return {
    hours: entry.perModule * modules,
    low: hasRange ? entry.lowPerModule * modules : null,
    high: hasRange ? entry.highPerModule * modules : null,
    samples: entry.samples,
    basis,
  };
}
