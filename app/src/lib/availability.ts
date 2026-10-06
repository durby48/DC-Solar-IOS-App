import { supabase } from '@/lib/supabase';

/**
 * Service-visit availability per day (2026-10-06, S2), from
 * `service_availability()` — COUNTS only, so a sales rep sees how many visit
 * spots a day has without seeing whose job is taking the crew. The rule lives
 * in 2026-10-06_crew_availability.sql: field crew minus those assigned to
 * other jobs that day; if a full service crew (2) is free, 5 visit spots;
 * minus visits already booked. A sales rep cannot book a full day (the
 * database refuses it); an admin can.
 */

export interface DayAvailability {
  /** YYYY-MM-DD */
  day: string;
  fieldCrew: number;
  busyCrew: number;
  freeCrew: number;
  visitsBooked: number;
  visitSpots: number;
  spotsLeft: number;
  /** Non-service jobs that day with nobody assigned yet. */
  unstaffedJobs: number;
}

export async function fetchAvailability(
  fromISO: string,
  toISO: string,
  excludeJobId?: string | null,
): Promise<Map<string, DayAvailability>> {
  const map = new Map<string, DayAvailability>();
  try {
    const { data, error } = await supabase.rpc('service_availability', {
      p_from: fromISO,
      p_to: toISO,
      p_exclude_job: excludeJobId ?? null,
    });
    if (error || !data) return map;
    for (const r of data as {
      day: string;
      field_crew: number;
      busy_crew: number;
      free_crew: number;
      visits_booked: number;
      visit_spots: number;
      spots_left: number;
      unstaffed_jobs: number;
    }[]) {
      map.set(r.day, {
        day: r.day,
        fieldCrew: r.field_crew,
        busyCrew: r.busy_crew,
        freeCrew: r.free_crew,
        visitsBooked: r.visits_booked,
        visitSpots: r.visit_spots,
        spotsLeft: r.spots_left,
        unstaffedJobs: r.unstaffed_jobs,
      });
    }
    return map;
  } catch {
    return map;
  }
}

/** "3 of 5 visits left", or "Full". */
export function spotsLabel(a: DayAvailability | undefined): string {
  if (!a) return '';
  if (a.spotsLeft <= 0) return 'Full';
  return `${a.spotsLeft} of ${a.visitSpots} visits left`;
}

/** Local YYYY-MM-DD for a Date (not UTC — a Kansas City evening is still today). */
export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

/** The next `count` work days (Mon–Sat) starting tomorrow. */
export function nextWorkDays(count: number, from = new Date()): string[] {
  const out: string[] = [];
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (out.length < count) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0) out.push(isoDay(d));
  }
  return out;
}
