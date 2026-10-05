/**
 * Service visits (2026-10-05, B1): a sales rep books an Interested lead's
 * cleaning or inspection; Ops sees it on the calendar and the Pipeline's
 * "Service Call" column; the crew marks it done.
 *
 * Every write goes through a SECURITY DEFINER function in
 * `supabase/migrations/2026-10-05_service_visits.sql` — they check who may do
 * it (the assigned rep or an admin books / reschedules / cancels; staff but
 * never sales mark done) and do the multi-row work in one transaction. This
 * file only calls them and reads the result. Nothing throws: every call
 * returns `{ ok }`, with the database's own refusal message on failure
 * ("name, phone, email and address are all needed…").
 */

import { supabase } from '@/lib/supabase';

export type ServiceKind = 'Cleaning' | 'Inspection';
export const SERVICE_KINDS: readonly ServiceKind[] = ['Cleaning', 'Inspection'];

export type VisitResult = { ok: true } | { ok: false; message: string };

export interface ServiceVisit {
  jobId: string;
  jobNumber: string | null;
  kind: string | null;
  /** 'Service Call' while booked, 'Complete' once done. */
  stage: string | null;
  /** YYYY-MM-DD */
  date: string | null;
  /** HH:MM:SS, or null for "any time that day". */
  startTime: string | null;
  completedOn: string | null;
  paidAt: string | null;
}

function failure(error: { message?: string } | null | undefined, fallback: string): VisitResult {
  return { ok: false, message: error?.message || fallback };
}

/** 'HH:MM' (24h) → 'HH:MM:00'; empty → null. */
function asTime(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  return /^\d{1,2}:\d{2}$/.test(v) ? `${v.padStart(5, '0')}:00` : v;
}

export async function bookServiceVisit(input: {
  leadId: string;
  kind: ServiceKind;
  /** YYYY-MM-DD */
  date: string;
  /** 'HH:MM', optional */
  startTime?: string | null;
  note?: string | null;
}): Promise<{ ok: true; jobId: string; jobNumber: string; possibleDuplicate: boolean } | { ok: false; message: string }> {
  try {
    const { data, error } = await supabase.rpc('book_service_visit', {
      p_lead_id: input.leadId,
      p_kind: input.kind,
      p_date: input.date,
      p_start: asTime(input.startTime),
      p_note: input.note?.trim() || null,
    });
    if (error || !data) return { ok: false, message: error?.message || 'Could not book the visit.' };
    const row = data as { job_id: string; job_number: string; possible_duplicate_of: string | null };
    return { ok: true, jobId: row.job_id, jobNumber: row.job_number, possibleDuplicate: Boolean(row.possible_duplicate_of) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not book the visit.' };
  }
}

export async function rescheduleServiceVisit(jobId: string, date: string, startTime?: string | null): Promise<VisitResult> {
  try {
    const { error } = await supabase.rpc('reschedule_service_visit', {
      p_job_id: jobId,
      p_date: date,
      p_start: asTime(startTime),
    });
    return error ? failure(error, 'Could not reschedule the visit.') : { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not reschedule the visit.' };
  }
}

export async function cancelServiceVisit(jobId: string, reason?: string | null): Promise<VisitResult> {
  try {
    const { error } = await supabase.rpc('cancel_service_visit', { p_job_id: jobId, p_reason: reason?.trim() || null });
    return error ? failure(error, 'Could not cancel the visit.') : { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not cancel the visit.' };
  }
}

export async function markServiceVisitDone(jobId: string): Promise<VisitResult> {
  try {
    const { error } = await supabase.rpc('mark_service_visit_done', { p_job_id: jobId });
    return error ? failure(error, 'Could not mark the visit done.') : { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not mark the visit done.' };
  }
}

/**
 * The visit a lead was booked into (`leads.converted_job_id`). Readable by
 * admins, and by the rep who booked it (`jobs_sales_service_select`). Null
 * when there is none or it cannot be read.
 */
export async function fetchServiceVisit(jobId: string): Promise<ServiceVisit | null> {
  try {
    const [{ data: job, error }, { data: dates }] = await Promise.all([
      supabase
        .from('jobs')
        .select('id, job_number, job_type, stage, scheduled_for, completed_on, service_paid_at')
        .eq('id', jobId)
        .maybeSingle(),
      supabase
        .from('job_schedule_dates')
        .select('work_date, start_time')
        .eq('job_id', jobId)
        .order('work_date', { ascending: true })
        .limit(1),
    ]);
    if (error || !job) return null;
    const j = job as {
      id: string;
      job_number: string | null;
      job_type: string | null;
      stage: string | null;
      scheduled_for: string | null;
      completed_on: string | null;
      service_paid_at: string | null;
    };
    const first = (dates as { work_date: string; start_time: string | null }[] | null)?.[0] ?? null;
    return {
      jobId: j.id,
      jobNumber: j.job_number,
      kind: j.job_type,
      stage: j.stage,
      date: first?.work_date ?? j.scheduled_for,
      startTime: first?.start_time ?? null,
      completedOn: j.completed_on,
      paidAt: j.service_paid_at,
    };
  } catch {
    return null;
  }
}

/** 'HH:MM:SS' → '9:00 AM'. */
export function formatVisitTime(time: string | null): string | null {
  if (!time) return null;
  const [h, m] = time.split(':').map((n) => Number(n));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}
