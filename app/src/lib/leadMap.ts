import { fetchWorkspaceRecords, type WorkspaceRecord } from '@/lib/crmWorkspace';
import { supabase } from '@/lib/supabase';

/**
 * The Lead map's data (2026-10-07). Every lead and customer the caller can
 * already see in the CRM (RLS: a rep sees only theirs), with the coordinates
 * `geocode-addresses` stored. Same "one person, one row" rule as the CRM: a
 * rep works a booked lead (its unpaid customer is hidden from them); an admin
 * sees that customer instead of the lead. Closed-out leads are left off.
 */

export type MapStage = 'prospect' | 'contacted' | 'interested' | 'booked' | 'customer';

export const STAGE_LABEL: Record<MapStage, string> = {
  prospect: 'Prospect',
  contacted: 'Contacted',
  interested: 'Interested',
  booked: 'Visit booked',
  customer: 'Customer',
};

/** Pin colours — readable on the dark map. */
export const STAGE_COLOR: Record<MapStage, string> = {
  prospect: '#8DA9BD',
  contacted: '#E0B25C',
  interested: '#C58AD6',
  booked: '#5FB3A6',
  customer: '#7BC47F',
};
export const STAGE_ORDER: MapStage[] = ['prospect', 'contacted', 'interested', 'booked', 'customer'];

export interface MapPoint {
  key: string;
  name: string;
  stage: MapStage;
  lat: number;
  lng: number;
  /** Placed to the street / ZIP / city, not the building. */
  approx: boolean;
  address: string | null;
  /** Leads only: who it is assigned to (null = the admins' pool). */
  assignedTo: string | null;
}

function stageOf(r: WorkspaceRecord): MapStage | null {
  if (r.kind === 'customer') return 'customer';
  switch (r.lead?.status ?? 'new') {
    case 'new':
      return 'prospect';
    case 'contacted':
      return 'contacted';
    case 'interested':
    case 'estimating':
      return 'interested';
    case 'scheduled':
    case 'visit_done':
      return 'booked';
    default:
      return null; // won (a customer now) / lost
  }
}

export async function fetchMapPoints(isSales: boolean): Promise<{ points: MapPoint[]; unplaced: number }> {
  const { records } = await fetchWorkspaceRecords();
  const visible = records.filter((r) =>
    isSales
      ? !(r.kind === 'customer' && r.serviceStatus === 'unpaid')
      : !(r.kind === 'lead' && (r.lead?.status === 'scheduled' || r.lead?.status === 'visit_done')),
  );
  const points: MapPoint[] = [];
  let unplaced = 0;
  for (const r of visible) {
    const stage = stageOf(r);
    if (!stage) continue;
    const src = r.kind === 'customer' ? r.customer : r.lead;
    const lat = src?.lat;
    const lng = src?.lng;
    if (lat == null || lng == null) {
      if (r.address) unplaced += 1;
      continue;
    }
    points.push({
      key: r.key,
      name: r.name,
      stage,
      lat,
      lng,
      approx: src?.geocode_status === 'approx',
      address: r.address,
      assignedTo: r.kind === 'lead' ? (r.lead?.assigned_to ?? null) : null,
    });
  }
  return { points, unplaced };
}

/**
 * Place any new or edited addresses (the edge function looks up to ~60 per
 * call). Returns how many it placed, so the screen knows to reload.
 */
export async function placeNewAddresses(): Promise<number> {
  try {
    const { data } = await supabase.functions.invoke('geocode-addresses', { body: {} });
    return Number((data as { placed?: number } | null)?.placed ?? 0);
  } catch {
    return 0;
  }
}
