/**
 * Job materials — the itemized list of parts/components a job needs.
 * Rows come from manual entry or from the extract-materials edge function,
 * which reads an uploaded supplier PDF and returns candidate {name, qty}
 * line items (no pricing). Crew can read (RLS); admins write.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

export interface MaterialRow {
  id: string;
  job_id: string;
  name: string;
  qty: number;
  source_document_id: string | null;
  created_at: string;
}

export type MaterialsResult =
  | { status: 'ok'; materials: MaterialRow[] }
  | { status: 'unavailable' };

/** A job's materials, oldest first (list order). */
export async function fetchJobMaterials(jobId: string): Promise<MaterialsResult> {
  try {
    const { data, error } = await supabase
      .from('job_materials')
      .select('id, job_id, name, qty, source_document_id, created_at')
      .eq('company', COMPANY)
      .eq('job_id', jobId)
      .order('created_at', { ascending: true });
    if (error) return { status: 'unavailable' };
    const materials = ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      ...row,
      qty: Number(row.qty) || 0,
    })) as MaterialRow[];
    return { status: 'ok', materials };
  } catch {
    return { status: 'unavailable' };
  }
}

export type MutateResult = { ok: true } | { ok: false; message: string };

/** Insert one or more materials rows (admin-only per RLS). */
export async function addMaterials(params: {
  jobId: string;
  items: { name: string; qty: number }[];
  sourceDocumentId?: string | null;
}): Promise<MutateResult> {
  try {
    const { data: userData } = await supabase.auth.getUser();
    const addedBy = userData?.user?.email ?? null;
    const rows = params.items.map((item) => ({
      company: COMPANY,
      job_id: params.jobId,
      name: item.name,
      qty: item.qty,
      source_document_id: params.sourceDocumentId ?? null,
      added_by: addedBy,
    }));
    const { error } = await supabase.from('job_materials').insert(rows);
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save materials.' };
  }
}

/** Update a material row's name/qty (admin-only per RLS). */
export async function updateMaterial(
  id: string,
  fields: { name?: string; qty?: number },
): Promise<MutateResult> {
  try {
    const { data, error } = await supabase
      .from('job_materials')
      .update(fields)
      .eq('company', COMPANY)
      .eq('id', id)
      .select('id');
    if (error) return { ok: false, message: error.message };
    if (!data || data.length === 0) return { ok: false, message: 'Could not update the item.' };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not update the item.' };
  }
}

/** Delete a material row (admin-only per RLS). */
export async function deleteMaterial(id: string): Promise<MutateResult> {
  try {
    const { error } = await supabase
      .from('job_materials')
      .delete()
      .eq('company', COMPANY)
      .eq('id', id);
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not delete the item.' };
  }
}

/** One candidate line item extracted from a materials PDF. */
export interface ExtractedItem {
  name: string;
  qty: number;
}

export type ExtractResult =
  | { ok: true; items: ExtractedItem[] }
  | { ok: false; message: string };

/**
 * Ask the extract-materials edge function to pull {name, qty} line items
 * out of an uploaded materials PDF. Heuristic — the caller shows the
 * results for review before saving. Requires a signed-in admin.
 */
export async function extractMaterialsFromPdf(storagePath: string): Promise<ExtractResult> {
  try {
    const { data, error } = await supabase.functions.invoke('extract-materials', {
      body: { storagePath },
    });
    if (error) {
      return { ok: false, message: error.message ?? 'Extraction failed.' };
    }
    const items = (data as { items?: unknown })?.items;
    if (!Array.isArray(items)) return { ok: false, message: 'Extraction returned no items.' };
    const cleaned = (items as Record<string, unknown>[])
      .map((item) => ({ name: String(item.name ?? '').trim(), qty: Number(item.qty) || 1 }))
      .filter((item) => item.name.length > 0);
    return { ok: true, items: cleaned };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Extraction failed.' };
  }
}
