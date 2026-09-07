/**
 * Pre-sale appointments for leads (CRM Phase 6, 2026-09-07) — the
 * `lead_appointments` table.
 *
 * A site visit, a consultation, a call, a follow-up: the meeting that happens
 * before there is a job. It is a SIBLING of `job_schedule_dates`, not a row
 * in it — that table is keyed by job and every calendar reader joins it to
 * `jobs`. Same shape where they overlap (a date, an optional start time, a
 * note) so the Calendar can list both side by side.
 *
 * RLS mirrors leads: admins everything; a rep the leads assigned to them
 * plus any appointment they are personally sent to. Reads here never widen
 * that.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

export type AppointmentKind = 'site_visit' | 'consultation' | 'call' | 'follow_up';
export type AppointmentOutcome = 'completed' | 'no_show' | 'rescheduled' | 'canceled';

export const APPOINTMENT_KINDS: AppointmentKind[] = ['site_visit', 'consultation', 'call', 'follow_up'];

export const KIND_LABEL: Record<AppointmentKind, string> = {
  site_visit: 'Site visit',
  consultation: 'Consultation',
  call: 'Phone call',
  follow_up: 'Follow-up',
};

export const OUTCOME_LABEL: Record<AppointmentOutcome, string> = {
  completed: 'Completed',
  no_show: 'No-show',
  rescheduled: 'Rescheduled',
  canceled: 'Canceled',
};

export interface LeadAppointment {
  id: string;
  lead_id: string;
  kind: AppointmentKind;
  /** YYYY-MM-DD */
  appt_date: string;
  /** HH:MM:SS or null = time TBD */
  start_time: string | null;
  duration_minutes: number | null;
  assigned_to: string | null;
  note: string | null;
  outcome: AppointmentOutcome | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** A calendar row: the appointment plus what the Calendar needs to name it. */
export interface LeadAppointmentEntry extends LeadAppointment {
  lead_name: string;
  lead_address: string | null;
}

const COLUMNS =
  'id, lead_id, kind, appt_date, start_time, duration_minutes, assigned_to, note, outcome, created_by, created_at, updated_at';

export type AppointmentsResult = { status: 'ok'; appointments: LeadAppointment[] } | { status: 'unavailable' };
export type AppointmentMutation = { ok: true } | { ok: false; message: string };

function friendly(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (/row-level security|policy/i.test(raw)) return 'You can only schedule appointments on leads assigned to you.';
  if (/relation .* does not exist/i.test(raw)) return 'Appointments need the latest database migration.';
  return raw;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** One lead's appointments, soonest first. */
export async function fetchLeadAppointments(leadId: string): Promise<AppointmentsResult> {
  try {
    const { data, error } = await supabase
      .from('lead_appointments')
      .select(COLUMNS)
      .eq('company', COMPANY)
      .eq('lead_id', leadId)
      .order('appt_date', { ascending: true })
      .order('start_time', { ascending: true, nullsFirst: false });
    if (error) return { status: 'unavailable' };
    return { status: 'ok', appointments: (data ?? []) as unknown as LeadAppointment[] };
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * Appointments in a date range with the lead's name — the Calendar's read.
 * The `leads(...)` join runs under leads RLS; a rep sent to an appointment
 * on a lead they cannot otherwise read gets the row with no lead, which is
 * shown as "Lead" rather than dropped: they still need to know where to be.
 * Empty on any error.
 */
export async function fetchLeadAppointmentsRange(fromISO: string, toISO: string): Promise<LeadAppointmentEntry[]> {
  try {
    const { data, error } = await supabase
      .from('lead_appointments')
      .select(`${COLUMNS}, leads(name, address)`)
      .eq('company', COMPANY)
      .gte('appt_date', fromISO)
      .lte('appt_date', toISO)
      .order('appt_date', { ascending: true })
      .order('start_time', { ascending: true, nullsFirst: false });
    if (error || !data) return [];
    return (data as Record<string, unknown>[]).map((row) => {
      const leads = row.leads;
      const lead = (Array.isArray(leads) ? leads[0] : leads) as { name?: string; address?: string | null } | null | undefined;
      const { leads: _drop, ...rest } = row;
      return {
        ...(rest as unknown as LeadAppointment),
        lead_name: lead?.name ?? 'Lead',
        lead_address: lead?.address ?? null,
      };
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createLeadAppointment(input: {
  leadId: string;
  kind: AppointmentKind;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM (24h) or null for TBD */
  time: string | null;
  assignedTo?: string | null;
  note?: string | null;
}): Promise<AppointmentMutation> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return { ok: false, message: 'Type the date as YYYY-MM-DD.' };
  if (input.time && !/^\d{1,2}:\d{2}$/.test(input.time)) return { ok: false, message: 'Type the time as HH:MM (24-hour).' };
  try {
    const { data: userData } = await supabase.auth.getUser();
    const email = userData?.user?.email ?? null;
    if (!email) return { ok: false, message: 'Sign in to schedule an appointment.' };
    const { error } = await supabase.from('lead_appointments').insert({
      company: COMPANY,
      lead_id: input.leadId,
      kind: input.kind,
      appt_date: input.date,
      start_time: input.time ? `${input.time}:00` : null,
      assigned_to: input.assignedTo ?? null,
      note: input.note?.trim() || null,
      created_by: email,
    });
    if (error) return { ok: false, message: friendly(error.message, 'Could not schedule that.') };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: friendly(e instanceof Error ? e.message : undefined, 'Could not schedule that.') };
  }
}

export async function setAppointmentOutcome(id: string, outcome: AppointmentOutcome | null): Promise<AppointmentMutation> {
  try {
    const { error } = await supabase.from('lead_appointments').update({ outcome }).eq('id', id);
    if (error) return { ok: false, message: friendly(error.message, 'Could not update that appointment.') };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: friendly(e instanceof Error ? e.message : undefined, 'Could not update that appointment.') };
  }
}

export async function deleteLeadAppointment(id: string): Promise<AppointmentMutation> {
  try {
    const { error } = await supabase.from('lead_appointments').delete().eq('id', id);
    if (error) return { ok: false, message: friendly(error.message, 'Could not delete that appointment.') };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: friendly(e instanceof Error ? e.message : undefined, 'Could not delete that appointment.') };
  }
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/** "Tue, Sep 9 · 10:00 AM" / "Tue, Sep 9 · time TBD". */
export function appointmentWhen(a: Pick<LeadAppointment, 'appt_date' | 'start_time'>): string {
  const [y, m, d] = a.appt_date.split('-').map(Number);
  const day =
    y && m && d ? new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : a.appt_date;
  const match = a.start_time ? /^(\d{1,2}):(\d{2})/.exec(a.start_time) : null;
  if (!match) return `${day} · time TBD`;
  let h = Number(match[1]);
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${day} · ${h}:${match[2]} ${suffix}`;
}

/** ISO-ish instant for sorting into the Activity timeline: 9 AM when TBD. */
export function appointmentInstant(a: Pick<LeadAppointment, 'appt_date' | 'start_time'>): string {
  return `${a.appt_date}T${a.start_time ? a.start_time.slice(0, 8) : '09:00:00'}`;
}

/** Still ahead of us and not yet resolved. */
export function isUpcoming(a: LeadAppointment, todayISO: string): boolean {
  return a.outcome == null && a.appt_date >= todayISO;
}
