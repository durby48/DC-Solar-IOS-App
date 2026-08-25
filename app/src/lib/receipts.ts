/**
 * Receipts data layer — employee expense receipts with photo upload, plus
 * admin review (approve → finance entry, reject). All calls degrade
 * gracefully (never throw); RLS decides what each user can see.
 */

import { compressForUpload } from '@/lib/images';
import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';
const RECEIPTS_BUCKET = 'receipts';

export type ReceiptCategory =
  | 'materials'
  | 'fuel'
  | 'tools'
  | 'supplies'
  | 'vehicle'
  | 'meals'
  | 'other';

export type ReceiptStatus = 'pending' | 'approved' | 'rejected';

export const RECEIPT_CATEGORIES: { value: ReceiptCategory; label: string }[] = [
  { value: 'materials', label: 'Materials' },
  { value: 'fuel', label: 'Fuel' },
  { value: 'tools', label: 'Tools' },
  { value: 'supplies', label: 'Supplies' },
  { value: 'vehicle', label: 'Vehicle' },
  { value: 'meals', label: 'Meals' },
  { value: 'other', label: 'Other' },
];

export interface Receipt {
  id: string;
  created_at: string;
  company: string;
  employee: string;
  job_id: string | null;
  amount: number;
  description: string | null;
  category: ReceiptCategory;
  method: string | null;
  needs_reimbursed: boolean;
  storage_path: string | null;
  status: ReceiptStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  finance_entry_id: string | null;
}

export interface JobOption {
  id: string;
  job_number: string | null;
  name: string;
  address: string | null;
  customerName: string | null;
  status: string;
  /** True for the company overhead container ("DC Solar Company"). */
  is_internal?: boolean | null;
}

function normalizeReceipt(row: Record<string, unknown>): Receipt {
  return {
    ...(row as unknown as Receipt),
    amount: Number(row.amount) || 0,
    needs_reimbursed: Boolean(row.needs_reimbursed),
  };
}

export type ReceiptsResult = { status: 'ok'; receipts: Receipt[] } | { status: 'unavailable' };

/** Fetch the signed-in employee's own receipts, newest first. */
export async function fetchMyReceipts(email: string): Promise<ReceiptsResult> {
  try {
    const { data, error } = await supabase
      .from('receipts')
      .select('*')
      .eq('company', COMPANY)
      .eq('employee', email)
      .order('created_at', { ascending: false });
    if (error) return { status: 'unavailable' };
    return { status: 'ok', receipts: (data ?? []).map(normalizeReceipt) };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Admin: fetch all pending receipts awaiting review, oldest first. */
export async function fetchPendingReceipts(): Promise<ReceiptsResult> {
  try {
    const { data, error } = await supabase
      .from('receipts')
      .select('*')
      .eq('company', COMPANY)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    if (error) return { status: 'unavailable' };
    return { status: 'ok', receipts: (data ?? []).map(normalizeReceipt) };
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * Jobs for the optional job picker: every active job PLUS the internal
 * "DC Solar Company" container (which is completed, so a plain active filter
 * hid it — and overhead receipts like a ladder rack have no other home).
 * The container sorts first. Returns [] on any error.
 */
export async function fetchActiveJobs(): Promise<JobOption[]> {
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, job_number, name, address, status, is_internal, customers(name)')
      .eq('company', COMPANY)
      .or('status.eq.active,is_internal.eq.true')
      .order('job_number', { ascending: true });
    if (error || !data) return [];
    const rows = (data as Record<string, unknown>[]).map((row) => {
      const customer = row.customers as { name: string } | { name: string }[] | null;
      const customerName = Array.isArray(customer) ? (customer[0]?.name ?? null) : (customer?.name ?? null);
      return {
        id: String(row.id ?? ''),
        job_number: (row.job_number as string | null) ?? null,
        name: (row.name as string) ?? '',
        address: (row.address as string | null) ?? null,
        customerName,
        status: (row.status as string) ?? '',
        is_internal: (row.is_internal as boolean | null) ?? null,
      };
    });
    return rows.sort((a, b) => Number(b.is_internal ?? false) - Number(a.is_internal ?? false));
  } catch {
    return [];
  }
}

export type UploadReceiptPhotoResult =
  | { ok: true; storagePath: string }
  | { ok: false; message: string };

/**
 * Upload a receipt photo to the private `receipts` bucket at
 * `<email-localpart>/<timestamp>-<name>.jpg`.
 *
 * Compressed to 1920px first. A receipt is photographed to be READ, so the
 * long edge matters more than the file size — 1920 keeps the total on a
 * printed receipt legible when zoomed while turning a 6 MB camera JPEG into
 * a few hundred kilobytes. Crews file these from driveways on cell data, and
 * that difference is the difference between "sent" and "still uploading".
 */
export async function uploadReceiptPhoto(params: {
  email: string;
  uri: string;
  fileName?: string | null;
  contentType?: string | null;
}): Promise<UploadReceiptPhotoResult> {
  try {
    const compressed = await compressForUpload(params.uri);
    const response = await fetch(compressed.uri);
    const body = await response.arrayBuffer();

    const localPart = (params.email.split('@')[0] || 'user').replace(/[^A-Za-z0-9._-]+/g, '_');
    const rawName = params.fileName ?? 'receipt.jpg';
    const base = rawName.replace(/\.[A-Za-z0-9]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_');
    const storagePath = `${localPart}/${Date.now()}-${base || 'receipt'}.jpg`;

    // Compression re-encodes as JPEG, so a picker that reported image/png
    // would otherwise label JPEG bytes as a PNG — the object key has always
    // been `.jpg`, and now the content type agrees with it.
    const contentType = compressed.compressed
      ? 'image/jpeg'
      : (params.contentType ?? 'image/jpeg');

    const { error } = await supabase.storage
      .from(RECEIPTS_BUCKET)
      .upload(storagePath, body, { contentType });
    if (error) return { ok: false, message: error.message };
    return { ok: true, storagePath };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Photo upload failed.' };
  }
}

/** Short-lived signed URL for viewing a stored receipt photo (1h). */
export async function getReceiptPhotoUrl(storagePath: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage
      .from(RECEIPTS_BUCKET)
      .createSignedUrl(storagePath, 3600);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

export type SubmitReceiptResult = { ok: true; receipt: Receipt } | { ok: false; message: string };

/** Insert a new receipt (status 'pending'). Never throws. */
export async function submitReceipt(params: {
  employee: string;
  amount: number;
  description: string;
  category: ReceiptCategory;
  method: string | null;
  jobId: string | null;
  needsReimbursed: boolean;
  storagePath: string | null;
}): Promise<SubmitReceiptResult> {
  try {
    const { data, error } = await supabase
      .from('receipts')
      .insert({
        company: COMPANY,
        employee: params.employee,
        job_id: params.jobId,
        amount: params.amount,
        description: params.description,
        category: params.category,
        method: params.method,
        needs_reimbursed: params.needsReimbursed,
        storage_path: params.storagePath,
        status: 'pending',
      })
      .select('*')
      .single();
    if (error || !data) {
      return { ok: false, message: error?.message ?? 'Could not save the receipt.' };
    }
    return { ok: true, receipt: normalizeReceipt(data) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the receipt.' };
  }
}

export type ReviewReceiptResult = { ok: true; receipt: Receipt } | { ok: false; message: string };

/**
 * Admin approve: (1) insert the matching finance_entries expense row, then
 * (2) mark the receipt approved and link the entry. If step 2 fails after
 * step 1 succeeded, the partial state is surfaced in the error message.
 */
export async function approveReceipt(
  receipt: Receipt,
  adminEmail: string,
): Promise<ReviewReceiptResult> {
  let financeEntryId: string | null = null;
  try {
    const occurredOn = receipt.created_at.slice(0, 10);
    const { data: entry, error: entryError } = await supabase
      .from('finance_entries')
      .insert({
        company: COMPANY,
        type: 'expense',
        direction: 'out',
        amount: receipt.amount,
        currency: 'USD',
        // The [... NOT yet reimbursed] marker is what the Financials cash
        // position reads to build "Less owed for out-of-pocket" — without it
        // an out-of-pocket receipt was invisible to the reconciliation.
        description:
          (receipt.description ?? `Receipt from ${receipt.employee}`) +
          (receipt.needs_reimbursed
            ? ` [${receipt.method?.trim() || receipt.employee} — NOT yet reimbursed]`
            : ''),
        occurred_on: occurredOn,
        status: 'recorded',
        job_id: receipt.job_id,
        counterparty: receipt.method,
        extracted: {
          source: 'field-app-receipt',
          category: receipt.category,
          needs_reimbursed: receipt.needs_reimbursed,
          receipt_id: receipt.id,
        },
      })
      .select('id')
      .single();
    if (entryError || !entry) {
      return {
        ok: false,
        message: entryError?.message ?? 'Could not create the finance entry.',
      };
    }
    financeEntryId = entry.id as string;

    const { data: updated, error: updateError } = await supabase
      .from('receipts')
      .update({
        status: 'approved',
        reviewed_by: adminEmail,
        reviewed_at: new Date().toISOString(),
        finance_entry_id: financeEntryId,
      })
      .eq('id', receipt.id)
      .select('*')
      .single();
    if (updateError || !updated) {
      return {
        ok: false,
        message: `The expense entry was recorded, but the receipt could not be marked approved${
          updateError?.message ? ` (${updateError.message})` : ''
        }. Check the finance log before retrying to avoid a duplicate entry.`,
      };
    }
    return { ok: true, receipt: normalizeReceipt(updated) };
  } catch (e) {
    const base = e instanceof Error ? e.message : 'Approval failed.';
    return {
      ok: false,
      message: financeEntryId
        ? `The expense entry was recorded, but the receipt update failed: ${base}`
        : base,
    };
  }
}

/** Admin reject: mark the receipt rejected with reviewer info. */
export async function rejectReceipt(
  receiptId: string,
  adminEmail: string,
): Promise<ReviewReceiptResult> {
  try {
    const { data, error } = await supabase
      .from('receipts')
      .update({
        status: 'rejected',
        reviewed_by: adminEmail,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', receiptId)
      .select('*')
      .single();
    if (error || !data) {
      return { ok: false, message: error?.message ?? 'Could not reject the receipt.' };
    }
    return { ok: true, receipt: normalizeReceipt(data) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not reject the receipt.' };
  }
}
