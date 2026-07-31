/**
 * Job crew assignments — who is expected to work (and earn hours) on each
 * job (migration 16). Everyone can read; admins assign/unassign. Display
 * names fill from the roster by DB trigger.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

export interface Assignment {
  job_id: string;
  email: string;
  /** Roster display name (filled by trigger; falls back to email). */
  name: string;
}

/**
 * Every assignment in the company, grouped by job — one query feeds both
 * the Calendar views and the job screens. Null on error (offline /
 * pre-migration) so callers can hide crew chips.
 */
export async function fetchAssignmentsByJob(): Promise<Map<string, Assignment[]> | null> {
  try {
    const { data, error } = await supabase
      .from('job_assignments')
      .select('job_id, email, employee')
      .eq('company', COMPANY);
    if (error) return null;
    const map = new Map<string, Assignment[]>();
    for (const row of (data ?? []) as { job_id: string; email: string; employee: string | null }[]) {
      const list = map.get(row.job_id) ?? [];
      list.push({ job_id: row.job_id, email: row.email, name: row.employee ?? row.email });
      map.set(row.job_id, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return map;
  } catch {
    return null;
  }
}

export type AssignResult = { ok: true } | { ok: false; message: string };

/** Admin: assign an employee to a job (no-op if already assigned). */
export async function assignToJob(jobId: string, email: string): Promise<AssignResult> {
  try {
    const { error } = await supabase
      .from('job_assignments')
      .upsert(
        { company: COMPANY, job_id: jobId, email },
        { onConflict: 'job_id,email', ignoreDuplicates: true },
      );
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not assign.' };
  }
}

/** Admin: remove an employee from a job. */
export async function unassignFromJob(jobId: string, email: string): Promise<AssignResult> {
  try {
    const { error } = await supabase
      .from('job_assignments')
      .delete()
      .eq('company', COMPANY)
      .eq('job_id', jobId)
      .eq('email', email);
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not unassign.' };
  }
}
