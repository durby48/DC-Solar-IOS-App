/**
 * Paystub helpers (employee_documents table + private `employee-docs` bucket).
 * Members read their own paystubs; admins read all and upload new ones.
 * Every function degrades gracefully — never throws.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';
const BUCKET = 'employee-docs';

export type EmployeeDocType = 'w4' | 'w2' | 'paystub' | 'payroll_report' | 'other';

export interface EmployeeLite {
  id: string;
  email: string;
  display_name: string | null;
}

export interface EmployeeDocument {
  id: string;
  created_at: string;
  company: string;
  employee_id: string;
  doc_type: EmployeeDocType;
  file_path: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number | null;
  period_label: string | null;
  uploaded_by: string | null;
}

/**
 * Employees visible to the current user. RLS: members see only their own
 * row; admins see everyone. Empty array on error.
 */
export async function fetchEmployees(): Promise<EmployeeLite[]> {
  try {
    const { data, error } = await supabase
      .from('employees')
      .select('id, email, display_name')
      .order('display_name', { ascending: true });
    if (error || !data) return [];
    return data as EmployeeLite[];
  } catch {
    return [];
  }
}

/** The signed-in user's own employees.id (null when missing / signed out). */
export async function fetchMyEmployeeId(email: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('employees')
      .select('id')
      .eq('email', email)
      .maybeSingle();
    if (error || !data) return null;
    return data.id as string;
  } catch {
    return null;
  }
}

export type PaystubListResult =
  | { status: 'ok'; paystubs: EmployeeDocument[] }
  | { status: 'unavailable' };

/**
 * Paystub rows, newest first. Pass an employeeId to scope to one employee;
 * omit to fetch everything the current user is allowed to see (RLS scopes
 * members to their own rows, admins to the whole company).
 */
export async function fetchPaystubs(employeeId?: string): Promise<PaystubListResult> {
  try {
    let query = supabase
      .from('employee_documents')
      .select('*')
      .eq('company', COMPANY)
      .eq('doc_type', 'paystub')
      .order('created_at', { ascending: false });
    if (employeeId) query = query.eq('employee_id', employeeId);
    const { data, error } = await query;
    if (error) return { status: 'unavailable' };
    return { status: 'ok', paystubs: (data ?? []) as EmployeeDocument[] };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Short-lived signed URL for viewing a stored paystub (1h). */
export async function getPaystubUrl(filePath: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(filePath, 3600);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

export type UploadPaystubResult =
  | { ok: true; paystub: EmployeeDocument }
  | { ok: false; message: string };

/**
 * Upload a picked PDF to the private `employee-docs` bucket under the
 * employee's folder and record it in `employee_documents` (admin-only under
 * RLS). Never throws — returns a friendly message on failure.
 */
export async function uploadPaystub(params: {
  employeeId: string;
  periodLabel: string;
  fileName: string;
  uri: string;
  contentType: string;
  uploadedBy: string | null;
}): Promise<UploadPaystubResult> {
  const { employeeId, periodLabel, fileName, uri, contentType, uploadedBy } = params;
  try {
    const response = await fetch(uri);
    const body = await response.arrayBuffer();

    const base = fileName.replace(/\.pdf$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_');
    const filePath = `${employeeId}/paystub-${Date.now()}-${base || 'paystub'}.pdf`;

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(filePath, body, { contentType });
    if (uploadError) return { ok: false, message: uploadError.message };

    const { data, error: insertError } = await supabase
      .from('employee_documents')
      .insert({
        company: COMPANY,
        employee_id: employeeId,
        doc_type: 'paystub',
        file_path: filePath,
        file_name: fileName,
        content_type: contentType,
        size_bytes: body.byteLength,
        period_label: periodLabel,
        uploaded_by: uploadedBy,
      })
      .select('*')
      .single();

    if (insertError || !data) {
      return { ok: false, message: insertError?.message ?? 'Could not save the paystub record.' };
    }
    return { ok: true, paystub: data as EmployeeDocument };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Upload failed.' };
  }
}
