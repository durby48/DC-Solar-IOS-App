/**
 * Job editing helpers (admin-only writes per RLS: owners/operators can
 * update + insert `jobs`; everyone in the company can read).
 *
 * Job numbers stay in lockstep with the dcsolarkc.com ops console: both derive
 * the next `DC-#####` moniker from a fresh read of the jobs table, which is
 * why `createJob` still retries once on a 23505 unique violation.
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
