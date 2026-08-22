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
import { type Job } from '@/lib/mockData';

const COMPANY = 'dc-solar';

export type LeadStatus = 'new' | 'contacted' | 'estimating' | 'won' | 'lost';

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
          'id, created_at, name, phone, email, address, source, status, assigned_to, estimated_value, notes, converted_job_id, lost_reason',
        )
        .eq('company', COMPANY)
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
        .in('type', ['estimate', 'contract']),
      supabase
        .from('employees')
        .select('email, display_name')
        .eq('company', COMPANY),
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
 */
export async function fetchOpenLeads(): Promise<Lead[]> {
  try {
    const { data, error } = await supabase
      .from('leads')
      .select(
        'id, created_at, name, phone, email, address, source, status, assigned_to, estimated_value, notes, converted_job_id, lost_reason',
      )
      .eq('company', COMPANY)
      .is('converted_job_id', null)
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

/** Assign or reassign a lead's rep. Admin-only; RLS rejects anyone else. */
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

/** Move a lead along the funnel. A rep may do this on their own leads. */
export async function setLeadStatus(
  leadId: string,
  status: LeadStatus,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await supabase.from('leads').update({ status }).eq('id', leadId);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}
