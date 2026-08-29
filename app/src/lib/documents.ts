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

import { Platform } from 'react-native';

import { LOGO_DATA_URI } from '../assets/images/logo-base64';
import { readFunctionError } from '@/lib/artwork';
import {
  COMPANY_EMAIL,
  COMPANY_LEGAL_NAME,
  COMPANY_LOCATION,
  COMPANY_NAME,
  COMPANY_PHONE,
  COMPANY_WEBSITE,
} from '@/lib/company';
import { todayISO } from '@/lib/dates';
import { type Job } from '@/lib/types';
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

/**
 * The money breakdown a document prints. INVARIANT (asserted server-side by
 * revise_document): `finance_entries.amount` === `total`.
 */
export interface DocumentTotals {
  subtotal: number;
  /** Absolute dollars taken off the subtotal, never a percentage. */
  discount: number;
  tax: number;
  total: number;
}

/**
 * The customer as they were WHEN THE DOCUMENT WAS WRITTEN.
 *
 * A PDF is a statement about a moment. Re-rendering revision 1 from today's
 * `customers` row would silently rewrite history the first time somebody
 * fixes a typo in an address, so the builder freezes these four fields into
 * `document_meta` and offers to adopt the live record explicitly.
 */
export interface CustomerSnapshot {
  name: string;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
}

/** `finance_entries.document_meta` — everything the PDF needs beyond line items. */
export interface DocumentMeta {
  customer_snapshot?: CustomerSnapshot | null;
  /** YYYY-MM-DD; estimates only, printed under the document number. */
  valid_until?: string | null;
  totals?: DocumentTotals | null;
  /** Sales tax RATE as a percentage (8.5 = 8.5 %), not an amount. */
  tax?: number | null;
  /** Discount AMOUNT in dollars, not a percentage. */
  discount?: number | null;
  /**
   * 'stale' means the row moved but the stored PDF did not — the save
   * succeeded and the render did not. Every surface that offers the PDF says
   * so, and the builder offers Retry PDF.
   */
  pdf_state?: 'current' | 'stale';
  /** Double-tap / retry guard; revise_document() returns early on a repeat. */
  last_client_token?: string | null;
}

/** A finance_entries row (subset used by the app). */
export interface FinanceEntry {
  id: string;
  /** See FinanceType in lib/financials.ts — 'investment' is capital, not income. */
  type: 'invoice' | 'estimate' | 'contract' | 'payment' | 'expense' | 'investment';
  amount: number;
  counterparty: string | null;
  description: string | null;
  occurred_on: string | null;
  status: string | null;
  document_number: string | null;
  document_path: string | null;
  line_items: LineItem[] | null;
  /** The document's notes / terms block (persisted since 2026-08-22). */
  notes: string | null;
  /** 1 = as first created. The document NUMBER never changes; this does. */
  revision: number | null;
  revised_at: string | null;
  document_meta: DocumentMeta | null;
  job_id: string | null;
  customer_id: string | null;
}

/** One row of `finance_entry_revisions` — the append-only history. */
export interface EntryRevision {
  id: string;
  created_at: string;
  entry_id: string;
  revision: number;
  type: string | null;
  amount: number;
  occurred_on: string | null;
  description: string | null;
  notes: string | null;
  line_items: LineItem[] | null;
  document_meta: DocumentMeta | null;
  document_number: string | null;
  /** The IMMUTABLE archive copy for this revision, not the living path. */
  document_path: string | null;
  created_by: string | null;
}

/**
 * Every column the app reads off a document row. Kept in one place because
 * three call sites (job card, builder, history) must agree or a revision
 * loads with half its fields missing.
 */
// Deliberately ONE string literal: supabase-js parses the select list at the
// type level, and a concatenated string widens to `string`, which makes every
// row come back as GenericStringError.
const ENTRY_COLUMNS =
  'id, type, amount, counterparty, description, occurred_on, status, document_number, document_path, line_items, notes, revision, revised_at, document_meta, job_id, customer_id';

function normalizeEntry(row: Record<string, unknown>): FinanceEntry {
  return {
    ...(row as unknown as FinanceEntry),
    amount: Number(row.amount) || 0,
    revision: row.revision == null ? 1 : Number(row.revision) || 1,
  };
}

export type FinanceEntriesResult =
  | { status: 'ok'; entries: FinanceEntry[] }
  | { status: 'unavailable' };

/**
 * Fetch a job's invoice/estimate/payment/expense/investment entries, newest
 * first. 'investment' is included because owner capital is tagged to the
 * Company container job — leaving it out of this filter would make $4,200 of
 * real money invisible on the one screen you would look for it on.
 * Returns `unavailable` on any error (non-admin RLS / offline) so callers
 * can degrade to a friendly note.
 */
export async function fetchJobFinanceEntries(jobId: string): Promise<FinanceEntriesResult> {
  try {
    const { data, error } = await supabase
      .from('finance_entries')
      .select(ENTRY_COLUMNS)
      .eq('company', COMPANY)
      .eq('job_id', jobId)
      .in('type', ['invoice', 'estimate', 'contract', 'payment', 'expense', 'investment'])
      .order('occurred_on', { ascending: false });
    if (error) return { status: 'unavailable' };
    const entries = ((data ?? []) as Record<string, unknown>[]).map(normalizeEntry);
    return { status: 'ok', entries };
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * Load one document row by id — everything the builder needs to reopen it.
 * Null on any failure (RLS / offline / gone), never throws.
 */
export async function fetchFinanceEntry(id: string): Promise<FinanceEntry | null> {
  try {
    const { data, error } = await supabase
      .from('finance_entries')
      .select(ENTRY_COLUMNS)
      .eq('company', COMPANY)
      .eq('id', id)
      .limit(1);
    const row = (data ?? [])[0] as Record<string, unknown> | undefined;
    if (error || !row) return null;
    return normalizeEntry(row);
  } catch {
    return null;
  }
}

/**
 * A document's revision history, newest first. Admin SELECT only, and the
 * table has no write policy at all — rows only ever arrive via
 * revise_document(). Returns [] when the query fails so the history section
 * simply doesn't appear.
 */
export async function fetchEntryRevisions(entryId: string): Promise<EntryRevision[]> {
  try {
    const { data, error } = await supabase
      .from('finance_entry_revisions')
      .select(
        'id, created_at, entry_id, revision, type, amount, occurred_on, description, notes, line_items, document_meta, document_number, document_path, created_by',
      )
      .eq('entry_id', entryId)
      .order('revision', { ascending: false });
    if (error || !data) return [];
    return (data as Record<string, unknown>[]).map((row) => ({
      ...(row as unknown as EntryRevision),
      amount: Number(row.amount) || 0,
      revision: Number(row.revision) || 1,
    }));
  } catch {
    return [];
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
  document_number?: string | null;
  document_path?: string | null;
  /** null = company-level (no job). */
  job_id?: string | null;
  /** False if paid out of pocket / in cash rather than from the bank account. */
  paid_from_bank?: boolean;
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

function roundCents(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

/**
 * The one place subtotal / discount / tax / total are computed.
 *
 * `discount` is DOLLARS off the subtotal, `taxRate` is a PERCENTAGE applied
 * after the discount. Everything is rounded to cents here, once, because the
 * PDF and the finance row are rendered from different sides of the app and
 * revise_document() rejects a save where they disagree by more than half a
 * cent. A discount larger than the subtotal is clamped rather than refused —
 * a negative document is never what anybody meant.
 */
export function computeTotals(
  items: LineItem[],
  discount?: number | null,
  taxRate?: number | null,
): DocumentTotals {
  const subtotal = roundCents(lineItemsTotal(items));
  const rawDiscount = Number(discount);
  const safeDiscount = Number.isFinite(rawDiscount) && rawDiscount > 0 ? rawDiscount : 0;
  const appliedDiscount = roundCents(Math.min(safeDiscount, subtotal));
  const taxable = roundCents(subtotal - appliedDiscount);
  const rawRate = Number(taxRate);
  const safeRate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 0;
  const tax = roundCents((taxable * safeRate) / 100);
  return {
    subtotal,
    discount: appliedDiscount,
    tax,
    total: roundCents(taxable + tax),
  };
}

export interface DocumentHtmlParams {
  /** 'projection' is a LEAD document — same layout, zero financial weight. */
  type: DocumentType | 'contract' | 'projection';
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
  /** Prints "· Rev N" beside the document number, but only when N > 1. */
  revision?: number | null;
  /** YYYY-MM-DD; prints a "Valid until" line when set. */
  validUntil?: string | null;
  /** Discount AMOUNT in dollars. */
  discount?: number | null;
  /** Sales tax RATE as a percentage. */
  tax?: number | null;
}

/**
 * Build the branded, print-friendly HTML for an invoice or estimate.
 *
 * PURE — no storage, no network, no clock. The web renderer posts this exact
 * string to an edge function while native hands it to expo-print, so both
 * platforms must be able to produce the same bytes from the same row.
 *
 * The revision / valid-until / discount / tax parameters are all additive and
 * emit NOTHING when absent: the output for a document written before
 * 2026-08-22 is byte-for-byte what it always was, right down to the literal
 * "No tax applied" note.
 */
export function buildDocumentHtml(params: DocumentHtmlParams): string {
  const title =
    params.type === 'invoice'
      ? 'Invoice'
      : params.type === 'contract'
        ? 'Contract'
        : params.type === 'projection'
          ? 'Projection'
          : 'Estimate';
  const totals = computeTotals(params.lineItems, params.discount, params.tax);
  const total = totals.total;
  const date = new Date(`${params.dateISO}T12:00:00`).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const revision = Number(params.revision) || 0;
  const revisionSuffix = revision > 1 ? ` · Rev ${revision}` : '';
  const validUntil = params.validUntil
    ? `\n    <div class="doc-meta">Valid until ${escapeHtml(
        new Date(`${params.validUntil}T12:00:00`).toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        }),
      )}</div>`
    : '';
  const discountRow =
    totals.discount > 0
      ? `\n    <tr>
      <td class="label">Discount</td>
      <td class="value">−${formatMoney(totals.discount)}</td>
    </tr>`
      : '';
  const taxRate = Number(params.tax) || 0;
  const taxRow =
    totals.tax > 0
      ? `\n    <tr>
      <td class="label">Tax (${taxRate.toLocaleString('en-US', { maximumFractionDigits: 3 })}%)</td>
      <td class="value">${formatMoney(totals.tax)}</td>
    </tr>`
      : '';
  const taxNote =
    totals.tax > 0
      ? `<div class="tax-note">Includes ${taxRate.toLocaleString('en-US', {
          maximumFractionDigits: 3,
        })}% sales tax</div>`
      : '<div class="tax-note">No tax applied</div>';

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
    <div class="doc-meta"><strong>${escapeHtml(params.documentNumber)}</strong> · ${date}${revisionSuffix}</div>${validUntil}
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
      <td class="value">${formatMoney(totals.subtotal)}</td>
    </tr>${discountRow}${taxRow}
    <tr class="grand">
      <td class="label">Total</td>
      <td class="value">${formatMoney(total)}</td>
    </tr>
  </table>
  ${taxNote}

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
 *
 * The registry insert is GUARDED (2026-08-22): it used to fire
 * unconditionally, so regenerating a document left a second job_documents row
 * pointing at the same object — the duplicate pair the revisions migration had
 * to clean up. `generateContractPdf` had this guard from the start; now they
 * match. `financeEntryId` links the registry row to the money row instead of
 * relying on the path-naming convention.
 */
export async function uploadGeneratedPdf(params: {
  jobId: string;
  documentNumber: string;
  type: DocumentType;
  localUri: string;
  financeEntryId?: string | null;
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

    const registered = await registerJobDocument({
      jobId: params.jobId,
      docType: params.type,
      storagePath,
      fileName,
      sizeBytes: body.byteLength,
      financeEntryId: params.financeEntryId ?? null,
    });
    if (!registered.ok) return registered;

    return { ok: true, storagePath };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Upload failed.' };
  }
}

/**
 * Point the job_documents registry at a stored PDF exactly once.
 *
 * The table now carries `unique (company, storage_path)`, so a blind insert on
 * a regenerated document is a constraint violation rather than a duplicate
 * row. Update first (the admin UPDATE policy landed with the revisions
 * migration), insert only when nothing was there.
 */
async function registerJobDocument(params: {
  jobId: string;
  docType: string;
  storagePath: string;
  fileName: string;
  sizeBytes: number | null;
  financeEntryId: string | null;
}): Promise<MutateEntryResult> {
  try {
    const { data: updated, error: updateError } = await supabase
      .from('job_documents')
      .update({
        size_bytes: params.sizeBytes,
        doc_type: params.docType,
        ...(params.financeEntryId ? { finance_entry_id: params.financeEntryId } : {}),
      })
      .eq('company', COMPANY)
      .eq('storage_path', params.storagePath)
      .select('id');
    if (!updateError && updated && updated.length > 0) return { ok: true };

    const { data: userData } = await supabase.auth.getUser();
    const { error: insertError } = await supabase.from('job_documents').insert({
      company: COMPANY,
      job_id: params.jobId,
      doc_type: params.docType,
      storage_path: params.storagePath,
      file_name: params.fileName,
      content_type: 'application/pdf',
      size_bytes: params.sizeBytes,
      uploaded_by: userData?.user?.email ?? null,
      ...(params.financeEntryId ? { finance_entry_id: params.financeEntryId } : {}),
    });
    // 23505 = the unique key caught a race; the row we wanted exists already.
    if (insertError && insertError.code !== '23505') {
      return { ok: false, message: insertError.message };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not record the PDF.' };
  }
}

export type InsertEntryResult = { ok: true; id: string | null } | { ok: false; message: string };

/**
 * Insert the finance_entries row for a created invoice/estimate.
 *
 * `notes` and `documentMeta` persist since 2026-08-22 — they used to be typed
 * into the builder, rendered into the PDF and then thrown away, which is why
 * reopening a document could not show them back. The row starts at revision 1
 * (the column default); revise_document() owns every number after that.
 */
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
  notes?: string | null;
  documentMeta?: DocumentMeta | null;
}): Promise<InsertEntryResult> {
  try {
    const { data, error } = await supabase
      .from('finance_entries')
      .insert({
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
        notes: params.notes ?? null,
        document_meta: params.documentMeta ?? null,
      })
      .select('id');
    if (error) return { ok: false, message: error.message };
    return { ok: true, id: ((data ?? [])[0] as { id?: string } | undefined)?.id ?? null };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the entry.' };
  }
}

// ---------------------------------------------------------------------------
// Revisions (2026-08-22) — revise in place, keep the history
// ---------------------------------------------------------------------------

/** The LIVING object: overwritten in place on every revision. */
export function documentStoragePath(jobId: string, documentNumber: string): string {
  return `${jobId}/${documentNumber}.pdf`;
}

/** The IMMUTABLE archive copy of one revision. Never overwritten. */
export function revisionStoragePath(
  jobId: string,
  documentNumber: string,
  revision: number,
): string {
  return `${jobId}/revisions/${documentNumber}-r${revision}.pdf`;
}

/**
 * A UUID for the save's idempotency token.
 *
 * `crypto.randomUUID` exists on web and on modern Hermes, but this bundle
 * ships to a phone that may not have it and the RPC parameter is typed `uuid`,
 * so a malformed fallback would be rejected outright. Hence the ladder:
 * randomUUID → getRandomValues → Math.random. The token only has to be unique
 * against ONE row's `last_client_token`, so the weakest rung is still safe.
 */
export function newClientToken(): string {
  const cryptoRef = (globalThis as { crypto?: Crypto }).crypto;
  try {
    if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
  } catch {
    // fall through
  }
  const bytes = new Uint8Array(16);
  try {
    if (cryptoRef && typeof cryptoRef.getRandomValues === 'function') {
      cryptoRef.getRandomValues(bytes);
    } else {
      for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
  } catch {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) hex.push(bytes[i].toString(16).padStart(2, '0'));
  return (
    `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-` +
    `${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
  );
}

export type UploadRevisionResult =
  | {
      ok: true;
      storagePath: string;
      /** null when the archive copy failed — see RenderDocumentResult. */
      archivePath: string | null;
      sizeBytes: number;
      warning?: string;
    }
  | { ok: false; message: string; code?: 'conflict' };

/**
 * Store one revision's PDF: overwrite the living object AND keep an immutable
 * archive copy at `revisions/<docnum>-r<N>.pdf`.
 *
 * Deliberately does NOT touch job_documents — revise_document() owns the
 * registry, and a second writer racing it is exactly how the duplicate rows
 * appeared in the first place.
 *
 * On the first revision (N = 2) the CURRENT object is copied to `-r1` so
 * revision 1 stays openable. That copy is best-effort on purpose: 24 of the 35
 * legacy document rows point at ops-console paths with no object in this
 * bucket at all, so a missing source is normal and must not fail the save.
 */
export async function uploadRevisionPdf(params: {
  jobId: string;
  documentNumber: string;
  revision: number;
  localUri: string;
  /** When given, the upload is refused if this entry has already moved past
   *  `revision - 1` — so a stale client never overwrites the living PDF or a
   *  newer revision's archive before revise_document() can raise 40001. */
  entryId?: string;
}): Promise<UploadRevisionResult> {
  try {
    const storagePath = documentStoragePath(params.jobId, params.documentNumber);
    const archivePath = revisionStoragePath(
      params.jobId,
      params.documentNumber,
      params.revision,
    );

    if (params.entryId) {
      // Pre-flight revision check (review finding: the archive object used to
      // be written BEFORE the RPC, so the loser of a race clobbered the
      // winner's bytes). Best-effort: a read failure falls through and the
      // RPC's own expected-revision check still protects the row.
      const { data: current } = await supabase
        .from('finance_entries')
        .select('revision')
        .eq('id', params.entryId)
        .maybeSingle();
      const liveRevision = (current as { revision?: number | null } | null)?.revision ?? null;
      if (liveRevision != null && liveRevision + 1 !== params.revision) {
        return { ok: false, code: 'conflict', message: REVISE_CONFLICT_MESSAGE };
      }
    }

    if (params.revision === 2) {
      const legacyArchive = revisionStoragePath(params.jobId, params.documentNumber, 1);
      try {
        await supabase.storage.from(DOCUMENTS_BUCKET).copy(storagePath, legacyArchive);
      } catch {
        // No object at the living path (or -r1 already there). Both fine.
      }
    }

    const response = await fetch(params.localUri);
    const body = await response.arrayBuffer();

    const { error: liveError } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .upload(storagePath, body, { contentType: 'application/pdf', upsert: true });
    if (liveError) return { ok: false, message: liveError.message };

    const { error: archiveError } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .upload(archivePath, body, { contentType: 'application/pdf', upsert: true });

    return {
      ok: true,
      storagePath,
      // The living PDF is right, which is what everybody looks at; only the
      // history link for this one revision is missing, so the history row
      // falls back to the living path rather than a phantom archive object.
      archivePath: archiveError ? null : archivePath,
      sizeBytes: body.byteLength,
      ...(archiveError
        ? { warning: `The revision archive copy failed to save: ${archiveError.message}` }
        : {}),
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not store the PDF.' };
  }
}

export const WEB_PDF_NOT_CONFIGURED =
  "PDF generation on the web isn't set up yet — the revision was saved; regenerate from the " +
  'iPhone app or ask Devon to finish PDF setup.';

export type RenderDocumentResult =
  | {
      ok: true;
      storagePath: string;
      /**
       * null when the archive copy could not be written — the history row then
       * falls back to the living path rather than pointing at nothing.
       */
      archivePath: string | null;
      sizeBytes: number | null;
      /** Native only — the printer's temp file, for Share / Preview. */
      localUri?: string;
      warning?: string;
    }
  | { ok: false; message: string; code?: 'not_configured' | 'conflict' };

/** Peek at a failed invoke()'s JSON body without consuming it. */
async function readFunctionPayload(error: unknown): Promise<Record<string, unknown> | null> {
  const context = (error as { context?: unknown })?.context;
  if (!context || typeof context !== 'object') return null;
  const response = context as Response;
  try {
    if (typeof response.clone === 'function') {
      return (await response.clone().json()) as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }
  return null;
}

/**
 * Render a document's HTML to a stored PDF, on whichever platform we are.
 *
 * Native uses expo-print and uploads the bytes itself. Web has no printer that
 * can produce a FILE (window.print() opens a dialog and stores nothing), so it
 * posts the same HTML to the `render-document` edge function, which renders it
 * server-side and writes both objects with the service role. Either way the
 * caller then calls reviseDocument() — one save path, two renderers.
 *
 * Never throws. A failure here is not a failed save: the caller records the
 * revision with pdf_state 'stale' and offers Retry PDF.
 */
export async function renderDocumentPdf(params: {
  html: string;
  entryId: string;
  jobId: string;
  documentNumber: string;
  revision: number;
}): Promise<RenderDocumentResult> {
  if (Platform.OS === 'web') {
    try {
      const { data, error } = await supabase.functions.invoke('render-document', {
        body: {
          entryId: params.entryId,
          jobId: params.jobId,
          documentNumber: params.documentNumber,
          revision: params.revision,
          html: params.html,
        },
      });
      if (error) {
        const payload = await readFunctionPayload(error);
        if (payload?.code === 'not_configured') {
          return { ok: false, code: 'not_configured', message: WEB_PDF_NOT_CONFIGURED };
        }
        const detail = await readFunctionError(error);
        return { ok: false, message: detail ?? error.message ?? 'The PDF service failed.' };
      }
      const result = data as {
        ok?: boolean;
        code?: string;
        error?: string;
        warning?: string;
        storagePath?: string;
        archivePath?: string | null;
        sizeBytes?: number;
      } | null;
      if (result?.code === 'not_configured') {
        return { ok: false, code: 'not_configured', message: WEB_PDF_NOT_CONFIGURED };
      }
      if (!result?.ok || !result.storagePath) {
        return { ok: false, message: result?.error ?? 'The PDF service failed.' };
      }
      return {
        ok: true,
        storagePath: result.storagePath,
        // The function returns archivePath: null when only the archive copy
        // failed. Honour that instead of inventing a path to an object that
        // isn't there.
        archivePath: result.archivePath ?? null,
        sizeBytes: typeof result.sizeBytes === 'number' ? result.sizeBytes : null,
        ...(result.warning ? { warning: result.warning } : {}),
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'The PDF service failed.' };
    }
  }

  try {
    const Print = await import('expo-print');
    const { uri } = await Print.printToFileAsync({ html: params.html });
    const stored = await uploadRevisionPdf({
      jobId: params.jobId,
      documentNumber: params.documentNumber,
      revision: params.revision,
      entryId: params.entryId,
      localUri: uri,
    });
    if (!stored.ok) return stored;
    return { ...stored, localUri: uri };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not create the PDF.' };
  }
}

export type ReviseResult =
  | { ok: true; revision: number; entryId: string }
  /**
   * `code: 'conflict'` is the ONE failure a retry cannot fix — somebody else
   * revised this document while it was open here, so the render, the archive
   * object and the revision number this client computed all describe a
   * document that no longer exists. The caller has to reload, not re-fire.
   */
  | { ok: false; code?: 'conflict'; message: string };

const REVISE_MIGRATION_MESSAGE =
  'Revising documents needs the latest database migration.';

const REVISE_CONFLICT_MESSAGE =
  'This document was revised elsewhere. Reload it and try again.';

/**
 * Did `revise_document()` refuse because our expected revision was stale?
 *
 * SQLSTATE 40001 (serialization_failure) is what the function raises, and
 * PostgREST passes the code through untouched. The message is checked too
 * because a 40001 can in principle reach here from a genuine serialization
 * failure in some future wrapping — the text ("revised elsewhere") is raised
 * by nothing else in this schema, so matching either is safe in both
 * directions.
 */
function isRevisionConflict(error: { code?: string | null; message?: string | null }): boolean {
  if (error.code === '40001') return true;
  return /revised elsewhere/i.test(error.message ?? '');
}

/**
 * Revise an estimate / invoice / contract in place through the RPC.
 *
 * ONE call does all four writes (bump the entry, append the history row,
 * re-point the registry, keep the number) because PostgREST has no
 * multi-statement transaction and this codebase has already paid for that
 * twice — document creation is three independent writes whose failures are all
 * downgraded to warnings.
 *
 * Pass the SAME `clientToken` on a retry: the function returns the revision
 * that already happened instead of burning a second one, which is also what
 * makes a double-tapped Save harmless. Never throws.
 *
 * OPTIMISTIC CONCURRENCY (2026-08-22)
 *
 * `expectedRevision` is the revision number this client RENDERED and archived
 * under — `entry.revision + 1`, computed when Save was pressed. The function
 * compares it with the one it is about to write and raises SQLSTATE 40001 if
 * they differ. Without it, two people revising the same estimate both computed
 * rev 3, both rendered a PDF called `…-r3.pdf` into the same storage path, and
 * the second save silently overwrote the first one's numbers while the archive
 * kept only the second one's bytes — a revision that existed in the history
 * table and nowhere else.
 *
 * REQUIRES the matching migration: PostgREST resolves overloads by argument
 * NAME, so an older `revise_document()` without `p_expected_revision` answers
 * PGRST202 and `REVISE_MIGRATION_MESSAGE` is what the user sees. That is the
 * honest failure — better than dropping the parameter and quietly restoring
 * the race.
 */
export async function reviseDocument(params: {
  entryId: string;
  lineItems: LineItem[];
  amount: number;
  notes?: string | null;
  occurredOn?: string | null;
  description?: string | null;
  documentMeta?: DocumentMeta | null;
  /** Only set when the render succeeded — null leaves the living path alone. */
  documentPath?: string | null;
  archivePath?: string | null;
  pdfState?: 'current' | 'stale';
  fileSize?: number | null;
  clientToken?: string | null;
  /**
   * The revision this save is FOR (`entry.revision + 1`). Omit only where the
   * caller genuinely has no rendered revision to defend.
   */
  expectedRevision?: number | null;
}): Promise<ReviseResult> {
  try {
    const { data, error } = await supabase.rpc('revise_document', {
      p_entry_id: params.entryId,
      p_line_items: params.lineItems,
      p_amount: params.amount,
      p_notes: params.notes ?? null,
      p_occurred_on: params.occurredOn ?? null,
      p_description: params.description ?? null,
      p_document_meta: params.documentMeta ?? {},
      p_document_path: params.documentPath ?? null,
      p_archive_path: params.archivePath ?? null,
      p_pdf_state: params.pdfState ?? 'current',
      p_file_size: params.fileSize ?? null,
      p_client_token: params.clientToken ?? null,
      p_expected_revision: params.expectedRevision ?? null,
    });
    if (error) {
      // FIRST: a stale expectation is not a permissions problem, a missing
      // row or a missing migration, and it must not be retried with the same
      // token — that would just fail the same way.
      if (isRevisionConflict(error)) {
        return { ok: false, code: 'conflict', message: REVISE_CONFLICT_MESSAGE };
      }
      if (error.code === '42501') {
        return { ok: false, message: 'Only owners and operators can revise documents.' };
      }
      if (error.code === 'P0002') {
        return { ok: false, message: 'That document no longer exists.' };
      }
      if (error.code === 'PGRST202' || error.code === '42883') {
        return { ok: false, message: REVISE_MIGRATION_MESSAGE };
      }
      return { ok: false, message: error.message };
    }
    const row = (Array.isArray(data) ? data[0] : data) as
      | { revision?: unknown; entry_id?: unknown }
      | null
      | undefined;
    if (!row || row.revision == null) return { ok: false, message: REVISE_MIGRATION_MESSAGE };
    return {
      ok: true,
      revision: Number(row.revision) || 1,
      entryId: String(row.entry_id ?? params.entryId),
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the revision.' };
  }
}

/**
 * Clear a 'stale' PDF flag after a successful Retry PDF.
 *
 * The revision itself already happened — its history row is written and its
 * `document_path` already names the archive object the retry just uploaded.
 * Nothing about the DOCUMENT changed, only whether its bytes exist, so this
 * deliberately does not go through revise_document(): appending a second,
 * identical revision would make the counter lie about how many times the
 * document was actually revised.
 */
export async function attachRenderedPdf(params: {
  entryId: string;
  jobId: string;
  documentNumber: string;
  documentType: string;
  documentMeta: DocumentMeta;
  storagePath: string;
  sizeBytes: number | null;
}): Promise<MutateEntryResult> {
  try {
    const meta: DocumentMeta = { ...params.documentMeta, pdf_state: 'current' };
    const { data, error } = await supabase
      .from('finance_entries')
      .update({ document_meta: meta, document_path: params.storagePath })
      .eq('company', COMPANY)
      .eq('id', params.entryId)
      .select('id');
    if (error) {
      if (error.code === 'PGRST116' || error.code === '42501') {
        return { ok: false, message: MIGRATION_MESSAGE };
      }
      return { ok: false, message: error.message };
    }
    if (!data || data.length === 0) return { ok: false, message: MIGRATION_MESSAGE };

    await registerJobDocument({
      jobId: params.jobId,
      docType: ['estimate', 'invoice', 'contract'].includes(params.documentType)
        ? params.documentType
        : 'other',
      storagePath: params.storagePath,
      fileName: `${params.documentNumber}.pdf`,
      sizeBytes: params.sizeBytes,
      financeEntryId: params.entryId,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not update the PDF.' };
  }
}

export type DuplicateDocumentResult =
  | { ok: true; entryId: string; documentNumber: string }
  | { ok: false; message: string };

/**
 * Copy an existing document into a NEW one of the given type — the
 * "accepted estimate → invoice" move, which today means retyping every line.
 *
 * The copy gets its own document number, its own finance row and no PDF: the
 * builder opens on it next and renders the first one. Amount and line items
 * come across verbatim, as do notes and document_meta, minus the bookkeeping
 * fields (pdf_state / last_client_token) which belong to the source's save.
 */
export async function duplicateDocument(params: {
  sourceEntryId: string;
  asType: DocumentType;
}): Promise<DuplicateDocumentResult> {
  try {
    const source = await fetchFinanceEntry(params.sourceEntryId);
    if (!source) return { ok: false, message: 'That document could not be loaded.' };
    if (!source.job_id) {
      return { ok: false, message: 'Only documents attached to a job can be duplicated.' };
    }
    const lineItems = source.line_items ?? [];
    if (lineItems.length === 0) {
      return { ok: false, message: 'That document has no line items to copy.' };
    }

    const { data: jobRow } = await supabase
      .from('jobs')
      .select('job_number')
      .eq('id', source.job_id)
      .limit(1);
    const jobNumber =
      ((jobRow ?? [])[0] as { job_number?: string | null } | undefined)?.job_number ??
      source.job_id.slice(0, 8);

    const documentNumber = await nextDocumentNumber(source.job_id, jobNumber, params.asType);
    const typeLabel = params.asType === 'invoice' ? 'Invoice' : 'Estimate';
    const { pdf_state: _ignoredState, last_client_token: _ignoredToken, ...meta } =
      source.document_meta ?? {};

    const inserted = await insertDocumentEntry({
      type: params.asType,
      amount: source.amount,
      counterparty: source.counterparty ?? 'Customer',
      description: `${typeLabel} ${documentNumber}`,
      occurredOn: todayISO(),
      jobId: source.job_id,
      customerId: source.customer_id,
      documentNumber,
      documentPath: null,
      lineItems,
      notes: source.notes,
      documentMeta: { ...meta, pdf_state: 'stale' },
    });
    if (!inserted.ok) return { ok: false, message: inserted.message };
    if (!inserted.id) {
      return { ok: false, message: 'The copy was saved but could not be opened. Reload the job.' };
    }
    return { ok: true, entryId: inserted.id, documentNumber };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not duplicate that document.',
    };
  }
}

/**
 * Set a job's contract value (its "Invoiced" total) directly. Invoice
 * DOCUMENTS are never touched: the function maintains at most one
 * document-less "Contract value" invoice entry per job (matched by that
 * exact description) and sizes it so the job's invoice total equals the
 * target. Lowering below the documents' own total is refused — edit those
 * invoices instead. Admin-only via RLS; delete/update need migration 7.
 */
export type SetContractValueResult =
  | { ok: true; entryId: string | null }
  | { ok: false; message: string };

export async function setJobContractValue(params: {
  jobId: string;
  customerId?: string | null;
  target: number;
}): Promise<SetContractValueResult> {
  try {
    const { data, error } = await supabase
      .from('finance_entries')
      .select('id, amount, description, document_path')
      .eq('company', COMPANY)
      .eq('job_id', params.jobId)
      .eq('type', 'invoice');
    if (error) return { ok: false, message: error.message };

    let othersTotal = 0;
    let adjustment: { id: string } | null = null;
    for (const row of (data ?? []) as {
      id: string;
      amount: unknown;
      description: string | null;
      document_path: string | null;
    }[]) {
      const amount = Number(row.amount) || 0;
      if (!adjustment && row.description === 'Contract value' && row.document_path == null) {
        adjustment = { id: row.id };
      } else {
        othersTotal += amount;
      }
    }

    const needed = params.target - othersTotal;
    if (needed < 0) {
      return {
        ok: false,
        message: `This job's invoice entries already total $${othersTotal.toLocaleString('en-US')}. Edit or delete those entries (on the job's Invoices card) to go lower.`,
      };
    }
    if (adjustment) {
      if (needed === 0) {
        const removed = await deleteFinanceEntry(adjustment.id);
        return removed.ok ? { ok: true, entryId: null } : removed;
      }
      const updated = await updateFinanceEntry(adjustment.id, { amount: needed });
      return updated.ok ? { ok: true, entryId: adjustment.id } : updated;
    }
    if (needed === 0) return { ok: true, entryId: null };

    const { data: inserted, error: insertError } = await supabase
      .from('finance_entries')
      .insert({
        company: COMPANY,
        type: 'invoice',
        direction: 'in',
        amount: needed,
        currency: 'USD',
        counterparty: null,
        description: 'Contract value',
        occurred_on: todayISO(),
        status: 'recorded',
        job_id: params.jobId,
        customer_id: params.customerId ?? null,
      })
      .select('id')
      .single();
    if (insertError || !inserted) {
      return { ok: false, message: insertError?.message ?? 'Could not save the contract value.' };
    }
    return { ok: true, entryId: (inserted as { id: string }).id };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not set the contract value.',
    };
  }
}

export type GenerateContractResult =
  | { ok: true; documentNumber: string; storagePath: string }
  | { ok: false; message: string };

/**
 * Generate the branded Contract PDF for a job at the given contract value,
 * upload it to the contracts bucket (upsert — regenerating after a value
 * change overwrites the same file), and record it once in job_documents.
 * Native only (uses expo-print); callers should attach the returned
 * document number/path to the job's "Contract value" finance entry so it
 * opens from the Invoices card and the ledger. Number is always
 * `<job_number>-Contract` — one living contract document per job.
 */
export async function generateContractPdf(params: {
  job: Job;
  target: number;
}): Promise<GenerateContractResult> {
  const { job } = params;
  try {
    const Print = await import('expo-print');
    const documentNumber = `${job.job_number ?? job.id.slice(0, 8)}-Contract`;
    const html = buildDocumentHtml({
      type: 'contract',
      documentNumber,
      dateISO: todayISO(),
      customerName: job.customer?.name ?? 'Customer',
      customerAddress: job.customer?.address,
      customerEmail: job.customer?.email,
      customerPhone: job.customer?.phone,
      jobNumber: job.job_number,
      jobName: job.name,
      jobAddress: job.address,
      lineItems: [
        {
          name: 'Contract value',
          description:
            'Total agreed value for the scope of work on this project, per the agreement between DC Solar LLC and the customer.',
          qty: 1,
          rate: params.target,
        },
      ],
      notes: 'This document reflects the agreed contract value for the project.',
    });

    const { uri } = await Print.printToFileAsync({ html });
    const response = await fetch(uri);
    const body = await response.arrayBuffer();
    const fileName = `${documentNumber}.pdf`;
    const storagePath = `${job.id}/${fileName}`;

    const { error: uploadError } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .upload(storagePath, body, { contentType: 'application/pdf', upsert: true });
    if (uploadError) return { ok: false, message: uploadError.message };

    // Record in job_documents only once — regeneration reuses the same file.
    const { data: existing } = await supabase
      .from('job_documents')
      .select('id')
      .eq('company', COMPANY)
      .eq('job_id', job.id)
      .eq('storage_path', storagePath)
      .limit(1);
    if (!existing || existing.length === 0) {
      const { data: userData } = await supabase.auth.getUser();
      await supabase.from('job_documents').insert({
        company: COMPANY,
        job_id: job.id,
        doc_type: 'contract',
        storage_path: storagePath,
        file_name: fileName,
        content_type: 'application/pdf',
        size_bytes: body.byteLength,
        uploaded_by: userData?.user?.email ?? null,
      });
    }

    return { ok: true, documentNumber, storagePath };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not generate the contract PDF.',
    };
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
    return { ok: true, id: null };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not record the payment.' };
  }
}

// ---------------------------------------------------------------------------
// Splitting one payment across several jobs (2026-08-05)
// ---------------------------------------------------------------------------

export interface SplitAllocation {
  jobId: string;
  /** Job label, used in the description trail so the split is legible later. */
  label: string;
  amount: number;
}

export type SplitPaymentResult =
  | { ok: true; legs: number; remainder: number }
  | { ok: false; message: string };

/**
 * Split one payment entry across several jobs.
 *
 * A single ACH/direct deposit routinely covers several invoices at once — the
 * 2026-08-05 deposit of $12,110 paid DC-26010, DC-26011 and DC-26012 in one
 * hit. The email scanner can only ever tag such a deposit to one job (or to
 * the company bucket when it matches none), so this lets an admin divide it up
 * afterwards. Amounts are entered by hand precisely because a deposit does not
 * always match an invoice to the penny.
 *
 * Mechanics: each allocation after the first is INSERTed as its own payment,
 * and the ORIGINAL row is kept and reduced to the first allocation (or to the
 * unallocated remainder). Keeping the original id matters — the email
 * scanner's dedup is keyed on its `extracted.gmail_message_id`, so reusing the
 * row means a re-sent bank alert still can't double-log the deposit.
 *
 * Not atomic: Supabase's REST API has no multi-statement transaction. Legs are
 * inserted first and the original is only reduced once they all succeed, so a
 * mid-way failure leaves the money over-counted (visible, fixable) rather than
 * vanished.
 */
export async function splitPayment(
  entryId: string,
  allocations: SplitAllocation[],
): Promise<SplitPaymentResult> {
  const legs = allocations.filter((a) => a.amount > 0 && a.jobId);
  if (legs.length === 0) return { ok: false, message: 'Assign an amount to at least one job.' };

  try {
    const { data: rows, error: readErr } = await supabase
      .from('finance_entries')
      .select('*')
      .eq('id', entryId)
      .limit(1);
    if (readErr) return { ok: false, message: readErr.message };
    const original = (rows ?? [])[0] as Record<string, unknown> | undefined;
    if (!original) return { ok: false, message: 'That payment no longer exists.' };

    const total = Number(original.amount) || 0;
    const allocated = legs.reduce((sum, a) => sum + a.amount, 0);
    // Guard against inventing money. Half a cent of float slop is fine.
    if (allocated - total > 0.005) {
      return {
        ok: false,
        message: `Allocated $${allocated.toFixed(2)} but the payment is only $${total.toFixed(2)}.`,
      };
    }
    const remainder = Math.round((total - allocated) * 100) / 100;

    const baseDescription = String(original.description ?? 'Payment').split(' — split to ')[0];
    const extracted = (original.extracted as Record<string, unknown> | null) ?? {};

    // Everything except the first leg becomes a new row.
    const inserts = legs.slice(1).map((leg) => ({
      company: original.company,
      type: 'payment',
      direction: 'in',
      amount: leg.amount,
      currency: original.currency ?? 'USD',
      counterparty: original.counterparty,
      description: `${baseDescription} — split to ${leg.label}`,
      occurred_on: original.occurred_on,
      status: original.status,
      job_id: leg.jobId,
      extracted: { ...extracted, split_of: entryId, split_leg: leg.label },
    }));
    if (inserts.length > 0) {
      const { error } = await supabase.from('finance_entries').insert(inserts);
      if (error) return { ok: false, message: error.message };
    }

    // Reduce the original to the first leg, or to the leftover when the split
    // doesn't consume the whole deposit.
    const first = legs[0];
    const { error: updErr } = await supabase
      .from('finance_entries')
      .update({
        amount: first.amount,
        job_id: first.jobId,
        description: `${baseDescription} — split to ${first.label}`,
        extracted: { ...extracted, split_of: entryId, split_leg: first.label },
      })
      .eq('id', entryId);
    if (updErr) return { ok: false, message: updErr.message };

    // Anything unallocated stays visible as its own row on the original job.
    if (remainder > 0.005) {
      const { error } = await supabase.from('finance_entries').insert({
        company: original.company,
        type: 'payment',
        direction: 'in',
        amount: remainder,
        currency: original.currency ?? 'USD',
        counterparty: original.counterparty,
        description: `${baseDescription} — unassigned remainder`,
        occurred_on: original.occurred_on,
        status: original.status,
        job_id: original.job_id,
        extracted: { ...extracted, split_of: entryId, split_leg: 'remainder' },
      });
      if (error) return { ok: false, message: error.message };
    }

    return { ok: true, legs: legs.length, remainder };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not split that payment.',
    };
  }
}
