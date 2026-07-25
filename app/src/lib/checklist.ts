/**
 * Truck/van tool checklist data layer — vehicles, per-vehicle checklist
 * items, and daily checklist runs. All calls degrade gracefully; RLS
 * enforced (members run checks; admins manage the item list).
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

export interface Vehicle {
  id: string;
  company: string;
  name: string;
  kind: 'truck' | 'van' | 'other';
}

export interface ChecklistItem {
  id: string;
  company: string;
  vehicle_id: string;
  name: string;
  sort_order: number;
  active: boolean;
}

export interface ChecklistRun {
  id: string;
  created_at: string;
  company: string;
  vehicle_id: string;
  employee: string;
  run_date: string;
  results: Record<string, boolean>;
  missing_count: number;
  note: string | null;
}

/** Fetch the company's vehicles. Returns [] on any error. */
export async function fetchVehicles(): Promise<Vehicle[]> {
  try {
    const { data, error } = await supabase
      .from('vehicles')
      .select('id, company, name, kind')
      .eq('company', COMPANY)
      .order('name', { ascending: true });
    if (error || !data) return [];
    return data as Vehicle[];
  } catch {
    return [];
  }
}

export type ChecklistItemsResult =
  | { status: 'ok'; items: ChecklistItem[] }
  | { status: 'unavailable' };

/** Fetch a vehicle's active checklist items in sort order. */
export async function fetchChecklistItems(vehicleId: string): Promise<ChecklistItemsResult> {
  try {
    const { data, error } = await supabase
      .from('tool_checklist_items')
      .select('*')
      .eq('company', COMPANY)
      .eq('vehicle_id', vehicleId)
      .eq('active', true)
      .order('sort_order', { ascending: true });
    if (error) return { status: 'unavailable' };
    return { status: 'ok', items: (data ?? []) as ChecklistItem[] };
  } catch {
    return { status: 'unavailable' };
  }
}

export type AddChecklistItemResult =
  | { ok: true; item: ChecklistItem }
  | { ok: false; message: string };

/** Admin: add a checklist item at the given sort position. */
export async function addChecklistItem(params: {
  vehicleId: string;
  name: string;
  sortOrder: number;
}): Promise<AddChecklistItemResult> {
  try {
    const { data, error } = await supabase
      .from('tool_checklist_items')
      .insert({
        company: COMPANY,
        vehicle_id: params.vehicleId,
        name: params.name,
        sort_order: params.sortOrder,
        active: true,
      })
      .select('*')
      .single();
    if (error || !data) {
      return { ok: false, message: error?.message ?? 'Could not add the item.' };
    }
    return { ok: true, item: data as ChecklistItem };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not add the item.' };
  }
}

/** Admin: soft-remove a checklist item (active = false). */
export async function deactivateChecklistItem(itemId: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('tool_checklist_items')
      .update({ active: false })
      .eq('id', itemId);
    return !error;
  } catch {
    return false;
  }
}

export type SubmitRunResult = { ok: true; run: ChecklistRun } | { ok: false; message: string };

/** Record a completed vehicle check for today. */
export async function submitChecklistRun(params: {
  vehicleId: string;
  employee: string;
  runDate: string; // YYYY-MM-DD
  results: Record<string, boolean>;
  missingCount: number;
  note: string | null;
}): Promise<SubmitRunResult> {
  try {
    const { data, error } = await supabase
      .from('checklist_runs')
      .insert({
        company: COMPANY,
        vehicle_id: params.vehicleId,
        employee: params.employee,
        run_date: params.runDate,
        results: params.results,
        missing_count: params.missingCount,
        note: params.note,
      })
      .select('*')
      .single();
    if (error || !data) {
      return { ok: false, message: error?.message ?? 'Could not save the check.' };
    }
    return { ok: true, run: data as ChecklistRun };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the check.' };
  }
}

/** Recent checks for a vehicle, newest first (default: last 5). */
export async function fetchRecentRuns(vehicleId: string, limit = 5): Promise<ChecklistRun[]> {
  try {
    const { data, error } = await supabase
      .from('checklist_runs')
      .select('*')
      .eq('company', COMPANY)
      .eq('vehicle_id', vehicleId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data as ChecklistRun[];
  } catch {
    return [];
  }
}
