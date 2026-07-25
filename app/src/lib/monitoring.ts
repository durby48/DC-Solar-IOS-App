/**
 * Monitoring logins data layer — shared credentials for solar monitoring
 * portals (Enphase, SolarEdge, etc.). All members can read; admins manage.
 * The table may not exist yet (migration pending) — callers get a distinct
 * 'missing' status so screens can degrade gracefully. RLS enforced.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

export interface MonitoringLogin {
  id: string;
  company: string;
  label: string;
  url: string | null;
  username: string | null;
  secret: string | null;
  notes: string | null;
  job_id: string | null;
}

export interface MonitoringLoginInput {
  label: string;
  url: string | null;
  username: string | null;
  secret: string | null;
  notes: string | null;
}

/** True when the error means the monitoring_logins table isn't there yet. */
function isTableMissing(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  const msg = error.message ?? '';
  return /does not exist|schema cache/i.test(msg);
}

export type MonitoringLoginsResult =
  | { status: 'ok'; logins: MonitoringLogin[] }
  | { status: 'missing' }
  | { status: 'unavailable' };

/** Fetch all monitoring logins, alphabetical by label. */
export async function fetchMonitoringLogins(): Promise<MonitoringLoginsResult> {
  try {
    const { data, error } = await supabase
      .from('monitoring_logins')
      .select('id, company, label, url, username, secret, notes, job_id')
      .eq('company', COMPANY)
      .order('label', { ascending: true });
    if (error) {
      return isTableMissing(error) ? { status: 'missing' } : { status: 'unavailable' };
    }
    return { status: 'ok', logins: (data ?? []) as MonitoringLogin[] };
  } catch {
    return { status: 'unavailable' };
  }
}

export type MonitoringMutationResult = { ok: true } | { ok: false; message: string };

function mutationError(error: { code?: string; message?: string } | null): {
  ok: false;
  message: string;
} {
  if (isTableMissing(error)) {
    return { ok: false, message: 'Needs the latest database migration.' };
  }
  return { ok: false, message: error?.message ?? 'Could not save the change.' };
}

/** Admin: add a monitoring login. */
export async function addMonitoringLogin(
  input: MonitoringLoginInput,
): Promise<MonitoringMutationResult> {
  try {
    const { error } = await supabase.from('monitoring_logins').insert({
      company: COMPANY,
      label: input.label,
      url: input.url,
      username: input.username,
      secret: input.secret,
      notes: input.notes,
    });
    if (error) return mutationError(error);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not add the login.' };
  }
}

/** Admin: update an existing monitoring login. */
export async function updateMonitoringLogin(
  id: string,
  input: MonitoringLoginInput,
): Promise<MonitoringMutationResult> {
  try {
    const { error } = await supabase
      .from('monitoring_logins')
      .update({
        label: input.label,
        url: input.url,
        username: input.username,
        secret: input.secret,
        notes: input.notes,
      })
      .eq('id', id)
      .eq('company', COMPANY);
    if (error) return mutationError(error);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the change.' };
  }
}

/** Admin: delete a monitoring login. */
export async function deleteMonitoringLogin(id: string): Promise<MonitoringMutationResult> {
  try {
    const { error } = await supabase
      .from('monitoring_logins')
      .delete()
      .eq('id', id)
      .eq('company', COMPANY);
    if (error) return mutationError(error);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not delete the login.' };
  }
}
