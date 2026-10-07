import { Platform } from 'react-native';

import { type WorkspaceRecord } from '@/lib/crmWorkspace';
import { type LeadTemperature } from '@/lib/leadTemperature';
import { taskBucket, type Task } from '@/lib/tasks';

/**
 * CRM list filters + sort (2026-10-07) — the "Filter & sort" panel in the
 * workspace list, for reps and admins. Everything works on the records the
 * list already loaded (RLS-scoped), so filtering is instant and needs no new
 * reads.
 *
 *   ZIP            one or several, from the ZIPs in the caller's own records
 *   Stage          Prospect · Contacted · Interested · Visit booked ·
 *                  Customer · Not interested (several at once)
 *   Temperature    Hot · Warm · Cold (2026-10-08)
 *   Contact        never contacted · no contact in 7+ days · follow-up
 *                  overdue · call first (no text consent)
 *   Source         the lead's source / import batch ("KC Commercial Solar …")
 *   Installer      the original solar company, once imported
 *   Rep            admins only: who a lead is assigned to
 *   Has            phone · email
 *   Sort           recent activity (default) · newest · oldest · name · ZIP ·
 *                  longest since contact
 *
 * The ZIP is read from the end of the address text. Filters are remembered
 * per browser (web) and for the app session (phone).
 */

export type Stage = 'prospect' | 'contacted' | 'interested' | 'booked' | 'customer' | 'closed';
export type ContactFilter = 'never' | 'stale' | 'overdue' | 'call_first';
export type SortKey = 'activity' | 'newest' | 'oldest' | 'name' | 'zip' | 'stale';
export type HasFilter = 'phone' | 'email';

export interface CrmFilters {
  zips: string[];
  stages: Stage[];
  contact: ContactFilter[];
  sources: string[];
  installers: string[];
  reps: string[];
  has: HasFilter[];
  temps: LeadTemperature[];
  sort: SortKey;
}

export const EMPTY_FILTERS: CrmFilters = {
  zips: [],
  stages: [],
  contact: [],
  sources: [],
  installers: [],
  reps: [],
  has: [],
  temps: [],
  sort: 'activity',
};

export const STAGE_LABEL: Record<Stage, string> = {
  prospect: 'Prospect',
  contacted: 'Contacted',
  interested: 'Interested',
  booked: 'Visit booked',
  customer: 'Customer',
  closed: 'Not interested',
};
export const STAGE_ORDER: Stage[] = ['prospect', 'contacted', 'closed', 'interested', 'booked', 'customer'];

export const CONTACT_LABEL: Record<ContactFilter, string> = {
  never: 'Never contacted',
  stale: 'No contact in 7+ days',
  overdue: 'Follow-up overdue',
  call_first: 'Call first',
};
export const CONTACT_ORDER: ContactFilter[] = ['never', 'stale', 'overdue', 'call_first'];

export const SORT_LABEL: Record<SortKey, string> = {
  activity: 'Recent activity',
  newest: 'Newest',
  oldest: 'Oldest',
  name: 'Name A–Z',
  zip: 'ZIP',
  stale: 'Longest since contact',
};
export const SORT_ORDER: SortKey[] = ['activity', 'newest', 'oldest', 'name', 'zip', 'stale'];

export const HAS_LABEL: Record<HasFilter, string> = { phone: 'Has phone', email: 'Has email' };

const STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The ZIP at the END of the address — "…, Kansas City, MO 64106" → "64106".
 * Only the end counts: 14 of the imported addresses START with a 5-digit house
 * number ("12345 State Line Rd"), which is not a ZIP. No ZIP at the end → null.
 */
export function zipOf(r: WorkspaceRecord): string | null {
  const a = (r.address ?? '').trim();
  const m = /[\s,](\d{5})(?:-\d{4})?$/.exec(a);
  return m ? m[1] : null;
}

export function stageOf(r: WorkspaceRecord): Stage {
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
    case 'won':
      return 'customer';
    default:
      return 'closed';
  }
}

function createdAt(r: WorkspaceRecord): string {
  return r.lead?.created_at ?? (r.customer as { created_at?: string } | null)?.created_at ?? '';
}

function sourceOf(r: WorkspaceRecord): string | null {
  return r.lead?.source?.trim() || null;
}

export function activeCount(f: CrmFilters): number {
  return (
    f.zips.length + f.stages.length + f.contact.length + f.sources.length + f.installers.length + f.reps.length + f.has.length +
    (f.temps?.length ?? 0)
  );
}

/** What the panel offers: only values that occur in these records, with counts. */
export function filterOptions(records: WorkspaceRecord[]): {
  zips: { value: string; count: number }[];
  sources: { value: string; count: number }[];
  installers: { value: string; count: number }[];
} {
  const tally = (values: (string | null | undefined)[]) => {
    const m = new Map<string, number>();
    for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
    return [...m.entries()].map(([value, count]) => ({ value, count }));
  };
  return {
    zips: tally(records.map(zipOf)).sort((a, b) => a.value.localeCompare(b.value)),
    sources: tally(records.map(sourceOf)).sort((a, b) => b.count - a.count),
    installers: tally(records.map((r) => r.lead?.installer?.trim())).sort((a, b) => b.count - a.count),
  };
}

export function applyFilters(records: WorkspaceRecord[], f: CrmFilters, tasks: Task[], now = Date.now()): WorkspaceRecord[] {
  const overdueKeys = new Set<string>();
  if (f.contact.includes('overdue')) {
    for (const t of tasks) {
      if (taskBucket(t) !== 'overdue') continue;
      if (t.lead_id) overdueKeys.add(`lead:${t.lead_id}`);
      if (t.customer_id) overdueKeys.add(`customer:${t.customer_id}`);
    }
  }
  const out = records.filter((r) => {
    if (f.zips.length && !f.zips.includes(zipOf(r) ?? '')) return false;
    if (f.stages.length && !f.stages.includes(stageOf(r))) return false;
    if (f.sources.length && !f.sources.includes(sourceOf(r) ?? '')) return false;
    if (f.installers.length && !f.installers.includes(r.lead?.installer?.trim() ?? '')) return false;
    if (f.reps.length) {
      const rep = r.lead?.assigned_to?.toLowerCase() ?? '';
      if (!f.reps.includes(rep)) return false;
    }
    if (f.temps?.length && !(r.lead?.temperature && f.temps.includes(r.lead.temperature))) return false;
    if (f.has.includes('phone') && !r.phoneE164 && !r.phone) return false;
    if (f.has.includes('email') && !r.email) return false;
    // Contact filters: a record must match EVERY one ticked.
    for (const c of f.contact) {
      if (c === 'never' && !(r.kind === 'lead' && (r.lead?.status ?? 'new') === 'new')) return false;
      if (c === 'stale') {
        const last = r.lastActivityAt ? new Date(r.lastActivityAt).getTime() : 0;
        if (now - last < STALE_MS) return false;
      }
      if (c === 'overdue' && !overdueKeys.has(r.key)) return false;
      if (c === 'call_first' && !r.lead?.call_first) return false;
    }
    return true;
  });

  const byName = (a: WorkspaceRecord, b: WorkspaceRecord) => a.name.localeCompare(b.name);
  switch (f.sort) {
    case 'newest':
      return out.sort((a, b) => createdAt(b).localeCompare(createdAt(a)));
    case 'oldest':
      return out.sort((a, b) => createdAt(a).localeCompare(createdAt(b)));
    case 'name':
      return out.sort(byName);
    case 'zip':
      return out.sort((a, b) => (zipOf(a) ?? '99999').localeCompare(zipOf(b) ?? '99999') || byName(a, b));
    case 'stale':
      return out.sort((a, b) => (a.lastActivityAt ?? '').localeCompare(b.lastActivityAt ?? ''));
    default:
      return out; // already newest activity first
  }
}

// ---------------------------------------------------------------------------
// Remembering the choice
// ---------------------------------------------------------------------------

const STORE_KEY = 'dcsolar.crm.filters';
let memory: CrmFilters | null = null;

export function loadFilters(): CrmFilters {
  if (memory) return memory;
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) memory = { ...EMPTY_FILTERS, ...(JSON.parse(raw) as Partial<CrmFilters>) };
    }
  } catch {
    // Unreadable or blocked storage: start clean.
  }
  return memory ?? EMPTY_FILTERS;
}

export function saveFilters(f: CrmFilters): void {
  memory = f;
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(f));
  } catch {
    // Private mode / quota: remembered for this session only.
  }
}
