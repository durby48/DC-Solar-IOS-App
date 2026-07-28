/**
 * Own-hours entries — crew members log total hours against a job and a
 * date without clock in/out times (migration 14). Rows live in
 * employee_hours keyed by the signed-in email; a DB trigger fills the
 * display name and roster pay rate, so these feed the existing labor math
 * (job profit, "Your hours") automatically. RLS: everyone manages only
 * their own rows.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

export interface MyHourEntry {
  id: string;
  occurred_on: string | null; // YYYY-MM-DD
  hours: number;
  description: string | null;
}

export type MyHoursResult =
  | { status: 'ok'; entries: MyHourEntry[] }
  | { status: 'unavailable' };

/** The signed-in user's own manual hour entries for one job, newest first. */
export async function fetchMyHourEntries(params: {
  jobId: string;
  email: string;
}): Promise<MyHoursResult> {
  try {
    const { data, error } = await supabase
      .from('employee_hours')
      .select('id, occurred_on, hours, description')
      .eq('company', COMPANY)
      .eq('job_id', params.jobId)
      .eq('email', params.email)
      .order('occurred_on', { ascending: false });
    if (error) return { status: 'unavailable' };
    const entries = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      ...row,
      hours: Number(row.hours) || 0,
    })) as MyHourEntry[];
    return { status: 'ok', entries };
  } catch {
    return { status: 'unavailable' };
  }
}

export type MutateHoursResult = { ok: true } | { ok: false; message: string };

function friendly(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (/row-level security|policy|column/i.test(raw)) {
    return 'Logging hours needs the latest database migration.';
  }
  return raw;
}

/** Add an own-hours entry (rate/display name filled by the DB trigger). */
export async function addMyHours(params: {
  jobId: string;
  email: string;
  hours: number;
  occurredOn: string; // YYYY-MM-DD
  note: string | null;
}): Promise<MutateHoursResult> {
  try {
    const { error } = await supabase.from('employee_hours').insert({
      company: COMPANY,
      job_id: params.jobId,
      email: params.email,
      hours: params.hours,
      occurred_on: params.occurredOn,
      description: params.note,
    });
    if (error) return { ok: false, message: friendly(error.message, 'Could not save the hours.') };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the hours.' };
  }
}

/** Update one of the user's own entries (RLS blocks anyone else's). */
export async function updateMyHours(
  id: string,
  fields: { hours?: number; occurred_on?: string; description?: string | null },
): Promise<MutateHoursResult> {
  try {
    const { data, error } = await supabase
      .from('employee_hours')
      .update(fields)
      .eq('company', COMPANY)
      .eq('id', id)
      .select('id');
    if (error) return { ok: false, message: friendly(error.message, 'Could not update the entry.') };
    if (!data || data.length === 0) return { ok: false, message: 'You can only edit your own hours.' };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not update the entry.' };
  }
}

/** Delete one of the user's own entries. */
export async function deleteMyHours(id: string): Promise<MutateHoursResult> {
  try {
    const { data, error } = await supabase
      .from('employee_hours')
      .delete()
      .eq('company', COMPANY)
      .eq('id', id)
      .select('id');
    if (error) return { ok: false, message: friendly(error.message, 'Could not delete the entry.') };
    if (!data || data.length === 0) return { ok: false, message: 'You can only delete your own hours.' };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not delete the entry.' };
  }
}
