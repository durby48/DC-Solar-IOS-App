/**
 * Estimate / invoice document helpers (admin-only tables).
 *
 * Builds branded HTML for PDF generation, picks unique document numbers,
 * stores generated PDFs in the private `contracts` bucket (so they show up
 * in the job's Documents section), and records rows in `finance_entries`.
 *
 * NOTE: admin UPDATE/DELETE on `finance_entries` requires the latest
 * migration; updateFinanceEntry / deleteFinanceEntry detect a missing policy
 * (zero rows affected) and surface a friendly message instead of throwing.
 */

import { LOGO_DATA_URI } from '../assets/images/logo-base64';
import {
  COMPANY_EMAIL,
  COMPANY_LEGAL_NAME,
  COMPANY_LOCATION,
  COMPANY_NAME,
  COMPANY_PHONE,
  COMPANY_WEBSITE,
} from '@/lib/company';
import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';
const DOCUMENTS_BUCKET = 'contracts';

export type DocumentType = 'invoice' | 'estimate';

export interface LineItem {
  name: string;
  description?: string;
  qty: number;
  rate: number;
}

/** A finance_entries row (subset used by the app). */
export interface FinanceEntry {
  id: string;
  type: 'invoice' | 'estimate' | 'payment' | 'expense';
  amount: number;
  counterparty: string | null;
  description: string | null;
  occurred_on: string | null;
  status: string | null;
  document_number: string | null;
  document_path: string | null;
  line_items: LineItem[] | null;
}

export type FinanceEntriesResult =
  | { status: 'ok'; entries: FinanceEntry[] }
  | { status: 'unavailable' };

/**
 * Fetch a job's invoice/estimate/payment/expense entries, newest first.
 * Returns `unavailable` on any error (non-admin RLS / offline) so callers
 * can degrade to a friendly note.
 */
export async function fetchJobFinanceEntries(jobId: string): Promise<FinanceEntriesResult> {
  try {
    const { data, error } = await supabase
      .from('finance_entries')
      .select(
        'id, type, amount, counterparty, description, occurred_on, status, document_number, document_path, line_items',
      )
      .eq('company', COMPANY)
      .eq('job_id', jobId)
      .in('type', ['invoice', 'estimate', 'payment', 'expense'])
      .order('occurred_on', { ascending: false });
    if (error) return { status: 'unavailable' };
    const entries = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      ...row,
      amount: Number(row.amount) || 0,
    })) as FinanceEntry[];
    return { status: 'ok', entries };
  } catch {
    return { status: 'unavailable' };
  }
}

const MIGRATION_MESSAGE =
  'Editing finance entries needs the latest database migration.';

export type MutateEntryResult = { ok: true } | { ok: false; message: string };

/** Editable finance_entries fields (admin corrections). */
export interface FinanceEntryEdit {
  amount?: number;
  occurred_on?: string | null; // YYYY-MM-DD
  description?: string | null;
  status?: string | null;
}

/**
 * Update a finance entry (admin-only by RLS; requires the migration that
 * adds admin UPDATE on finance_entries). A policy denial surfaces either as
 * an error (PGRST116 / permission denied) or as a silent zero-row update —
 * both map to a friendly "needs the latest migration" message. Never throws.
 */
export async function updateFinanceEntry(
  id: string,
  fields: FinanceEntryEdit,
): Promise<MutateEntryResult> {
  try {
    const { data, error } = await supabase
      .from('finance_entries')
      .update(fields)
      .eq('company', COMPANY)
      .eq('id', id)
      .select('id');
    if (error) {
      if (error.code === 'PGRST116' || error.code === '42501') {
        return { ok: false, message: MIGRATION_MESSAGE };
      }
      return { ok: false, message: error.message };
    }
    if (!data || data.length === 0) return { ok: false, message: MIGRATION_MESSAGE };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the change.' };
  }
}

/**
 * Delete a finance entry (admin-only by RLS; requires the migration that
 * adds admin DELETE on finance_entries). Same missing-policy detection as
 * updateFinanceEntry. Never throws.
 */
export async function deleteFinanceEntry(id: string): Promise<MutateEntryResult> {
  try {
    const { data, error } = await supabase
      .from('finance_entries')
      .delete()
      .eq('company', COMPANY)
      .eq('id', id)
      .select('id');
    if (error) {
      if (error.code === 'PGRST116' || error.code === '42501') {
        return { ok: false, message: MIGRATION_MESSAGE };
      }
      return { ok: false, message: error.message };
    }
    if (!data || data.length === 0) return { ok: false, message: MIGRATION_MESSAGE };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not delete the entry.' };
  }
}

/**
 * Pick the next free document number for a job:
 * `<job_number>-Invoice`, then `-2`, `-3`, … when taken.
 */
export async function nextDocumentNumber(
  jobId: string,
  jobNumber: string,
  type: DocumentType,
): Promise<string> {
  const base = `${jobNumber}-${type === 'invoice' ? 'Invoice' : 'Estimate'}`;
  try {
    const { data, error } = await supabase
      .from('finance_entries')
      .select('document_number')
      .eq('company', COMPANY)
      .eq('job_id', jobId)
      .not('document_number', 'is', null);
    if (error || !data) return base;
    const taken = new Set(
      (data as { document_number: string | null }[]).map((r) => r.document_number ?? ''),
    );
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n++) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}-${Date.now()}`;
  } catch {
    return base;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMoney(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatQty(qty: number): string {
  return Number.isInteger(qty) ? `${qty}` : qty.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function lineItemsTotal(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.qty * item.rate, 0);
}

export interface DocumentHtmlParams {
  type: DocumentType;
  documentNumber: string;
  /** YYYY-MM-DD */
  dateISO: string;
  customerName: string;
  customerAddress?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  jobNumber?: string | null;
  jobName?: string | null;
  jobAddress?: string | null;
  lineItems: LineItem[];
  notes?: string | null;
}

/** Build the branded, print-friendly HTML for an invoice or estimate. */
export function buildDocumentHtml(params: DocumentHtmlParams): string {
  const title = params.type === 'invoice' ? 'Invoice' : 'Estimate';
  const total = lineItemsTotal(params.lineItems);
  const date = new Date(`${params.dateISO}T12:00:00`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const rows = params.lineItems
    .map((item) => {
      const desc = item.description
        ? `<div class="item-desc">${escapeHtml(item.description)}</div>`
        : '';
      return `<tr>
        <td class="col-name">${escapeHtml(item.name)}${desc}</td>
        <td class="col-num">${formatQty(item.qty)}</td>
        <td class="col-num">${formatMoney(item.rate)}</td>
        <td class="col-num">${formatMoney(item.qty * item.rate)}</td>
      </tr>`;
    })
    .join('\n');

  const billTo = [
    `<div class="bill-name">${escapeHtml(params.customerName)}</div>`,
    params.customerAddress ? `<div>${escapeHtml(params.customerAddress)}</div>` : '',
    params.customerEmail ? `<div>${escapeHtml(params.customerEmail)}</div>` : '',
    params.customerPhone ? `<div>${escapeHtml(params.customerPhone)}</div>` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const jobRef = [
    params.jobNumber ? escapeHtml(params.jobNumber) : '',
    params.jobName ? escapeHtml(params.jobName) : '',
  ]
    .filter(Boolean)
    .join(' — ');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(params.documentNumber)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif;
    color: #3D352E;
    background: #FFFFFF;
    padding: 40px 44px;
    font-size: 13px;
    line-height: 1.45;
  }
  .top { display: flex; justify-content: space-between; align-items: flex-start; }
  .logo { width: 210px; height: auto; }
  .company { text-align: right; font-size: 12px; color: #6B5D4F; }
  .company .name { font-size: 15px; font-weight: 800; color: #3D352E; }
  .title-block { margin-top: 34px; }
  .doc-title {
    font-size: 30px; font-weight: 800; letter-spacing: 1px;
    text-transform: uppercase; color: #3D352E;
  }
  .doc-meta { margin-top: 4px; color: #6B5D4F; font-size: 13px; }
  .doc-meta strong { color: #3D352E; }
  .accent-bar { height: 4px; background: #FFB066; border-radius: 2px; margin: 18px 0 24px; }
  .blocks { display: flex; gap: 32px; }
  .block { flex: 1; }
  .block-label {
    font-size: 11px; font-weight: 800; text-transform: uppercase;
    letter-spacing: 1px; color: #6B5D4F; margin-bottom: 6px;
  }
  .bill-name { font-weight: 700; }
  table { width: 100%; border-collapse: collapse; margin-top: 28px; }
  thead th {
    text-align: left; font-size: 11px; font-weight: 800; text-transform: uppercase;
    letter-spacing: 0.8px; color: #3D352E; background: #FFF3E6;
    padding: 9px 12px; border-bottom: 2px solid #FFB066;
  }
  thead th.col-num { text-align: right; }
  tbody td { padding: 10px 12px; border-bottom: 1px solid #ECD9BE; vertical-align: top; }
  td.col-num { text-align: right; white-space: nowrap; }
  .item-desc { color: #6B5D4F; font-size: 12px; margin-top: 2px; }
  .totals { margin-top: 4px; width: 100%; }
  .totals td { border: none; padding: 8px 12px; }
  .totals .label { text-align: right; color: #6B5D4F; font-weight: 700; }
  .totals .value { text-align: right; white-space: nowrap; font-weight: 700; width: 130px; }
  .totals .grand td {
    background: #FFB066; color: #3D352E; font-size: 16px; font-weight: 800;
  }
  .totals .grand .label { color: #3D352E; }
  .tax-note { color: #6B5D4F; font-size: 11px; text-align: right; margin-top: 6px; }
  .notes { margin-top: 30px; }
  .notes p { color: #3D352E; white-space: pre-wrap; }
  .footer {
    margin-top: 48px; padding-top: 14px; border-top: 1px solid #ECD9BE;
    text-align: center; color: #6B5D4F; font-size: 12px; font-weight: 600;
  }
</style>
</head>
<body>
  <div class="top">
    <img class="logo" src="${LOGO_DATA_URI}" alt="${COMPANY_NAME}" />
    <div class="company">
      <div class="name">${COMPANY_NAME}</div>
      <div>${COMPANY_LEGAL_NAME}</div>
      <div>${COMPANY_LOCATION}</div>
      <div>${COMPANY_PHONE}</div>
      <div>${COMPANY_EMAIL}</div>
      <div>${COMPANY_WEBSITE}</div>
    </div>
  </div>

  <div class="title-block">
    <div class="doc-title">${title}</div>
    <div class="doc-meta"><strong>${escapeHtml(params.documentNumber)}</strong> · ${date}</div>
  </div>
  <div class="accent-bar"></div>

  <div class="blocks">
    <div class="block">
      <div class="block-label">Bill to</div>
      ${billTo || '<div>—</div>'}
    </div>
    <div class="block">
      <div class="block-label">Job</div>
      ${jobRef ? `<div class="bill-name">${jobRef}</div>` : ''}
      ${params.jobAddress ? `<div>${escapeHtml(params.jobAddress)}</div>` : ''}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th class="col-name">Item</th>
        <th class="col-num">Qty</th>
        <th class="col-num">Rate</th>
        <th class="col-num">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <table class="totals">
    <tr>
      <td class="label">Subtotal</td>
      <td class="value">${formatMoney(total)}</td>
    </tr>
    <tr class="grand">
      <td class="label">Total</td>
      <td class="value">${formatMoney(total)}</td>
    </tr>
  </table>
  <div class="tax-note">No tax applied</div>

  ${params.notes ? `<div class="notes"><div class="block-label">Notes / terms</div><p>${escapeHtml(params.notes)}</p></div>` : ''}

  <div class="footer">${COMPANY_NAME} · ${COMPANY_WEBSITE} · ${COMPANY_PHONE}</div>
</body>
</html>`;
}

export type UploadPdfResult =
  | { ok: true; storagePath: string }
  | { ok: false; message: string };

/**
 * Upload a generated PDF to the private `contracts` bucket at
 * `<job_id>/<document_number>.pdf` and record it in `job_documents` so it
 * appears in the job's Documents section. Never throws.
 */
export async function uploadGeneratedPdf(params: {
  jobId: string;
  documentNumber: string;
  type: DocumentType;
  localUri: string;
}): Promise<UploadPdfResult> {
  try {
    const response = await fetch(params.localUri);
    const body = await response.arrayBuffer();

    const fileName = `${params.documentNumber}.pdf`;
    const storagePath = `${params.jobId}/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .upload(storagePath, body, { contentType: 'application/pdf', upsert: true });
    if (uploadError) return { ok: false, message: uploadError.message };

    const { data: userData } = await supabase.auth.getUser();
    const { error: insertError } = await supabase.from('job_documents').insert({
      company: COMPANY,
      job_id: params.jobId,
      doc_type: params.type,
      storage_path: storagePath,
      file_name: fileName,
      content_type: 'application/pdf',
      size_bytes: body.byteLength,
      uploaded_by: userData?.user?.email ?? null,
    });
    if (insertError) return { ok: false, message: insertError.message };

    return { ok: true, storagePath };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Upload failed.' };
  }
}

export type InsertEntryResult = { ok: true } | { ok: false; message: string };

/** Insert the finance_entries row for a created invoice/estimate. */
export async function insertDocumentEntry(params: {
  type: DocumentType;
  amount: number;
  counterparty: string;
  description: string | null;
  occurredOn: string; // YYYY-MM-DD
  jobId: string;
  customerId: string | null;
  documentNumber: string;
  documentPath: string | null;
  lineItems: LineItem[];
}): Promise<InsertEntryResult> {
  try {
    const { error } = await supabase.from('finance_entries').insert({
      company: COMPANY,
      type: params.type,
      direction: 'in',
      amount: params.amount,
      currency: 'USD',
      counterparty: params.counterparty,
      description: params.description,
      occurred_on: params.occurredOn,
      status: 'draft',
      job_id: params.jobId,
      customer_id: params.customerId,
      document_number: params.documentNumber,
      document_path: params.documentPath,
      line_items: params.lineItems,
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the entry.' };
  }
}

/** Insert a payment row for a job (insert-only — invoice status never changes). */
export async function recordPayment(params: {
  amount: number;
  counterparty: string;
  occurredOn: string; // YYYY-MM-DD
  jobId: string;
  customerId: string | null;
}): Promise<InsertEntryResult> {
  try {
    const { error } = await supabase.from('finance_entries').insert({
      company: COMPANY,
      type: 'payment',
      direction: 'in',
      amount: params.amount,
      currency: 'USD',
      counterparty: params.counterparty,
      description: 'Payment received',
      occurred_on: params.occurredOn,
      job_id: params.jobId,
      customer_id: params.customerId,
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not record the payment.' };
  }
}
