/**
 * The CRM workspace's read model (web-first CRM, 2026-09-07).
 *
 * NOTHING HERE OWNS DATA. Every row comes from a system that already exists —
 * `customers` (lib/crm.ts), `leads` (lib/sales.ts), `jobs`, `messages`
 * (lib/comms.ts), `customer_notes`, `finance_entries` — and this module only
 * composes them into two shapes the workspace screens need:
 *
 *   1. `WorkspaceRecord` — one row of the left-hand list, a customer OR a
 *      lead, with the bits a list needs to be useful at a glance: current
 *      job/stage, last contact, unread texts, STOP.
 *   2. `ActivityEvent` — one row of the unified timeline, composed CLIENT-SIDE
 *      from data the workspace has already loaded. No activity table, no
 *      duplicated rows: every event still lives in its owning table.
 *
 * Keep it layout-agnostic. A native/mobile CRM screen later should be able to
 * import this file unchanged.
 */

import { fetchThreads, type CommsMessage, type CommsThread } from '@/lib/comms';
import {
  fetchCrmCustomers,
  fetchCustomerSummaries,
  type CustomerFinanceRow,
  type CustomerJob,
  type CustomerNote,
  type CustomerSummary,
} from '@/lib/crm';
import { fetchOpenLeads, type Lead, type LeadStatus } from '@/lib/sales';
import { supabase } from '@/lib/supabase';
import { type Task } from '@/lib/tasks';
import { type Customer } from '@/lib/types';

const COMPANY = 'dc-solar';

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export type RecordKind = 'customer' | 'lead';

/** The job the workspace treats as "current": newest not-yet-complete, else newest. */
export interface WorkspaceJobLite {
  id: string;
  job_number: string | null;
  name: string;
  stage: string | null;
  status: string | null;
  scheduled_for: string | null;
  completed_on: string | null;
  created_at: string | null;
  customer_id: string | null;
}

export interface WorkspaceRecord {
  /** `customer:<id>` / `lead:<id>` — stable list key and selection id. */
  key: string;
  kind: RecordKind;
  id: string;
  name: string;
  phone: string | null;
  phoneE164: string | null;
  email: string | null;
  address: string | null;
  /** Current job stage for a customer, funnel status for a lead. */
  subtitle: string | null;
  currentJob: WorkspaceJobLite | null;
  jobCount: number;
  /** Newest message either way, or the money rollup's last activity. */
  lastActivityAt: string | null;
  unread: number;
  optedOut: boolean;
  customer: Customer | null;
  lead: Lead | null;
  summary: CustomerSummary | null;
}

export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'New lead',
  contacted: 'Contacted',
  estimating: 'Estimating',
  won: 'Won',
  lost: 'Lost',
};

export const LEAD_STATUS_ORDER: LeadStatus[] = ['new', 'contacted', 'estimating', 'won', 'lost'];

function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function pickCurrentJob(jobs: WorkspaceJobLite[]): WorkspaceJobLite | null {
  if (jobs.length === 0) return null;
  const open = jobs.filter((j) => j.stage !== 'Complete' && j.status !== 'completed');
  const pool = open.length > 0 ? open : jobs;
  return [...pool].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0] ?? null;
}

/** Every job, member-readable, grouped by customer. Empty map on any problem. */
async function fetchJobsByCustomer(): Promise<Map<string, WorkspaceJobLite[]>> {
  const map = new Map<string, WorkspaceJobLite[]>();
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, job_number, name, stage, status, scheduled_for, completed_on, created_at, customer_id, is_internal')
      .eq('company', COMPANY);
    if (error || !data) return map;
    for (const row of data as (WorkspaceJobLite & { is_internal?: boolean | null })[]) {
      if (!row.customer_id || row.is_internal) continue;
      const list = map.get(row.customer_id) ?? [];
      list.push(row);
      map.set(row.customer_id, list);
    }
  } catch {
    // no jobs → no stages on the list, still a list
  }
  return map;
}

export interface WorkspaceRecordsResult {
  records: WorkspaceRecord[];
  /** False when `crm_customer_summary` gave nothing — a viewer, or offline. */
  hasMoney: boolean;
  status: 'ok' | 'unavailable';
}

/**
 * The left-hand list. Four reads in parallel (customers, leads, jobs, threads)
 * plus the money rollup, then one pass to stitch them. Sorted by most recent
 * contact first so the person who just texted is at the top — the same rule
 * the inbox uses — with untouched records A–Z after.
 */
export async function fetchWorkspaceRecords(): Promise<WorkspaceRecordsResult> {
  const [customersRes, leads, jobsByCustomer, threads] = await Promise.all([
    fetchCrmCustomers(),
    fetchOpenLeads(),
    fetchJobsByCustomer(),
    fetchThreads(),
  ]);
  if (customersRes.status !== 'ok') return { records: [], hasMoney: false, status: 'unavailable' };

  const customers = customersRes.customers;
  const summaries = await fetchCustomerSummaries(customers.map((c) => c.id));

  const threadByCustomer = new Map<string, CommsThread>();
  const threadByPhone = new Map<string, CommsThread>();
  for (const t of threads) {
    if (t.customerId) threadByCustomer.set(t.customerId, t);
    else if (t.phone) threadByPhone.set(t.phone, t);
  }

  const records: WorkspaceRecord[] = [];

  for (const c of customers) {
    const jobs = jobsByCustomer.get(c.id) ?? [];
    const current = pickCurrentJob(jobs);
    const thread = threadByCustomer.get(c.id) ?? null;
    const summary = summaries.get(c.id) ?? null;
    records.push({
      key: `customer:${c.id}`,
      kind: 'customer',
      id: c.id,
      name: c.name,
      phone: c.phone,
      phoneE164: c.phone_e164 ?? toE164(c.phone),
      email: c.email ?? null,
      address: c.address,
      subtitle: current ? `${current.job_number ?? current.name} · ${current.stage ?? 'No stage'}` : jobs.length === 0 ? 'No jobs yet' : null,
      currentJob: current,
      jobCount: jobs.length,
      lastActivityAt: thread?.lastAt ?? summary?.lastActivityAt ?? null,
      unread: thread?.unread ?? 0,
      optedOut: c.sms_opt_out_at != null,
      customer: c,
      lead: null,
      summary,
    });
  }

  for (const l of leads) {
    const e164 = toE164(l.phone);
    const thread = e164 ? (threadByPhone.get(e164) ?? null) : null;
    records.push({
      key: `lead:${l.id}`,
      kind: 'lead',
      id: l.id,
      name: l.name,
      phone: l.phone,
      phoneE164: e164,
      email: l.email,
      address: l.address,
      subtitle: `Lead · ${LEAD_STATUS_LABEL[l.status] ?? l.status}${l.source ? ` · ${l.source}` : ''}`,
      currentJob: null,
      jobCount: 0,
      lastActivityAt: thread?.lastAt ?? l.created_at,
      unread: thread?.unread ?? 0,
      optedOut: false,
      customer: null,
      lead: l,
      summary: null,
    });
  }

  records.sort((a, b) => {
    if (a.lastActivityAt && b.lastActivityAt) return b.lastActivityAt.localeCompare(a.lastActivityAt);
    if (a.lastActivityAt) return -1;
    if (b.lastActivityAt) return 1;
    return a.name.localeCompare(b.name);
  });

  return { records, hasMoney: summaries.size > 0, status: 'ok' };
}

/** Case-insensitive match on name, phone digits, email, address, job number. */
export function filterRecords(
  records: WorkspaceRecord[],
  query: string,
  kind: RecordKind | 'all',
): WorkspaceRecord[] {
  const q = query.trim().toLowerCase();
  const digits = q.replace(/[^0-9]/g, '');
  return records.filter((r) => {
    if (kind !== 'all' && r.kind !== kind) return false;
    if (!q) return true;
    if (r.name.toLowerCase().includes(q)) return true;
    if (r.email?.toLowerCase().includes(q)) return true;
    if (r.address?.toLowerCase().includes(q)) return true;
    if (r.currentJob?.job_number?.toLowerCase().includes(q)) return true;
    if (digits.length >= 3 && r.phoneE164?.includes(digits)) return true;
    return false;
  });
}

// ---------------------------------------------------------------------------
// Stage / status history (Phase 4, 2026-09-07)
// ---------------------------------------------------------------------------

/**
 * One transition of `jobs.stage` or `leads.status`, from `job_stage_history`
 * / `lead_status_history`. Written by database triggers only — whoever
 * changed the column (app, ops console, edge function) — so the client never
 * inserts here. `by` is NULL for service-role writes; the timeline calls that
 * "system".
 */
export interface StageChange {
  id: string;
  entity: 'job' | 'lead';
  entityId: string;
  from: string | null;
  to: string | null;
  by: string | null;
  at: string;
}

export async function fetchJobStageHistory(jobIds: string[]): Promise<StageChange[]> {
  if (jobIds.length === 0) return [];
  try {
    const { data, error } = await supabase
      .from('job_stage_history')
      .select('id, job_id, from_stage, to_stage, changed_by, changed_at')
      .in('job_id', jobIds)
      .order('changed_at', { ascending: false });
    if (error || !data) return [];
    return (data as { id: string; job_id: string; from_stage: string | null; to_stage: string | null; changed_by: string | null; changed_at: string }[]).map(
      (r) => ({ id: r.id, entity: 'job', entityId: r.job_id, from: r.from_stage, to: r.to_stage, by: r.changed_by, at: r.changed_at }),
    );
  } catch {
    return [];
  }
}

export async function fetchLeadStatusHistory(leadId: string): Promise<StageChange[]> {
  try {
    const { data, error } = await supabase
      .from('lead_status_history')
      .select('id, lead_id, from_status, to_status, changed_by, changed_at')
      .eq('lead_id', leadId)
      .order('changed_at', { ascending: false });
    if (error || !data) return [];
    return (data as { id: string; lead_id: string; from_status: string | null; to_status: string | null; changed_by: string | null; changed_at: string }[]).map(
      (r) => ({ id: r.id, entity: 'lead', entityId: r.lead_id, from: r.from_status, to: r.to_status, by: r.changed_by, at: r.changed_at }),
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

export type ActivityKind =
  | 'sms_in'
  | 'sms_out'
  | 'call'
  | 'note'
  | 'job_created'
  | 'job_scheduled'
  | 'job_completed'
  | 'job_stage'
  | 'estimate'
  | 'contract'
  | 'invoice'
  | 'payment'
  | 'lead_created'
  | 'lead_status'
  | 'task_added'
  | 'task_done';

export interface ActivityEvent {
  id: string;
  at: string;
  kind: ActivityKind;
  title: string;
  detail: string | null;
  /** Email or display name of whoever did it, when known. */
  actor: string | null;
  /** Where a tap should go, when there is somewhere. */
  jobId: string | null;
}

/** "devonsd311@gmail.com" → "Devonsd311", "test-crew@…" → "Test": the first name-ish token, capitalised. */
export function authorName(email: string | null | undefined): string | null {
  if (!email) return null;
  const local = email.split('@')[0] ?? '';
  const first = local.split(/[._-]/)[0] ?? local;
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : null;
}

function money(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

/**
 * Compose the unified timeline from what the workspace already fetched.
 *
 * Deliberately a pure function of inputs the caller owns — messages from
 * `fetchThread`, notes from `fetchCustomerNotes`, jobs from
 * `fetchCustomerJobs`, money rows from `fetchCustomerFinance` (empty for a
 * viewer, which is correct) — so the screen fetches each source once and the
 * timeline never triggers its own round trips.
 *
 * Stage/status transitions come from `history` (`fetchJobStageHistory` /
 * `fetchLeadStatusHistory`). The trigger also logs the INSERT (from NULL) so
 * the table is complete on its own; the timeline skips those rows because
 * "Job created" / "Lead created" already stand at that instant.
 */
export function composeActivity(input: {
  messages: CommsMessage[];
  notes: CustomerNote[];
  jobs: CustomerJob[];
  finance: CustomerFinanceRow[];
  lead?: Lead | null;
  history?: StageChange[];
  tasks?: Task[];
}): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  for (const t of input.tasks ?? []) {
    events.push({
      id: `task:${t.id}:added`,
      at: t.created_at,
      kind: 'task_added',
      title: `Task added · ${t.title}`,
      detail: t.notes,
      actor: authorName(t.created_by),
      jobId: t.job_id,
    });
    if (t.done_at) {
      events.push({
        id: `task:${t.id}:done`,
        at: t.done_at,
        kind: 'task_done',
        title: `Task done · ${t.title}`,
        detail: null,
        // The row does not record who ticked it; the assignee is the best guess.
        actor: authorName(t.assigned_to),
        jobId: t.job_id,
      });
    }
  }

  const jobLabel = new Map<string, string>();
  for (const j of input.jobs) jobLabel.set(j.id, j.job_number ?? j.name);

  for (const h of input.history ?? []) {
    if (h.from == null) continue;
    if (h.entity === 'job') {
      events.push({
        id: `hist:${h.id}`,
        at: h.at,
        kind: 'job_stage',
        title: `${jobLabel.get(h.entityId) ?? 'Job'} · ${h.from} → ${h.to ?? 'no stage'}`,
        detail: null,
        actor: h.by ? authorName(h.by) : 'system',
        jobId: h.entityId,
      });
    } else {
      const label = (s: string | null) => (s ? (LEAD_STATUS_LABEL[s as LeadStatus] ?? s) : '—');
      events.push({
        id: `hist:${h.id}`,
        at: h.at,
        kind: 'lead_status',
        title: `Lead · ${label(h.from)} → ${label(h.to)}`,
        detail: null,
        actor: h.by ? authorName(h.by) : 'system',
        jobId: null,
      });
    }
  }

  for (const m of input.messages) {
    if (m.channel === 'call') {
      const failed = ['failed', 'busy', 'no-answer', 'canceled'].includes(m.status);
      events.push({
        id: `msg:${m.id}`,
        at: m.created_at,
        kind: 'call',
        title: failed ? 'Call did not connect' : m.direction === 'out' ? 'Called them' : 'They called',
        detail: failed
          ? (m.error ?? m.status)
          : m.duration_seconds
            ? `${Math.floor(m.duration_seconds / 60)}m ${m.duration_seconds % 60}s`
            : m.status,
        actor: authorName(m.sent_by),
        jobId: m.job_id,
      });
      continue;
    }
    const pics = m.media_urls.length;
    events.push({
      id: `msg:${m.id}`,
      at: m.created_at,
      kind: m.direction === 'in' ? 'sms_in' : 'sms_out',
      title: m.direction === 'in' ? 'They texted' : 'Text sent',
      detail: (m.body ?? '') + (pics ? `${m.body ? ' ' : ''}(${pics} photo${pics === 1 ? '' : 's'})` : ''),
      actor: m.direction === 'out' ? authorName(m.sent_by) : null,
      jobId: m.job_id,
    });
  }

  for (const n of input.notes) {
    events.push({
      id: `note:${n.id}`,
      at: n.created_at,
      kind: 'note',
      title: n.pinned ? 'Pinned note' : 'Note',
      detail: n.body,
      actor: authorName(n.author_email),
      jobId: n.job_id,
    });
  }

  for (const j of input.jobs) {
    const label = j.job_number ?? j.name;
    if (j.created_at) {
      events.push({
        id: `job:${j.id}:created`,
        at: j.created_at,
        kind: 'job_created',
        title: `Job ${label} created`,
        detail: j.name !== label ? j.name : (j.address ?? null),
        actor: null,
        jobId: j.id,
      });
    }
    if (j.scheduled_for) {
      events.push({
        id: `job:${j.id}:scheduled`,
        at: `${j.scheduled_for}T08:00:00`,
        kind: 'job_scheduled',
        title: `${label} scheduled`,
        detail: j.scheduled_end && j.scheduled_end !== j.scheduled_for ? `${j.scheduled_for} → ${j.scheduled_end}` : null,
        actor: null,
        jobId: j.id,
      });
    }
    if (j.completed_on) {
      events.push({
        id: `job:${j.id}:completed`,
        at: `${j.completed_on}T17:00:00`,
        kind: 'job_completed',
        title: `${label} completed`,
        detail: null,
        actor: null,
        jobId: j.id,
      });
    }
  }

  for (const f of input.finance) {
    const at = f.occurred_on ? `${f.occurred_on}T12:00:00` : f.created_at;
    if (!at) continue;
    const kind: ActivityKind =
      f.type === 'estimate' ? 'estimate' : f.type === 'contract' ? 'contract' : f.type === 'invoice' ? 'invoice' : 'payment';
    const verb =
      f.type === 'estimate' ? 'Estimate sent' : f.type === 'contract' ? 'Contract signed' : f.type === 'invoice' ? 'Invoice sent' : 'Payment received';
    events.push({
      id: `fin:${f.id}`,
      at,
      kind,
      title: `${verb} · ${money(f.amount)}`,
      detail: f.document_number ?? f.description ?? null,
      actor: null,
      jobId: f.job_id,
    });
  }

  if (input.lead) {
    events.push({
      id: `lead:${input.lead.id}:created`,
      at: input.lead.created_at,
      kind: 'lead_created',
      title: 'Lead created',
      detail: input.lead.source ? `Source: ${input.lead.source}` : null,
      actor: null,
      jobId: null,
    });
  }

  events.sort((a, b) => b.at.localeCompare(a.at));
  return events;
}

/** "Today", "Yesterday", "Tue, Sep 2", "Aug 14, 2025" — the timeline's day headers. */
export function dayLabel(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(date)) / 86400000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Group a sorted (newest-first) list into day sections for a SectionList. */
export function groupByDay(events: ActivityEvent[]): { title: string; data: ActivityEvent[] }[] {
  const sections: { title: string; data: ActivityEvent[] }[] = [];
  for (const e of events) {
    const title = dayLabel(e.at);
    const last = sections[sections.length - 1];
    if (last && last.title === title) last.data.push(e);
    else sections.push({ title, data: [e] });
  }
  return sections;
}
