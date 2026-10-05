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
 *
 * PAYMENT (B2): the card link and "Visit done" go through edge functions
 * (`stripe-card-link`, `service-visit-done`) because they talk to Stripe; the
 * card itself only ever lives at Stripe. A visit's card status is read from
 * its customer record (brand, last 4, payment problem).
 */

import { readFunctionError } from '@/lib/artwork';
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
  /** The customer record the booking made. */
  customerId: string | null;
  /** When they saved a card on the Stripe page; null = no card yet. */
  cardOnFileAt: string | null;
  /** e.g. "Visa •4242" */
  cardLabel: string | null;
  /** Why the last charge did not go through, for admins and the rep. */
  paymentIssue: string | null;
}

export type DoneCharge = 'paid' | 'covered' | 'failed' | 'no_card' | 'not_configured';

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

/**
 * The crew's "Visit done" (B2): marks it done, then charges the annual plan
 * on the saved card. `message` says what happened to the money — the visit is
 * done either way once `ok` is true.
 */
export async function markServiceVisitDone(
  jobId: string,
): Promise<{ ok: true; charge: DoneCharge; message: string } | { ok: false; message: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('service-visit-done', { body: { job_id: jobId } });
    if (error) return { ok: false, message: (await readFunctionError(error)) ?? 'Could not mark the visit done.' };
    const row = data as { charge?: DoneCharge; message?: string };
    return { ok: true, charge: row.charge ?? 'no_card', message: row.message ?? 'Visit done.' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not mark the visit done.' };
  }
}

/** A Stripe page where the customer saves their card (24 hours). */
export async function requestCardLink(jobId: string): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('stripe-card-link', { body: { job_id: jobId } });
    if (error) return { ok: false, message: (await readFunctionError(error)) ?? 'Could not make the card link.' };
    const url = (data as { url?: string })?.url;
    return url ? { ok: true, url } : { ok: false, message: 'Stripe did not return a link.' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not make the card link.' };
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
        .select('id, job_number, job_type, stage, scheduled_for, completed_on, service_paid_at, customer_id')
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
      customer_id: string | null;
    };
    const { data: cust } = j.customer_id
      ? await supabase
          .from('customers')
          .select('card_on_file_at, card_brand, card_last4, payment_issue')
          .eq('id', j.customer_id)
          .maybeSingle()
      : { data: null };
    const c = cust as {
      card_on_file_at: string | null;
      card_brand: string | null;
      card_last4: string | null;
      payment_issue: string | null;
    } | null;
    const brand = c?.card_brand ? c.card_brand.charAt(0).toUpperCase() + c.card_brand.slice(1) : 'Card';
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
      customerId: j.customer_id,
      cardOnFileAt: c?.card_on_file_at ?? null,
      cardLabel: c?.card_last4 ? `${brand} •${c.card_last4}` : null,
      paymentIssue: c?.payment_issue ?? null,
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
