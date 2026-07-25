/**
 * Inventory data layer — materials/items with quantity tracked by a DB
 * trigger on inventory_transactions (never update qty client-side; insert a
 * transaction then refetch). All calls degrade gracefully; RLS enforced.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

export type TransactionReason = 'restock' | 'used_on_job' | 'checkout' | 'return' | 'adjustment';

export interface InventoryItem {
  id: string;
  company: string;
  name: string;
  sku: string | null;
  unit: string;
  qty_on_hand: number;
  min_qty: number | null;
  notes: string | null;
}

export interface InventoryJobOption {
  id: string;
  job_number: string | null;
  name: string;
  status: string;
}

function normalizeItem(row: Record<string, unknown>): InventoryItem {
  return {
    ...(row as unknown as InventoryItem),
    qty_on_hand: Number(row.qty_on_hand) || 0,
    min_qty: row.min_qty != null ? Number(row.min_qty) : null,
  };
}

export type InventoryItemsResult =
  | { status: 'ok'; items: InventoryItem[] }
  | { status: 'unavailable' };

/** Fetch all inventory items, alphabetical. */
export async function fetchInventoryItems(): Promise<InventoryItemsResult> {
  try {
    const { data, error } = await supabase
      .from('inventory_items')
      .select('*')
      .eq('company', COMPANY)
      .order('name', { ascending: true });
    if (error) return { status: 'unavailable' };
    return { status: 'ok', items: (data ?? []).map(normalizeItem) };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Active jobs for the "use on job" picker. Returns [] on any error. */
export async function fetchInventoryJobs(): Promise<InventoryJobOption[]> {
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, job_number, name, status')
      .eq('company', COMPANY)
      .eq('status', 'active')
      .order('job_number', { ascending: true });
    if (error || !data) return [];
    return data as InventoryJobOption[];
  } catch {
    return [];
  }
}

export type InventoryActionResult = { ok: true } | { ok: false; message: string };

/**
 * Record an inventory transaction (positive delta = stock in, negative =
 * stock out). A DB trigger applies the delta to qty_on_hand — callers should
 * refetch items afterwards rather than updating quantities client-side.
 */
export async function addInventoryTransaction(params: {
  itemId: string;
  delta: number;
  reason: TransactionReason;
  jobId?: string | null;
  employee: string;
}): Promise<InventoryActionResult> {
  try {
    const { error } = await supabase.from('inventory_transactions').insert({
      company: COMPANY,
      item_id: params.itemId,
      delta: params.delta,
      reason: params.reason,
      job_id: params.jobId ?? null,
      employee: params.employee,
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the change.' };
  }
}

export type AddItemResult =
  | { ok: true; item: InventoryItem; stockingError: string | null }
  | { ok: false; message: string };

/**
 * Admin: create an inventory item. When startingQty > 0 a follow-up
 * 'restock' transaction sets the opening stock (the trigger applies it); if
 * that second step fails the item still exists and `stockingError` says so.
 */
export async function addInventoryItem(params: {
  name: string;
  sku: string | null;
  unit: string;
  minQty: number | null;
  startingQty: number;
  employee: string;
}): Promise<AddItemResult> {
  try {
    const { data, error } = await supabase
      .from('inventory_items')
      .insert({
        company: COMPANY,
        name: params.name,
        sku: params.sku,
        unit: params.unit,
        qty_on_hand: 0,
        min_qty: params.minQty,
      })
      .select('*')
      .single();
    if (error || !data) {
      return { ok: false, message: error?.message ?? 'Could not add the item.' };
    }
    const item = normalizeItem(data);

    let stockingError: string | null = null;
    if (params.startingQty > 0) {
      const stock = await addInventoryTransaction({
        itemId: item.id,
        delta: params.startingQty,
        reason: 'restock',
        employee: params.employee,
      });
      if (!stock.ok) {
        stockingError = `Item added, but the starting quantity was not recorded: ${stock.message}`;
      }
    }
    return { ok: true, item, stockingError };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not add the item.' };
  }
}
