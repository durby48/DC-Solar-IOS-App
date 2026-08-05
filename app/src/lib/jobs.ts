/**
 * Job editing helpers (admin-only writes per RLS: owners/operators can
 * update + insert `jobs`; everyone in the company can read).
 *
 * The `project_manager` / `project_manager_phone` columns are added by a
 * migration that may not be applied yet, so every write that includes them
 * falls back to retrying without them and surfaces a friendly warning.
 * Job numbers stay in lockstep with the dcsolarkc.com ops console: both
 * derive the next `DC-#####` moniker from a fresh read of the jobs table.
 */

import { type Customer, type Job } from '@/lib/mockData';
import { type Stage } from '@/lib/stages';
import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

export const PM_MIGRATION_WARNING =
  'Project manager fields need the latest database migration — the rest of the job was saved.';

export const STAGE_MIGRATION_WARNING = 'Stages need the latest database migration';

export const COMPLETED_ON_MIGRATION_WARNING =
  'The completed date needs the latest database migration — the rest of the job was saved.';

export const METRICS_MIGRATION_WARNING =
  'Module count and job type need the latest database migration — the rest of the job was saved.';

/** Optional columns (may not exist in the DB yet). */
export interface JobProjectManager {
  project_manager?: string | null;
  project_manager_phone?: string | null;
  /** Pipeline stage (added in migration 6; may be absent pre-migration). */
  stage?: string | null;
  /** Date the project completed (migration 10; may be absent pre-migration). */
  completed_on?: string | null;
}

export type JobWithPM = Job & JobProjectManager;

/**
 * True when a Supabase/PostgREST error means "that column doesn't exist" and
 * the message names one of the given columns.
 */
function isMissingColumnError(
  error: { code?: string; message?: string } | null,
  ...columns: string[]
): boolean {
  if (!error) return false;
  const message = error.message ?? '';
  const namesColumn = columns.some((c) => new RegExp(c, 'i').test(message));
  if (error.code === 'PGRST204' || error.code === '42703') return namesColumn;
  return namesColumn && /column/i.test(message);
}

/** All DC Solar customers, A→Z. Empty array on error (RLS / offline). */
export async function fetchCustomers(): Promise<Customer[]> {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select('id, name, phone, email, address, company')
      .eq('company', COMPANY)
      .order('name', { ascending: true });
    if (error || !data) return [];
    return data as Customer[];
  } catch {
    return [];
  }
}

/**
 * The signed-in member's total hours on one job: their `employee_hours`
 * rows (matched by display name) plus the durations of their completed
 * `time_entries` (matched by email). RLS already scopes both tables to the
 * member's own rows. Returns 0 on any error so callers can simply hide.
 */
export async function fetchMyJobHours(params: {
  jobId: string;
  displayName: string | null;
  email: string;
}): Promise<number> {
  const { jobId, displayName, email } = params;
  let total = 0;
  try {
    if (displayName) {
      const { data, error } = await supabase
        .from('employee_hours')
        .select('hours')
        .eq('company', COMPANY)
        .eq('job_id', jobId)
        .eq('employee', displayName);
      if (!error && data) {
        for (const row of data as { hours: unknown }[]) {
          const h = Number(row.hours);
          if (Number.isFinite(h)) total += h;
        }
      }
    }

    const { data: entries, error: timeError } = await supabase
      .from('time_entries')
      .select('clock_in, clock_out')
      .eq('company', COMPANY)
      .eq('job_id', jobId)
      .eq('employee', email)
      .not('clock_out', 'is', null);
    if (!timeError && entries) {
      for (const row of entries as { clock_in: string | null; clock_out: string | null }[]) {
        if (!row.clock_in || !row.clock_out) continue;
        const ms = new Date(row.clock_out).getTime() - new Date(row.clock_in).getTime();
        if (Number.isFinite(ms) && ms > 0) total += ms / 3_600_000;
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Next job moniker, computed from the live jobs table so the app and the
 * dcsolarkc.com ops console never diverge: read every `DC-…` job_number,
 * take the max numeric suffix + 1, keep the same digit width
 * (DC-26001…DC-26018 → DC-26019). Null when the table can't be read.
 */
export async function nextJobNumber(): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select('job_number')
      .eq('company', COMPANY)
      .like('job_number', 'DC-%');
    if (error || !data) return null;

    let max = 0;
    let width = 5;
    for (const row of data as { job_number: string | null }[]) {
      const match = /^DC-(\d+)$/.exec(row.job_number ?? '');
      if (!match) continue;
      const n = Number(match[1]);
      if (!Number.isFinite(n)) continue;
      if (n > max) {
        max = n;
        width = match[1].length;
      }
    }
    if (max === 0) return 'DC-26001';
    return `DC-${String(max + 1).padStart(width, '0')}`;
  } catch {
    return null;
  }
}

export interface JobEditableFields {
  name: string;
  description: string | null;
  /** Legacy status column — always statusForStage(stage) so the ops console stays in sync. */
  status: Job['status'];
  /** Pipeline stage (column may not exist pre-migration; writes fall back). */
  stage: Stage;
  address: string | null;
  customer_id: string | null;
  project_manager: string | null;
  project_manager_phone: string | null;
  /** YYYY-MM-DD when stage is Complete, null otherwise (migration 10). */
  completed_on: string | null;
  /** Panels on this job — seeds the company metrics + hours forecast (migration 20). */
  module_count: number | null;
  /** R&R | Reinstall | Install | Critter Guard | Other (migration 20). */
  job_type: JobType | null;
  /**
   * Panels covered by critter guard. Null means "all of them" — resolution
   * falls back to module_count (migration 20/21).
   */
  critter_guard_panels: number | null;
  /** Critter guard was installed on this job, whatever its type (migration 21). */
  has_critter_guard: boolean;
}

export const JOB_TYPES = ['R&R', 'Reinstall', 'Install', 'Critter Guard', 'Other'] as const;
export type JobType = (typeof JOB_TYPES)[number];

/**
 * Best-guess module count from a job's free text.
 *
 * Counts were historically only ever written into the job NAME, in at least
 * six shapes — "(22 modules)", "- 38 Modules", "of 10 modules",
 * "43 panel removal", "39 module install", "38 new modules" — plus a typo'd
 * "18 mobules" that we deliberately match. Against the 25 live jobs this
 * resolves 19; the rest have no count written down anywhere.
 *
 * This only SEEDS jobs.module_count when creating/editing a job. The column is
 * the source of truth so that fixing a typo in a title can never silently move
 * the company's statistics.
 */
export function parseModuleCount(...text: (string | null | undefined)[]): number | null {
  const unit = String.raw`(?:mod[ua]les?|mobules?|panels?)`;
  const rx = new RegExp(String.raw`(\d{1,3})\s*(?:new\s+|used\s+|total\s+)?` + unit, 'i');
  for (const candidate of text) {
    const match = candidate ? rx.exec(candidate) : null;
    if (match) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/** Best-guess job type from a job's name, used to seed the toggle. */
export function parseJobType(name: string | null | undefined): JobType {
  const t = (name ?? '').toLowerCase();
  if (t.includes('critter')) return 'Critter Guard';
  if (t.startsWith('r&r') || t.includes('removal & reinstall') || t.includes('removal and reinstall'))
    return 'R&R';
  if (t.includes('reinstall')) return 'Reinstall';
  if (t.includes('install')) return 'Install';
  return 'Other';
}

export type SaveJobResult =
  | { ok: true; warning?: string }
  | { ok: false; message: string };

/**
 * Build the write payloads to attempt, most complete first. Each optional
 * column group (stage; PM fields; completed_on) that the database may not
 * have yet gets dropped in turn — every subset is generated, ordered by how
 * many groups were dropped — so a job save still lands on an un-migrated
 * database, with the matching warning(s).
 */
function payloadAttempts(fields: JobEditableFields): {
  payload: Record<string, unknown>;
  warnings: string[];
  droppedColumns: string[];
}[] {
  const {
    project_manager,
    project_manager_phone,
    stage,
    completed_on,
    module_count,
    job_type,
    critter_guard_panels,
    has_critter_guard,
    ...rest
  } = fields;
  const groups = [
    { marker: 'stage', warning: STAGE_MIGRATION_WARNING, payload: { stage } },
    {
      marker: 'project_manager',
      warning: PM_MIGRATION_WARNING,
      payload: { project_manager, project_manager_phone },
    },
    {
      marker: 'completed_on',
      warning: COMPLETED_ON_MIGRATION_WARNING,
      payload: { completed_on },
    },
    {
      marker: 'module_count',
      warning: METRICS_MIGRATION_WARNING,
      payload: { module_count, job_type, critter_guard_panels, has_critter_guard },
    },
  ];
  const attempts: { payload: Record<string, unknown>; warnings: string[]; droppedColumns: string[] }[] =
    [];
  for (let mask = 0; mask < 1 << groups.length; mask++) {
    const kept = groups.filter((_, i) => !(mask & (1 << i)));
    const dropped = groups.filter((_, i) => mask & (1 << i));
    attempts.push({
      payload: Object.assign({ ...rest }, ...kept.map((g) => g.payload)),
      warnings: dropped.map((g) => g.warning),
      droppedColumns: dropped.map((g) => g.marker),
    });
  }
  attempts.sort((a, b) => a.droppedColumns.length - b.droppedColumns.length);
  return attempts;
}

/**
 * Given a missing-column error, pick the next attempt (from `attempts`,
 * after index `current`) whose dropped columns cover everything the
 * database has rejected so far. Returns -1 when the error isn't a
 * missing-column error or no attempt fits.
 */
function nextAttempt(
  attempts: ReturnType<typeof payloadAttempts>,
  current: number,
  rejected: Set<string>,
  error: { code?: string; message?: string } | null,
): number {
  if (isMissingColumnError(error, 'module_count')) rejected.add('module_count');
  else if (isMissingColumnError(error, 'stage')) rejected.add('stage');
  else if (isMissingColumnError(error, 'completed_on')) rejected.add('completed_on');
  else if (isMissingColumnError(error, 'project_manager')) rejected.add('project_manager');
  else return -1;
  for (let i = current + 1; i < attempts.length; i++) {
    if ([...rejected].every((c) => attempts[i].droppedColumns.includes(c))) return i;
  }
  return -1;
}

/**
 * Update a job (admin-only per RLS). If the update fails because the stage
 * or PM columns don't exist yet, retries without them and returns a warning.
 * The legacy status column is always written, keeping the ops console in sync.
 */
export async function updateJob(jobId: string, fields: JobEditableFields): Promise<SaveJobResult> {
  try {
    const attempts = payloadAttempts(fields);
    const rejected = new Set<string>();
    let i = 0;
    while (i >= 0 && i < attempts.length) {
      const attempt = attempts[i];
      const { error } = await supabase
        .from('jobs')
        .update(attempt.payload)
        .eq('company', COMPANY)
        .eq('id', jobId);
      if (!error) {
        const warning = attempt.warnings.join(' — ');
        return warning ? { ok: true, warning } : { ok: true };
      }
      const next = nextAttempt(attempts, i, rejected, error);
      if (next === -1) return { ok: false, message: error.message };
      i = next;
    }
    return { ok: false, message: 'Could not save the job.' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the job.' };
  }
}

export type CreateJobResult =
  | { ok: true; id: string; jobNumber: string; warning?: string }
  | { ok: false; message: string };

/**
 * Create a job (admin-only per RLS). Recomputes the job number from a fresh
 * fetch right before inserting (the ops console shares the same sequence);
 * on a duplicate-number race it recomputes once more and retries. Stage and
 * PM columns fall back like updateJob.
 */
export async function createJob(fields: JobEditableFields): Promise<CreateJobResult> {
  try {
    for (let numberAttempt = 0; numberAttempt < 2; numberAttempt++) {
      const jobNumber = await nextJobNumber();
      if (!jobNumber) {
        return { ok: false, message: 'Could not compute the next job number. Check your connection and try again.' };
      }

      const attempts = payloadAttempts(fields);
      const rejected = new Set<string>();
      let i = 0;
      let lastError: { code?: string; message?: string } | null = null;
      while (i >= 0 && i < attempts.length) {
        const attempt = attempts[i];
        const { data, error } = await supabase
          .from('jobs')
          .insert({ ...attempt.payload, company: COMPANY, job_number: jobNumber })
          .select('id')
          .single();
        if (!error && data) {
          const warning = attempt.warnings.join(' — ') || undefined;
          return { ok: true, id: (data as { id: string }).id, jobNumber, warning };
        }
        lastError = error;
        i = nextAttempt(attempts, i, rejected, error);
      }
      // 23505 = unique violation (another device grabbed this number) — retry once.
      if (lastError?.code === '23505' && numberAttempt === 0) continue;
      return { ok: false, message: lastError?.message ?? 'Could not create the job.' };
    }
    return { ok: false, message: 'Could not create the job — the job number was taken twice. Try again.' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not create the job.' };
  }
}

export type CreateCustomerResult =
  | { ok: true; customer: Customer }
  | { ok: false; message: string };

/**
 * Quick-add a customer from the job editor (admin-only per RLS insert
 * policy). Returns the created row so the editor can auto-select it.
 */
export async function createCustomer(input: {
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
}): Promise<CreateCustomerResult> {
  try {
    const { data, error } = await supabase
      .from('customers')
      .insert({
        company: COMPANY,
        name: input.name,
        phone: input.phone,
        email: input.email,
        address: input.address,
      })
      .select('id, name, phone, email, address, company')
      .single();
    if (error || !data) {
      const raw = error?.message ?? '';
      const message = /row-level security|policy/i.test(raw)
        ? 'Adding customers needs the latest database migration.'
        : raw || 'Could not add the customer.';
      return { ok: false, message };
    }
    return { ok: true, customer: data as Customer };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not add the customer.' };
  }
}
