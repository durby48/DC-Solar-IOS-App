/**
 * Admin editing of ANY employee's hours from the Hours tab (2026-11-07).
 *
 * Two sources, two shapes:
 *   - logged hours (employee_hours): a total on a date → edit hours, date,
 *     job, note; delete. RLS: eh_admin_update / eh_admin_delete (2026-07-28).
 *   - clock shifts (time_entries): a clock-in and a clock-out → edit both
 *     times, job, note; close an open punch; delete. RLS: te_update lets an
 *     admin edit anything (2026-10-13); te_delete is admin-only
 *     (2026-11-07_time_entries_admin_delete.sql).
 *
 * Every write is checked with `.select('id')`: RLS refuses silently (0 rows,
 * no error), so an empty result is reported as a refusal instead of "Saved".
 * Times are entered and shown in Kansas City time whatever the device's zone.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';
export const HOURS_TIME_ZONE = 'America/Chicago';

export type HoursEditResult = { ok: true } | { ok: false; message: string };

/** Minutes the zone is ahead of UTC at `utcMs` (Chicago: −360 or −300). */
function zoneOffsetMinutes(utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: HOURS_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - utcMs) / 60_000);
}

/**
 * "2026-11-07" + "7:30" (or "07:30", "7:30 pm", "19:30") in Kansas City time
 * → ISO timestamp. Null when either part does not parse.
 */
export function zonedToIso(date: string, time: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const t = /^(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?$/i.exec(time.trim());
  if (!d || !t) return null;
  let hour = Number(t[1]);
  const minute = Number(t[2]);
  const meridiem = t[3]?.toLowerCase().startsWith('p') ? 'pm' : t[3] ? 'am' : null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59) return null;
  const naive = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), hour, minute);
  // Two passes settle the offset across a DST change.
  let utc = naive - zoneOffsetMinutes(naive) * 60_000;
  utc = naive - zoneOffsetMinutes(utc) * 60_000;
  return new Date(utc).toISOString();
}

/** ISO → "YYYY-MM-DD" in Kansas City time. */
export function zonedDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: HOURS_TIME_ZONE });
}

/** ISO → "7:30 AM" in Kansas City time. */
export function zonedTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    timeZone: HOURS_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  });
}

function failure(raw: string | undefined, fallback: string): HoursEditResult {
  if (raw && /row-level security|policy|permission/i.test(raw)) {
    return { ok: false, message: 'Only an admin can change these hours.' };
  }
  return { ok: false, message: raw || fallback };
}

async function run(
  query: PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
  fallback: string,
  refused: string,
): Promise<HoursEditResult> {
  try {
    const { data, error } = await query;
    if (error) return failure(error.message, fallback);
    if (!data || data.length === 0) return { ok: false, message: refused };
    return { ok: true };
  } catch (e) {
    return failure(e instanceof Error ? e.message : undefined, fallback);
  }
}

export async function updateLoggedHours(
  id: string,
  fields: { hours: number; occurredOn: string; jobId: string | null; note: string | null },
): Promise<HoursEditResult> {
  return run(
    supabase
      .from('employee_hours')
      .update({
        hours: fields.hours,
        occurred_on: fields.occurredOn,
        job_id: fields.jobId,
        description: fields.note,
      })
      .eq('company', COMPANY)
      .eq('id', id)
      .select('id'),
    'Could not save the hours.',
    'That entry was not saved — it may have been removed, or you are not an admin.',
  );
}

export async function deleteLoggedHours(id: string): Promise<HoursEditResult> {
  return run(
    supabase.from('employee_hours').delete().eq('company', COMPANY).eq('id', id).select('id'),
    'Could not delete the entry.',
    'That entry was not deleted — it may already be gone, or you are not an admin.',
  );
}

export async function updateClockShift(
  id: string,
  fields: { clockIn: string; clockOut: string | null; jobId: string | null; note: string | null; editedBy: string | null },
): Promise<HoursEditResult> {
  if (fields.clockOut && new Date(fields.clockOut).getTime() < new Date(fields.clockIn).getTime()) {
    return { ok: false, message: 'Clock-out is before clock-in.' };
  }
  return run(
    supabase
      .from('time_entries')
      .update({
        clock_in: fields.clockIn,
        clock_out: fields.clockOut,
        job_id: fields.jobId,
        note: fields.note,
        edited_by: fields.editedBy,
      })
      .eq('company', COMPANY)
      .eq('id', id)
      .select('id'),
    'Could not save the shift.',
    'That shift was not saved — it may have been removed, or you are not an admin.',
  );
}

export async function deleteClockShift(id: string): Promise<HoursEditResult> {
  return run(
    supabase.from('time_entries').delete().eq('company', COMPANY).eq('id', id).select('id'),
    'Could not delete the shift.',
    'That shift was not deleted — it may already be gone, or deleting shifts needs the 2026-11-07 database update.',
  );
}
