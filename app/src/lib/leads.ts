/**
 * Sales-pipeline leads + their "DC Solar Projection" documents.
 *
 * THE FIREWALL: nothing in this file touches `finance_entries`, jobs, or any
 * financial rollup. A lead has zero financial weight — no estimates, no
 * pipeline money, no P&L. Projections are pre-estimate PDFs that exist only
 * here (`lead_projections`) and in the contracts bucket under the LEAD's id;
 * the customer-facing document registry never lists them. Real money starts
 * only after a lead is converted and a project (job number) exists — from
 * there, the normal estimate flow takes over.
 *
 * Lead reading/status helpers live in `lib/sales.ts` (the Sales tab already
 * used them); this file adds creation, editing, and projections.
 */

import {
  buildDocumentHtml,
  renderDocumentPdf,
  type LineItem,
} from '@/lib/documents';
import type { Lead, LeadStatus } from '@/lib/sales';
import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

export type { Lead, LeadStatus };

export interface LeadInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  source?: string | null;
  estimated_value?: number | null;
  notes?: string | null;
}

export type LeadMutationResult =
  | { ok: true; id: string }
  | { ok: false; message: string };

/** Create a lead from scratch. Admin (or any role RLS allows) only. */
export async function createLead(
  input: LeadInput,
  createdBy: string | null,
): Promise<LeadMutationResult> {
  try {
    const { data, error } = await supabase
      .from('leads')
      .insert({
        company: COMPANY,
        name: input.name.trim(),
        phone: input.phone?.trim() || null,
        email: input.email?.trim() || null,
        address: input.address?.trim() || null,
        source: input.source?.trim() || null,
        estimated_value: input.estimated_value ?? null,
        notes: input.notes?.trim() || null,
        status: 'new',
        created_by: createdBy,
      })
      .select('id')
      .single();
    if (error || !data) return { ok: false, message: error?.message ?? 'Could not save the lead.' };
    return { ok: true, id: data.id as string };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the lead.' };
  }
}

/** Update a lead's contact/details fields. */
export async function updateLead(
  id: string,
  input: Partial<LeadInput>,
): Promise<LeadMutationResult> {
  try {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (input.name !== undefined) patch.name = input.name?.trim();
    if (input.phone !== undefined) patch.phone = input.phone?.trim() || null;
    if (input.email !== undefined) patch.email = input.email?.trim() || null;
    if (input.address !== undefined) patch.address = input.address?.trim() || null;
    if (input.source !== undefined) patch.source = input.source?.trim() || null;
    if (input.estimated_value !== undefined) patch.estimated_value = input.estimated_value;
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
    const { error } = await supabase.from('leads').update(patch).eq('id', id).eq('company', COMPANY);
    if (error) return { ok: false, message: error.message };
    return { ok: true, id };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not update the lead.' };
  }
}

/** One lead by id (RLS scoped). Null when unreadable. */
export async function fetchLeadById(id: string): Promise<Lead | null> {
  try {
    const { data, error } = await supabase
      .from('leads')
      .select(
        'id, created_at, name, phone, email, address, source, status, assigned_to, estimated_value, notes, converted_job_id, lost_reason',
      )
      .eq('company', COMPANY)
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return null;
    const lead = data as unknown as Lead;
    return {
      ...lead,
      estimated_value: lead.estimated_value === null ? null : Number(lead.estimated_value),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

export interface Projection {
  id: string;
  created_at: string;
  lead_id: string;
  number: string;
  line_items: LineItem[];
  total: number;
  notes: string | null;
  document_path: string | null;
}

export async function fetchProjections(leadId: string): Promise<Projection[]> {
  try {
    const { data, error } = await supabase
      .from('lead_projections')
      .select('id, created_at, lead_id, number, line_items, total, notes, document_path')
      .eq('company', COMPANY)
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false });
    if (error || !data) return [];
    return (data as Record<string, unknown>[]).map((row) => ({
      ...(row as unknown as Projection),
      total: Number(row.total) || 0,
      line_items: (row.line_items as LineItem[]) ?? [],
    }));
  } catch {
    return [];
  }
}

/** DC-P-26001 style: year prefix + 3-digit sequence, collision-retried. */
async function nextProjectionNumber(): Promise<string> {
  const year = new Date().getFullYear().toString().slice(2);
  const { count } = await supabase
    .from('lead_projections')
    .select('id', { count: 'exact', head: true })
    .eq('company', COMPANY);
  return `DC-P-${year}${String((count ?? 0) + 1).padStart(3, '0')}`;
}

export type ProjectionResult =
  | { ok: true; projection: Projection; warning?: string }
  | { ok: false; message: string };

/**
 * Create a projection for a lead and render its PDF.
 *
 * The row saves FIRST; a PDF failure downgrades to a warning so nothing is
 * lost (`regenerateProjectionPdf` retries just the render). The PDF goes to
 * the contracts bucket under the LEAD's id — admin-only, never in the
 * customer document registry, never in finance_entries.
 */
export async function createProjection(params: {
  lead: Lead;
  lineItems: LineItem[];
  notes: string | null;
  createdBy: string | null;
}): Promise<ProjectionResult> {
  const { lead, lineItems, notes, createdBy } = params;
  const total = lineItems.reduce((sum, item) => sum + item.qty * item.rate, 0);
  try {
    let inserted: Projection | null = null;
    let lastError = 'Could not save the projection.';
    // The sequence number races only against ourselves; two retries is plenty.
    for (let attempt = 0; attempt < 3 && !inserted; attempt += 1) {
      const number = await nextProjectionNumber();
      const { data, error } = await supabase
        .from('lead_projections')
        .insert({
          company: COMPANY,
          lead_id: lead.id,
          number,
          line_items: lineItems,
          total,
          notes,
          created_by: createdBy,
        })
        .select('id, created_at, lead_id, number, line_items, total, notes, document_path')
        .single();
      if (data) {
        inserted = {
          ...(data as unknown as Projection),
          total: Number((data as { total: unknown }).total) || 0,
        };
      } else {
        lastError = error?.message ?? lastError;
        if (error?.code !== '23505') break; // only retry duplicate numbers
      }
    }
    if (!inserted) return { ok: false, message: lastError };

    const pdf = await regenerateProjectionPdf(inserted, lead);
    if (!pdf.ok) {
      return {
        ok: true,
        projection: inserted,
        warning: `${inserted.number} saved, but the PDF could not be rendered: ${pdf.message}`,
      };
    }
    return { ok: true, projection: { ...inserted, document_path: pdf.path } };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the projection.' };
  }
}

/** Render (or re-render) a projection's PDF and stamp document_path. */
export async function regenerateProjectionPdf(
  projection: Projection,
  lead: Lead,
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  try {
    const html = buildDocumentHtml({
      type: 'projection',
      documentNumber: projection.number,
      dateISO: projection.created_at.slice(0, 10),
      customerName: lead.name,
      customerAddress: lead.address,
      customerEmail: lead.email,
      customerPhone: lead.phone,
      lineItems: projection.line_items,
      notes:
        (projection.notes ? `${projection.notes}\n\n` : '') +
        'This is a projection — a planning figure, not an estimate or a contract. ' +
        'Final pricing is set in a formal DC Solar KC estimate.',
    });
    const rendered = await renderDocumentPdf({
      html,
      entryId: projection.id,
      // The renderer only uses this as the storage folder; for a projection
      // that folder is the LEAD, which keeps it out of every job's documents.
      jobId: projection.lead_id,
      documentNumber: projection.number,
      revision: 1,
    });
    if (!rendered.ok) return { ok: false, message: rendered.message };
    const { error } = await supabase
      .from('lead_projections')
      .update({ document_path: rendered.storagePath, updated_at: new Date().toISOString() })
      .eq('id', projection.id);
    if (error) return { ok: false, message: error.message };
    return { ok: true, path: rendered.storagePath };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not render the PDF.' };
  }
}

/** Delete a projection and its stored PDF (both admin-only under RLS). */
export async function deleteProjection(
  projection: Projection,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    if (projection.document_path) {
      // Best-effort: a stale object is invisible anyway (admin-only bucket).
      await supabase.storage
        .from('contracts')
        .remove([
          projection.document_path,
          `${projection.lead_id}/revisions/${projection.number}-r1.pdf`,
        ]);
    }
    const { error } = await supabase.from('lead_projections').delete().eq('id', projection.id);
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not delete it.' };
  }
}
