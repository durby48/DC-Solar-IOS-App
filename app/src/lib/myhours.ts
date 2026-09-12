/**
 * Own-hours entries — crew members log total hours against a job and a
 * date without clock in/out times (migration 14). Rows live in
 * employee_hours keyed by the signed-in email; a DB trigger fills the
 * display name and roster pay rate, so these feed the existing labor math
 * (job profit, "Your hours") automatically. RLS: everyone manages only
 * their own rows; owners/operators (`is_company_admin`) may insert, edit and
 * delete ANY employee's rows — that is what the multi-employee logger and
 * the Hours tab rely on (migration 2026-07-28_admin_hours).
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

export interface JobOption {
  id: string;
  job_number: string | null;
  name: string;
  customerName: string | null;
  address: string | null;
  stage: string | null;
}

/**
 * Jobs for the log-hours picker, newest job number first with finished
 * (Complete) jobs sunk to the bottom — hours are almost always logged on a
 * job still in flight, but a late entry on a finished job must stay possible.
 * Empty on any error.
 */
export async function fetchJobOptions(): Promise<JobOption[]> {
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, job_number, name, address, stage, customers(name)')
      .eq('company', COMPANY);
    if (error || !data) return [];
    const options = (data as Record<string, unknown>[]).map((row) => {
      const customer = row.customers as { name?: string | null } | { name?: string | null }[] | null;
      const customerName = Array.isArray(customer)
        ? (customer[0]?.name ?? null)
        : (customer?.name ?? null);
      return {
        id: row.id as string,
        job_number: (row.job_number as string | null) ?? null,
        name: (row.name as string | null) ?? 'Job',
        customerName,
        address: (row.address as string | null) ?? null,
        stage: (row.stage as string | null) ?? null,
      };
    });
    const done = (o: JobOption) => (o.stage === 'Complete' ? 1 : 0);
    return options.sort(
      (a, b) =>
        done(a) - done(b) ||
        (b.job_number ?? '').localeCompare(a.job_number ?? '') ||
        a.name.localeCompare(b.name),
    );
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

/** One person's outcome from a multi-employee log. */
export interface LogHoursRowResult {
  email: string;
  ok: boolean;
  /** Error text when `ok` is false. */
  message?: string;
}

/**
 * Outcome of `addMyHoursForMany`. `ok` means EVERY row landed. `inserted` and
 * `rows` let the form show a per-person summary when some rows failed —
 * "Ben, Isaiah saved; Simon: not on the roster" — instead of one vague error
 * that leaves the admin guessing which entries exist.
 */
export type AddManyHoursResult = MutateHoursResult & {
  inserted: number;
  rows: LogHoursRowResult[];
};

/**
 * Log the SAME hours against a job for several people at once.
 *
 * The crew works the job together, so the common case is "everybody did 8
 * hours today" — which used to mean opening the form, picking a person and
 * saving, once per head. This inserts one row per email in a SINGLE request:
 * PostgREST takes an array, so six installers is one round trip and either
 * all six rows land or none do.
 *
 * If that batch is refused, it falls back to one insert per person and
 * reports each outcome, so a single bad row (a stale roster email, say)
 * cannot silently take the other five with it — the admin sees exactly who
 * was saved and who was not.
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
}): Promise<AddManyHoursResult> {
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
    return { ok: false, message: 'Pick at least one person.', inserted: 0, rows: [] };
  }
  const rowFor = (email: string) => ({
    company: COMPANY,
    job_id: params.jobId,
    email,
    hours: params.hours,
    occurred_on: params.occurredOn,
    description: params.note,
  });
  try {
    const { error } = await supabase.from('employee_hours').insert(emails.map(rowFor));
    if (!error) {
      return {
        ok: true,
        inserted: emails.length,
        rows: emails.map((email) => ({ email, ok: true })),
      };
    }
    // A single-person save has nothing to split — report the error as-is.
    if (emails.length === 1) {
      const message = friendly(error.message, 'Could not save the hours.');
      return { ok: false, message, inserted: 0, rows: [{ email: emails[0], ok: false, message }] };
    }
    // Batch refused: retry one row at a time so the good rows still land and
    // the caller learns exactly which person failed.
    const rows: LogHoursRowResult[] = [];
    for (const email of emails) {
      const single = await supabase.from('employee_hours').insert(rowFor(email));
      rows.push(
        single.error
          ? { email, ok: false, message: friendly(single.error.message, 'Could not save.') }
          : { email, ok: true },
      );
    }
    const inserted = rows.filter((r) => r.ok).length;
    const failed = rows.filter((r) => !r.ok);
    const message =
      inserted === 0
        ? friendly(error.message, 'Could not save the hours.')
        : `Saved for ${inserted} of ${emails.length} — ${failed.length} could not be saved.`;
    return { ok: false, message, inserted, rows };
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not save the hours.';
    return {
      ok: false,
      message,
      inserted: 0,
      rows: emails.map((email) => ({ email, ok: false, message })),
    };
  }
}
