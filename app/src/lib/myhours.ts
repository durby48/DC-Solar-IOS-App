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
  /** Roster display name (admin view; null on some legacy rows). */
  employee: string | null;
  /** Owning email; null on P&L-import / console rows (admin-editable only). */
  email: string | null;
}

export type MyHoursResult =
  | { status: 'ok'; entries: MyHourEntry[] }
  | { status: 'unavailable' };

/**
 * Manual hour entries for one job, newest first: the caller's own rows, or
 * EVERY employee's rows when allEmployees (admins — RLS enforces).
 */
export async function fetchMyHourEntries(params: {
  jobId: string;
  email: string;
  allEmployees?: boolean;
}): Promise<MyHoursResult> {
  try {
    let query = supabase
      .from('employee_hours')
      .select('id, occurred_on, hours, description, employee, email')
      .eq('company', COMPANY)
      .eq('job_id', params.jobId)
      .order('occurred_on', { ascending: false });
    if (!params.allEmployees) query = query.eq('email', params.email);
    const { data, error } = await query;
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

export interface EmployeeOption {
  email: string;
  name: string;
}

/** Roster options for the admin "log hours for…" picker. */
export async function fetchEmployeeOptions(): Promise<EmployeeOption[]> {
  try {
    const { data, error } = await supabase
      .from('employees')
      .select('email, display_name')
      .eq('is_test', false)
      .order('display_name', { ascending: true });
    if (error || !data) return [];
    return (data as { email: string | null; display_name: string | null }[])
      .filter((row) => row.email)
      .map((row) => ({ email: row.email as string, name: row.display_name ?? (row.email as string) }));
  } catch {
    return [];
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

/**
 * Log the SAME hours against a job for several people at once.
 *
 * The crew works the job together, so the common case is "everybody did 8
 * hours today" — which used to mean opening the form, picking a person and
 * saving, once per head. This inserts one row per email in a SINGLE request:
 * PostgREST takes an array, so six installers is one round trip and either
 * all six rows land or none do, instead of four saves and a dropped signal
 * leaving the last two missing.
 *
 * Emails are de-duplicated case-insensitively while keeping the roster's own
 * spelling — the rate-stamping trigger matches on the roster row, so passing
 * a differently-cased duplicate would have written two entries for one person.
 */
export async function addMyHoursForMany(params: {
  jobId: string;
  emails: string[];
  hours: number;
  occurredOn: string; // YYYY-MM-DD
  note: string | null;
}): Promise<MutateHoursResult & { inserted: number }> {
  const seen = new Set<string>();
  const emails: string[] = [];
  for (const raw of params.emails) {
    const email = raw.trim();
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    emails.push(email);
  }
  if (emails.length === 0) {
    return { ok: false, message: 'Pick at least one person.', inserted: 0 };
  }
  try {
    const { error } = await supabase.from('employee_hours').insert(
      emails.map((email) => ({
        company: COMPANY,
        job_id: params.jobId,
        email,
        hours: params.hours,
        occurred_on: params.occurredOn,
        description: params.note,
      })),
    );
    if (error) {
      return {
        ok: false,
        message: friendly(error.message, 'Could not save the hours.'),
        inserted: 0,
      };
    }
    return { ok: true, inserted: emails.length };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not save the hours.',
      inserted: 0,
    };
  }
}
