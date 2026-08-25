/**
 * Time-off request helpers (time_off_requests table, RLS-enforced).
 * Members insert/select their own requests; admins see and review all.
 * Every function degrades gracefully — never throws.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

export type TimeOffKind = 'unpaid' | 'paid' | 'sick' | 'other';
export type TimeOffStatus = 'pending' | 'approved' | 'denied';

export const TIME_OFF_KIND_LABELS: Record<TimeOffKind, string> = {
  unpaid: 'Unpaid',
  paid: 'Paid',
  sick: 'Sick',
  other: 'Other',
};

export interface TimeOffRequest {
  id: string;
  created_at: string;
  company: string;
  employee: string;
  start_date: string;
  end_date: string;
  kind: TimeOffKind;
  reason: string | null;
  status: TimeOffStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export type TimeOffListResult =
  | { status: 'ok'; requests: TimeOffRequest[] }
  | { status: 'unavailable' };

/** The signed-in user's own requests, newest first. */
export async function fetchMyTimeOff(email: string): Promise<TimeOffListResult> {
  try {
    const { data, error } = await supabase
      .from('time_off_requests')
      .select('*')
      .eq('company', COMPANY)
      .eq('employee', email)
      .order('created_at', { ascending: false });
    if (error) return { status: 'unavailable' };
    return { status: 'ok', requests: (data ?? []) as TimeOffRequest[] };
  } catch {
    return { status: 'unavailable' };
  }
}

/** All pending company requests (admin-only under RLS), oldest first. */
export async function fetchPendingTimeOff(): Promise<TimeOffListResult> {
  try {
    const { data, error } = await supabase
      .from('time_off_requests')
      .select('*')
      .eq('company', COMPANY)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    if (error) return { status: 'unavailable' };
    return { status: 'ok', requests: (data ?? []) as TimeOffRequest[] };
  } catch {
    return { status: 'unavailable' };
  }
}

export type SubmitTimeOffResult =
  | { ok: true; request: TimeOffRequest }
  | { ok: false; message: string };

/** Insert a new pending request for the signed-in user. Never throws. */
export async function submitTimeOff(params: {
  employee: string;
  startDate: string;
  endDate: string;
  kind: TimeOffKind;
  reason: string | null;
}): Promise<SubmitTimeOffResult> {
  try {
    const { data, error } = await supabase
      .from('time_off_requests')
      .insert({
        company: COMPANY,
        employee: params.employee,
        start_date: params.startDate,
        end_date: params.endDate,
        kind: params.kind,
        reason: params.reason,
        status: 'pending',
      })
      .select('*')
      .single();
    if (error || !data) {
      return { ok: false, message: error?.message ?? 'Could not submit the request.' };
    }
    return { ok: true, request: data as TimeOffRequest };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not submit the request.' };
  }
}

export type ReviewTimeOffResult =
  | { ok: true; request: TimeOffRequest }
  | { ok: false; message: string };

/** Approve or deny a pending request (admin-only under RLS). */
export async function reviewTimeOff(params: {
  id: string;
  status: 'approved' | 'denied';
  reviewerEmail: string;
}): Promise<ReviewTimeOffResult> {
  try {
    const { data, error } = await supabase
      .from('time_off_requests')
      .update({
        status: params.status,
        reviewed_by: params.reviewerEmail,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', params.id)
      .select('*')
      .single();
    if (error || !data) {
      return { ok: false, message: error?.message ?? 'Could not update the request.' };
    }
    return { ok: true, request: data as TimeOffRequest };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not update the request.' };
  }
}

/**
 * Map of employee email -> display name for showing who requested time off.
 * RLS: members get just their own row; admins get everyone. Empty on error.
 */
export async function fetchEmployeeNames(): Promise<Record<string, string>> {
  try {
    const { data, error } = await supabase
      .from('employees')
      .select('email, display_name')
      .eq('is_test', false);
    if (error || !data) return {};
    const names: Record<string, string> = {};
    for (const row of data) {
      if (row.email && row.display_name) names[row.email as string] = row.display_name as string;
    }
    return names;
  } catch {
    return {};
  }
}
