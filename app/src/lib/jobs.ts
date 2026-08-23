/**
 * Job editing helpers (admin-only writes per RLS: owners/operators can
 * update + insert `jobs`; everyone in the company can read).
 *
 * Job numbers stay in lockstep with the dcsolarkc.com ops console: both derive
 * the next `DC-#####` moniker from a fresh read of the jobs table, which is
 * why `createJob` still retries once on a 23505 unique violation.
 *
 * JOB NUMBERS FILL GAPS (2026-08-23). `nextJobNumber` returns the SMALLEST
 * unused number for the current year, not max + 1 — see the comment on the
 * function. Deleting a job is what made that necessary, and deleting a job is
 * `deleteJob` at the bottom of this file: an RPC, because seventeen tables
 * reference `jobs.id` and three of them hold money or payroll.
 *
 * HISTORICAL NOTE (2026-08-22). Until this file was rewritten, every write
 * generated 2^4 = 16 candidate payloads — one per subset of the optional
 * column groups (`stage`, PM fields, `completed_on`, the metrics quartet) —
 * and walked them on a missing-column error. That existed because the app once
 * shipped ahead of its migrations. Every one of those migrations has been
 * applied for months, so the machinery only ever cost round-trips on a
 * genuinely failing save and made adding a fifth optional column a 32-attempt
 * proposition. Writes now send ONE payload with every column.
 */

import { CUSTOMER_COLUMNS, createCustomerRow } from '@/lib/crm';
import { statusForStage, type Stage } from '@/lib/stages';
import { supabase } from '@/lib/supabase';
import { type Customer, type Job } from '@/lib/types';

const COMPANY = 'dc-solar';

/** Columns beyond the base `Job` shape that the editor reads and writes. */
export interface JobProjectManager {
  project_manager?: string | null;
  project_manager_phone?: string | null;
  /** Pipeline stage (migration 6). */
  stage?: string | null;
  /** Date the project completed (migration 10). */
  completed_on?: string | null;
}

export type JobWithPM = Job & JobProjectManager;

/** All DC Solar customers, A→Z. Empty array on error (RLS / offline). */
export async function fetchCustomers(): Promise<Customer[]> {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select(CUSTOMER_COLUMNS)
      .eq('company', COMPANY)
      .is('archived_at', null)
      .order('name', { ascending: true });
    if (error || !data) return [];
    return data as unknown as Customer[];
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
 * The two-digit year a job number is stamped with: 2026 → '26'. Job numbers
 * are `DC-<yy><nnn>`, so reading the year off the clock is what rolls the
 * sequence to DC-27001 on 1 January without anyone editing this file.
 */
function jobNumberYear(today: Date): string {
  return String(today.getFullYear() % 100).padStart(2, '0');
}

/**
 * The smallest job number for this year that nobody is using.
 *
 * WHY NOT max + 1. Devon can now delete a job (`deleteJob` below). Deleting
 * DC-26033 and then having the next job come out as DC-26034 leaves a hole
 * that nothing will ever fill — the paper trail reads as if a job existed and
 * vanished, and every printed estimate, invoice and contract from then on is
 * off by one against the count of jobs actually done. Filling the gap is what
 * he asked for and what the numbering is for.
 *
 * ONLY THIS YEAR'S NUMBERS ARE CONSIDERED. Last year's DC-25xxx are matched by
 * neither the search nor the result, so a gap left in 2025 stays there: the
 * year prefix is part of the identity of the job, not padding.
 *
 * Exported and pure so the gap logic can be tested without a database.
 */
export function nextJobNumberFrom(
  existing: readonly (string | null | undefined)[],
  today: Date = new Date(),
): string {
  const yy = jobNumberYear(today);
  // `\d{3,}` and not `\d{3}` so a hypothetical DC-261000 (see below) is still
  // counted as used on the next call rather than handed out twice.
  const pattern = new RegExp(`^DC-${yy}(\\d{3,})$`);

  const used = new Set<number>();
  for (const value of existing) {
    const match = pattern.exec((value ?? '').trim());
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isInteger(n) && n >= 1) used.add(n);
  }

  for (let n = 1; n <= 999; n++) {
    if (!used.has(n)) return `DC-${yy}${String(n).padStart(3, '0')}`;
  }

  // 999 jobs in one year and not one gap. Keep counting into a fourth digit
  // rather than returning null — DC-261000 still sorts after DC-26999.
  let n = 1000;
  while (used.has(n)) n++;
  return `DC-${yy}${n}`;
}

/**
 * Next job moniker, computed from the live jobs table so the app and the
 * dcsolarkc.com ops console never hand out the same number.
 *
 * The ops console still does max + 1. That is harmless: the two can only ever
 * disagree about WHICH free number to take, never about whether a number is
 * free, and `jobs_company_job_number_key` is unique on
 * (company, lower(job_number)) — so the loser of a race gets a 23505 and
 * `createJob` recomputes and retries. The visible difference
 * is that a job created in the app reuses a deleted number and one created on
 * the website appends. Null when the table can't be read.
 */
export async function nextJobNumber(): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select('job_number')
      .eq('company', COMPANY)
      .like('job_number', 'DC-%');
    if (error || !data) return null;
    return nextJobNumberFrom((data as { job_number: string | null }[]).map((r) => r.job_number));
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

/**
 * `warning` is kept on the success case even though nothing sets it today —
 * it used to carry the "…needs the latest database migration" text from the
 * dropped column-fallback machinery, and the job editor still renders it. Any
 * future partial-success path has somewhere to land.
 */
export type SaveJobResult =
  | { ok: true; warning?: string }
  | { ok: false; message: string };

/**
 * Update a job (admin-only per RLS). One payload, every column — the legacy
 * `status` column included, which keeps the dcsolarkc.com ops console in sync.
 */
export async function updateJob(jobId: string, fields: JobEditableFields): Promise<SaveJobResult> {
  try {
    const { error } = await supabase
      .from('jobs')
      .update({ ...fields })
      .eq('company', COMPANY)
      .eq('id', jobId);
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the job.' };
  }
}

/**
 * Move a job to a different stage, without touching anything else.
 *
 * The full `updateJob` needs every editable field, which the web job board
 * doesn't have to hand — it only knows the card it just moved. This writes the
 * three columns a stage change actually implies: `stage`, the legacy `status`
 * the dcsolarkc.com ops console still reads, and `completed_on` (stamped when
 * a job lands on Complete, cleared when it leaves).
 */
export async function updateJobStage(jobId: string, stage: Stage): Promise<SaveJobResult> {
  const payload: Record<string, unknown> = {
    stage,
    status: statusForStage(stage),
    completed_on: stage === 'Complete' ? new Date().toISOString().slice(0, 10) : null,
  };
  try {
    const { error } = await supabase
      .from('jobs')
      .update(payload)
      .eq('company', COMPANY)
      .eq('id', jobId);
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not move the job.' };
  }
}

export type CreateJobResult =
  | { ok: true; id: string; jobNumber: string; warning?: string }
  | { ok: false; message: string };

/**
 * Create a job (admin-only per RLS). Recomputes the job number from a fresh
 * fetch right before inserting — the dcsolarkc.com ops console shares the same
 * sequence with no counter table — and on a duplicate-number race (23505) it
 * recomputes once more and retries.
 */
export async function createJob(fields: JobEditableFields): Promise<CreateJobResult> {
  try {
    for (let numberAttempt = 0; numberAttempt < 2; numberAttempt++) {
      const jobNumber = await nextJobNumber();
      if (!jobNumber) {
        return { ok: false, message: 'Could not compute the next job number. Check your connection and try again.' };
      }

      const { data, error } = await supabase
        .from('jobs')
        .insert({ ...fields, company: COMPANY, job_number: jobNumber })
        .select('id')
        .single();
      if (!error && data) {
        return { ok: true, id: (data as { id: string }).id, jobNumber };
      }
      // 23505 = unique violation (another device grabbed this number) — retry once.
      if (error?.code === '23505' && numberAttempt === 0) continue;
      return { ok: false, message: error?.message ?? 'Could not create the job.' };
    }
    return { ok: false, message: 'Could not create the job — the job number was taken twice. Try again.' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not create the job.' };
  }
}

// ---------------------------------------------------------------------------
// Deleting a job
// ---------------------------------------------------------------------------

/** Buckets `delete_job` can orphan objects in. Admins hold delete policies on all three. */
const DELETABLE_BUCKETS = ['contracts', 'job-photos', 'property-art'] as const;

/** Rows that survived the delete with their `job_id` set to null, by table. */
export type JobUnassignedCounts = Record<string, number>;

export type DeleteJobResult =
  | { ok: true; jobNumber: string | null; unassigned: JobUnassignedCounts; filesRemoved: number }
  | {
      ok: false;
      message: string;
      /** True only when retrying with `{ force: true }` would get past this. */
      canForce: boolean;
    };

/**
 * Remove the storage objects `delete_job` just orphaned. Best effort by
 * design: the rows are already gone and committed, so a failed remove leaves
 * an unreferenced file, which is litter, not data loss — whereas throwing here
 * would tell Devon the delete failed when it did not.
 */
async function removeOrphanedFiles(paths: unknown): Promise<number> {
  const grouped = (paths ?? {}) as Record<string, unknown>;
  let removed = 0;
  for (const bucket of DELETABLE_BUCKETS) {
    const raw = grouped[bucket];
    const list = Array.isArray(raw)
      ? raw.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : [];
    if (list.length === 0) continue;
    try {
      const { error } = await supabase.storage.from(bucket).remove(list);
      if (!error) removed += list.length;
    } catch {
      // Ignore — see the doc comment.
    }
  }
  return removed;
}

/**
 * Delete one project. Admin only; never throws.
 *
 * All the work happens in the `delete_job` RPC (migration
 * 2026-08-23_job_delete.sql) because seventeen tables reference `jobs.id` and
 * three of them hold money or payroll. `public.jobs` has no DELETE policy at
 * all, so there is no client-side path that could do this by accident.
 *
 * The RPC refuses (P0001) when the job carries payments, invoices or logged
 * hours, and says how many of each. That refusal is recoverable — passing
 * `{ force: true }` un-assigns them instead (the rows themselves are never
 * deleted) — and the database marks the recoverable case with HINT = 'force',
 * which is what `canForce` reports. The internal company job comes back with
 * HINT = 'never' and no amount of forcing moves it.
 *
 * On success the orphaned contract PDFs, job photos and property artwork are
 * removed from storage best-effort.
 */
export async function deleteJob(
  jobId: string,
  options?: { force?: boolean },
): Promise<DeleteJobResult> {
  const force = options?.force === true;
  try {
    const { data, error } = await supabase.rpc('delete_job', {
      p_job_id: jobId,
      p_force: force,
    });

    if (error) {
      if (error.code === '42501') {
        return {
          ok: false,
          message: 'Only owners and operators can delete a project.',
          canForce: false,
        };
      }
      if (error.code === 'P0002') {
        return {
          ok: false,
          message: 'That project has already been deleted.',
          canForce: false,
        };
      }
      return {
        ok: false,
        message: error.message || 'Could not delete the project.',
        // Branch on the database's own hint, never on the message text.
        canForce: error.code === 'P0001' && error.hint === 'force' && !force,
      };
    }

    const result = (data ?? {}) as {
      deleted?: boolean;
      job_number?: string | null;
      storage_paths?: unknown;
      nulled?: Record<string, unknown>;
    };
    if (!result.deleted) {
      return { ok: false, message: 'Nothing was deleted.', canForce: false };
    }

    const unassigned: JobUnassignedCounts = {};
    for (const [table, count] of Object.entries(result.nulled ?? {})) {
      const n = Number(count);
      if (Number.isFinite(n) && n > 0) unassigned[table] = n;
    }

    const filesRemoved = await removeOrphanedFiles(result.storage_paths);
    return { ok: true, jobNumber: result.job_number ?? null, unassigned, filesRemoved };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not delete the project.',
      canForce: false,
    };
  }
}

export type CreateCustomerResult =
  | { ok: true; customer: Customer }
  | { ok: false; message: string };

/**
 * Quick-add a customer from the job editor (admin-only per RLS insert
 * policy). Returns the created row so the editor can auto-select it.
 *
 * Delegates to `lib/crm.ts` so the duplicate-name message ("it may be
 * archived — check the Archived filter") is the same wherever a customer is
 * created.
 */
export async function createCustomer(input: {
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
}): Promise<CreateCustomerResult> {
  return createCustomerRow({ ...input, notes: null });
}
