/**
 * Sales funnel: leads, per-rep attribution, and conversion rates.
 *
 * The funnel is Lead → Estimate → Contract → Job. "Contracted" is its own
 * finance entry type because the signed amount is a different number from the
 * quote: a job estimated at $12,000 and signed at $11,000 has an estimate of
 * $12,000 and a contract of $11,000, and without both, estimate→contract
 * conversion cannot be measured.
 *
 * VISIBILITY. Every query here relies on RLS rather than filtering in the UI,
 * because a UI filter is not a security control. Admins (owner/operator —
 * Devon, Isaiah, Clark) read everything. A viewer reads only leads assigned to
 * them, and only the estimate and contract rows on jobs where they are the
 * sales rep; payments, expenses and investments stay admin-only. Passing
 * `repEmail` narrows what an admin is *looking at*; it is not what keeps a rep
 * out of anyone else's numbers.
 */

import { supabase } from '@/lib/supabase';
import { type LeadTemperature } from '@/lib/leadTemperature';
import { type Job } from '@/lib/types';

const COMPANY = 'dc-solar';

/**
 * 2026-10-05: `interested` is the sales rep's step before booking; `scheduled`
 * and `visit_done` are set ONLY by the service-visit functions (book /
 * cancel / done in 2026-10-05_service_visits.sql), never by a status tap.
 */
export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'interested'
  | 'scheduled'
  | 'visit_done'
  | 'estimating'
  | 'won'
  | 'lost';

/** Statuses a person can tap a lead into; the rest follow its service visit. */
export const VISIT_DRIVEN_STATUSES: readonly LeadStatus[] = ['scheduled', 'visit_done'];

export interface Lead {
  id: string;
  created_at: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  source: string | null;
  status: LeadStatus;
  assigned_to: string | null;
  estimated_value: number | null;
  notes: string | null;
  converted_job_id: string | null;
  lost_reason: string | null;
  /** Automatic intake provenance, e.g. `website_quote:<id>`; null when typed in by hand. */
  source_ref?: string | null;
  /** Affirmative SMS opt-in evidence carried from the source (Phase 9). Null = none recorded. */
  sms_opt_in_at?: string | null;
  sms_opt_in_source?: string | null;
  /** Imported without text consent: texting refused until a connected call or an inbound text (2026-10-07). */
  call_first?: boolean;
  /** The import batch (its source tag) this lead came from. */
  import_batch?: string | null;
  /** Map position from the address (geocode-addresses, 2026-10-07); 'approx' = street/ZIP/city level. */
  lat?: number | null;
  lng?: number | null;
  geocode_status?: string | null;
  /** The company that originally installed the solar here (imported, 2026-10-07). */
  installer?: string | null;
  /** Hot / Warm / Cold, set by the rep (2026-10-08). */
  temperature?: LeadTemperature | null;
  /** Who added it (an import: the importer). A rep may remove leads they added by hand. */
  created_by?: string | null;
  /** Most recent hail ≥ 1 in within 3 mi (storm coverage, 2026-10-09). */
  last_hail_at?: string | null;
  last_hail_size?: number | null;
  last_hail_miles?: number | null;
}

export interface SalesRep {
  email: string;
  displayName: string;
}

/** One row of the funnel, for a rep or for the whole company. */
export interface SalesFunnel {
  leads: number;
  leadsWon: number;
  leadsLost: number;
  /** Jobs with at least one estimate. */
  projectsEstimated: number;
  /** Jobs with a signed contract entry. */
  projectsContracted: number;
  estimatedValue: number;
  contractedValue: number;
  /** projectsContracted ÷ projectsEstimated. Null when nothing was estimated. */
  estimateToContractPct: number | null;
  /** projectsEstimated ÷ leads. Null until leads exist. */
  leadToEstimatePct: number | null;
  /** leadsWon ÷ leads. Null until leads exist. */
  leadWinPct: number | null;
}

export interface SalesData {
  leads: Lead[];
  reps: SalesRep[];
  /** Company-wide when admin; the caller's own slice otherwise. */
  overall: SalesFunnel;
  /** Per-rep breakdown. Empty for a non-admin — they only have themselves. */
  byRep: Array<{ rep: SalesRep; funnel: SalesFunnel }>;
}

function pct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return (numerator / denominator) * 100;
}

function emptyFunnel(): SalesFunnel {
  return {
    leads: 0,
    leadsWon: 0,
    leadsLost: 0,
    projectsEstimated: 0,
    projectsContracted: 0,
    estimatedValue: 0,
    contractedValue: 0,
    estimateToContractPct: null,
    leadToEstimatePct: null,
    leadWinPct: null,
  };
}

function finalize(f: SalesFunnel): SalesFunnel {
  return {
    ...f,
    estimateToContractPct: pct(f.projectsContracted, f.projectsEstimated),
    leadToEstimatePct: pct(f.projectsEstimated, f.leads),
    leadWinPct: pct(f.leadsWon, f.leads),
  };
}

const sameEmail = (a: string | null, b: string | null) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Build the sales picture from whatever the signed-in user is allowed to read.
 * Returns null only when the queries fail outright; an empty funnel is a valid
 * answer for a rep with nothing assigned yet.
 */
export async function fetchSalesData(): Promise<SalesData | null> {
  try {
    const [leadsRes, jobsRes, finRes, empRes] = await Promise.all([
      supabase
        .from('leads')
        .select(
          'id, created_at, name, phone, email, address, source, status, assigned_to, estimated_value, notes, converted_job_id, lost_reason, source_ref, sms_opt_in_at, sms_opt_in_source, call_first, import_batch, lat, lng, geocode_status, installer, temperature, created_by, last_hail_at, last_hail_size, last_hail_miles',
        )
        .eq('company', COMPANY)
        .is('removed_at', null)
        .order('created_at', { ascending: false }),
      supabase
        .from('jobs')
        .select('id, job_number, name, sales_rep_email, is_internal')
        .eq('company', COMPANY),
      // RLS decides which of these come back. An admin gets all of them; a rep
      // gets the estimate and contract rows on their own jobs and nothing else.
      supabase
        .from('finance_entries')
        .select('id, type, amount, job_id, occurred_on, created_at')
        .eq('company', COMPANY)
        .neq('status', 'void')
        .in('type', ['estimate', 'contract']),
      supabase
        .from('employees')
        .select('email, display_name')
        .eq('company', COMPANY)
        .eq('is_test', false),
    ]);

    if (jobsRes.error) return null;

    const leads = ((leadsRes.data ?? []) as unknown as Lead[]).map((l) => ({
      ...l,
      estimated_value: l.estimated_value != null ? Number(l.estimated_value) : null,
    }));

    const jobs = (jobsRes.data ?? []) as unknown as Array<
      Pick<Job, 'id' | 'job_number' | 'name'> & {
        sales_rep_email: string | null;
        is_internal: boolean | null;
      }
    >;

    const finRows = ((finRes.data ?? []) as unknown as Array<{
      type: 'estimate' | 'contract';
      amount: number | string;
      job_id: string | null;
      occurred_on: string | null;
      created_at: string | null;
    }>).map((r) => ({ ...r, amount: Number(r.amount) || 0 }));

    const reps: SalesRep[] = ((empRes.data ?? []) as Array<{
      email: string;
      display_name: string | null;
    }>).map((e) => ({ email: e.email, displayName: e.display_name ?? e.email }));

    // Latest estimate and latest contract PER JOB. A job re-quoted three times
    // is one estimated project, not three, and its value is the current number
    // — counting every revision would inflate both the count and the money.
    const newest = (
      a: { occurred_on: string | null; created_at: string | null },
      b: { occurred_on: string | null; created_at: string | null },
    ) =>
      `${a.occurred_on ?? ''}~${a.created_at ?? ''}` >
      `${b.occurred_on ?? ''}~${b.created_at ?? ''}`;

    const latestEstimate = new Map<string, number>();
    const latestContract = new Map<string, number>();
    const estStamp = new Map<string, { occurred_on: string | null; created_at: string | null }>();
    const conStamp = new Map<string, { occurred_on: string | null; created_at: string | null }>();

    for (const row of finRows) {
      if (!row.job_id) continue;
      const [values, stamps] =
        row.type === 'estimate'
          ? ([latestEstimate, estStamp] as const)
          : ([latestContract, conStamp] as const);
      const prev = stamps.get(row.job_id);
      if (!prev || newest(row, prev)) {
        values.set(row.job_id, row.amount);
        stamps.set(row.job_id, { occurred_on: row.occurred_on, created_at: row.created_at });
      }
    }

    const projects = jobs.filter((j) => j.is_internal !== true);

    const build = (repEmail: string | null): SalesFunnel => {
      const f = emptyFunnel();
      const mine = repEmail
        ? projects.filter((j) => sameEmail(j.sales_rep_email, repEmail))
        : projects;
      for (const job of mine) {
        const est = latestEstimate.get(job.id);
        const con = latestContract.get(job.id);
        if (est !== undefined) {
          f.projectsEstimated += 1;
          f.estimatedValue += est;
        }
        if (con !== undefined) {
          f.projectsContracted += 1;
          f.contractedValue += con;
        }
      }
      const myLeads = repEmail
        ? leads.filter((l) => sameEmail(l.assigned_to, repEmail))
        : leads;
      f.leads = myLeads.length;
      f.leadsWon = myLeads.filter((l) => l.status === 'won').length;
      f.leadsLost = myLeads.filter((l) => l.status === 'lost').length;
      return finalize(f);
    };

    // Only reps who actually have something attributed get a row — an empty
    // leaderboard entry for every employee is noise.
    const activeRepEmails = new Set<string>();
    for (const job of projects) {
      if (job.sales_rep_email) activeRepEmails.add(job.sales_rep_email.toLowerCase());
    }
    for (const lead of leads) {
      if (lead.assigned_to) activeRepEmails.add(lead.assigned_to.toLowerCase());
    }

    const byRep = Array.from(activeRepEmails)
      .map((email) => {
        const rep =
          reps.find((r) => r.email.toLowerCase() === email) ??
          ({ email, displayName: email } as SalesRep);
        return { rep, funnel: build(email) };
      })
      .sort((a, b) => b.funnel.contractedValue - a.funnel.contractedValue);

    return { leads, reps, overall: build(null), byRep };
  } catch {
    return null;
  }
}

/**
 * Leads that have not become a job yet, newest first — the CRM list's Leads
 * section. Empty array on any error: RLS narrows this to a rep's own leads,
 * and "no leads" is a perfectly good answer for a screen.
 *
 * Deliberately not filtered by `status`: a lead marked `lost` that nobody
 * converted still belongs in front of Devon, and its status chip says so.
 *
 * Booked leads (2026-10-05) stay too: a lead with a service visit has a
 * `converted_job_id` but is not a customer until the visit is paid, so
 * `scheduled` / `visit_done` leads are included. The CRM decides who sees the
 * lead and who sees the customer record behind it (`CrmWorkspace`).
 */
export async function fetchOpenLeads(): Promise<Lead[]> {
  try {
    const { data, error } = await supabase
      .from('leads')
      .select(
        'id, created_at, name, phone, email, address, source, status, assigned_to, estimated_value, notes, converted_job_id, lost_reason, source_ref, sms_opt_in_at, sms_opt_in_source, call_first, import_batch, lat, lng, geocode_status, installer, temperature, created_by, last_hail_at, last_hail_size, last_hail_miles',
      )
      .eq('company', COMPANY)
      .is('removed_at', null)
      .or('converted_job_id.is.null,status.in.(scheduled,visit_done)')
      .order('created_at', { ascending: false });
    if (error || !data) return [];
    return (data as unknown as Lead[]).map((l) => ({
      ...l,
      estimated_value: l.estimated_value != null ? Number(l.estimated_value) : null,
    }));
  } catch {
    return [];
  }
}

/**
 * The sales team — reps and sales managers, names + emails (2026-10-07), from
 * `sales_team()`; employees itself is admin-read only. For owner chips and the
 * manager's assign picker.
 */
export async function fetchSalesTeam(): Promise<{ email: string; name: string; role: string }[]> {
  try {
    const { data, error } = await supabase.rpc('sales_team');
    if (error || !data) return [];
    return (data as { email: string; display_name: string; role: string }[]).map((r) => ({
      email: r.email,
      name: r.display_name,
      role: r.role,
    }));
  } catch {
    return [];
  }
}

/** Assign or reassign a lead's rep. Admins and sales managers; RLS rejects anyone else. */
export async function assignLead(
  leadId: string,
  repEmail: string | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await supabase
    .from('leads')
    .update({ assigned_to: repEmail })
    .eq('id', leadId);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

/**
 * Move a lead along the funnel. A rep may do this on their own leads.
 * `lostReason` is written only with `status: 'lost'` ("Not interested" since
 * 2026-10-08 — one tap, so it is no longer asked); omit it to leave the
 * column alone.
 */
/** Hot / Warm / Cold, or null to clear (2026-10-08). A rep may on their own leads. */
export async function setLeadTemperature(
  leadId: string,
  temperature: LeadTemperature | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await supabase.from('leads').update({ temperature }).eq('id', leadId);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

export async function setLeadStatus(
  leadId: string,
  status: LeadStatus,
  lostReason?: string | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const patch: { status: LeadStatus; lost_reason?: string | null } = { status };
  if (status === 'lost' && lostReason !== undefined) patch.lost_reason = lostReason?.trim() || null;
  const { error } = await supabase.from('leads').update(patch).eq('id', leadId);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Removing leads (2026-10-08) — 2026-10-08_remove_leads.sql
// ---------------------------------------------------------------------------

/**
 * Remove (hide) leads. Admins and the sales manager: any; a rep: leads they
 * added by hand. Leads with a booked visit are skipped.
 */
export async function removeLeads(
  ids: string[],
): Promise<{ ok: true; removed: number; booked: number; notAllowed: number } | { ok: false; message: string }> {
  try {
    const { data, error } = await supabase.rpc('remove_leads', { p_ids: ids });
    if (error) return { ok: false, message: error.message };
    const r = (data ?? {}) as { removed?: number; booked?: number; not_allowed?: number };
    return { ok: true, removed: Number(r.removed ?? 0), booked: Number(r.booked ?? 0), notAllowed: Number(r.not_allowed ?? 0) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not remove.' };
  }
}

/** "Removed 12 · 1 has a booked visit — cancel it first" */
export function removeSummary(r: { removed: number; booked: number; notAllowed: number }): string {
  const parts = [`Removed ${r.removed}`];
  if (r.booked) parts.push(`${r.booked} ${r.booked === 1 ? 'has' : 'have'} a booked visit — cancel it first`);
  if (r.notAllowed) parts.push(`${r.notAllowed} not yours to remove`);
  return `${parts.join(' · ')}.`;
}

export interface RemovedLead {
  id: string;
  name: string;
  address: string | null;
  removedAt: string;
  removedBy: string | null;
}

/** Admins: the removed leads, newest first. */
export async function fetchRemovedLeads(): Promise<RemovedLead[]> {
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('id, name, address, removed_at, removed_by')
      .eq('company', COMPANY)
      .not('removed_at', 'is', null)
      .order('removed_at', { ascending: false });
    if (error || !data) return [];
    return (data as { id: string; name: string; address: string | null; removed_at: string; removed_by: string | null }[]).map(
      (r) => ({ id: r.id, name: r.name, address: r.address, removedAt: r.removed_at, removedBy: r.removed_by }),
    );
  } catch {
    return [];
  }
}

async function countRpc(fn: 'restore_leads' | 'delete_leads_forever', ids: string[]) {
  try {
    const { data, error } = await supabase.rpc(fn, { p_ids: ids });
    if (error) return { ok: false as const, message: error.message };
    return { ok: true as const, count: Number(data ?? 0) };
  } catch (e) {
    return { ok: false as const, message: e instanceof Error ? e.message : 'Something went wrong.' };
  }
}

/** Admins: bring removed leads back. */
export function restoreLeads(ids: string[]) {
  return countRpc('restore_leads', ids);
}

/** Admins: delete removed leads for good (their tasks/appointments go too). */
export function deleteLeadsForever(ids: string[]) {
  return countRpc('delete_leads_forever', ids);
}
