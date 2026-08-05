/**
 * Company milestone metrics for the pipeline hero (2026-08-05).
 *
 * These are the "how much have we done" numbers, not finance. They read from
 * the jobs.module_count / job_type / critter_guard_panels columns added in
 * migration 20 — deliberately NOT by re-parsing job names at render time,
 * because the counts only ever existed in free text and a typo fix would
 * otherwise silently move the company's statistics.
 *
 * Jobs flagged `is_internal` (Company Home Base) are excluded — they are our
 * own building, not customer work, and would inflate "projects completed".
 *
 * Never throws: returns null on any failure so the hero can hide the band and
 * still show the animation.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

export interface CompanyMetrics {
  /** Modules taken down and put back up on finished R&R / reinstall work. */
  panelsReinstalled: number;
  /** Finished customer projects. */
  projectsCompleted: number;
  /** Every hour logged, manual entries plus completed clock-ins. */
  totalHours: number;
  /** Panels covered by critter guard on finished jobs. */
  critterGuardPanels: number;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function fetchCompanyMetrics(): Promise<CompanyMetrics | null> {
  try {
    const [jobsRes, hoursRes, timeRes] = await Promise.all([
      supabase
        .from('jobs')
        .select(
          'stage, status, job_type, module_count, critter_guard_panels, has_critter_guard, is_internal',
        )
        .eq('company', COMPANY),
      supabase.from('employee_hours').select('hours').eq('company', COMPANY),
      supabase
        .from('time_entries')
        .select('clock_in, clock_out')
        .eq('company', COMPANY)
        .not('clock_out', 'is', null),
    ]);
    if (jobsRes.error || hoursRes.error || timeRes.error) return null;

    let panelsReinstalled = 0;
    let projectsCompleted = 0;
    let critterGuardPanels = 0;

    for (const row of (jobsRes.data ?? []) as Record<string, unknown>[]) {
      if (row.is_internal === true) continue;
      // `stage` may be absent on very old rows; fall back to legacy status.
      const complete =
        row.stage === 'Complete' || (row.stage == null && row.status === 'completed');
      if (!complete) continue;
      projectsCompleted += 1;
      const type = row.job_type as string | null;
      if (type === 'R&R' || type === 'Reinstall') {
        panelsReinstalled += num(row.module_count);
      }
      // Critter guard rides along with most R&R jobs, so it's a flag rather
      // than a job type. Blank panel count means the whole array was covered,
      // so fall back to the module count — that way correcting the module
      // count later keeps this number right without re-editing it.
      if (row.has_critter_guard === true) {
        const covered = num(row.critter_guard_panels) || num(row.module_count);
        critterGuardPanels += covered;
      }
    }

    let totalHours = 0;
    for (const row of (hoursRes.data ?? []) as { hours: unknown }[]) {
      totalHours += num(row.hours);
    }
    for (const row of (timeRes.data ?? []) as {
      clock_in: string | null;
      clock_out: string | null;
    }[]) {
      if (!row.clock_in || !row.clock_out) continue;
      const ms = new Date(row.clock_out).getTime() - new Date(row.clock_in).getTime();
      if (Number.isFinite(ms) && ms > 0) totalHours += ms / 3_600_000;
    }

    return {
      panelsReinstalled,
      projectsCompleted,
      totalHours: Math.round(totalHours),
      critterGuardPanels,
    };
  } catch {
    return null;
  }
}
