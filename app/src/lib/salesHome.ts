import { fetchRecents } from '@/lib/comms';
import { fetchCommissions, fetchCurrentPayPeriod, totalCents } from '@/lib/commission';
import { fetchWorkspaceRecords, isProspect, type WorkspaceRecord } from '@/lib/crmWorkspace';
import { fetchScheduleRange } from '@/lib/data';
import { todayISO } from '@/lib/dates';
import { fetchLeadAppointmentsRange, KIND_LABEL } from '@/lib/leadAppointments';
import { isServiceJob } from '@/lib/stages';
import { supabase } from '@/lib/supabase';
import { dueLabel, fetchTasks, taskBucket } from '@/lib/tasks';
import { formatTimeLabel } from '@/lib/time';

/**
 * Everything the Sales Home shows (2026-10-06, S1), in one load.
 *
 * NO NEW READS OF ANYONE ELSE'S DATA. Every query is one the CRM workspace,
 * the call log or the calendar already makes, and RLS narrows each to the
 * rep's own prospects, leads and customers (2026-10-05_sales_role.sql,
 * _service_visits.sql, _rep_numbers.sql). The one new call is
 * `my_phone_line()`, which answers only the caller's own number.
 *
 * One person, one row — the same rule the workspace uses: a booked lead has a
 * hidden customer behind it until the visit is paid, and the rep works the
 * LEAD, so unpaid service customers are dropped here too.
 */

export interface SalesCounts {
  prospects: number;
  contacted: number;
  interested: number;
  booked: number;
  customers: number;
}

export interface MissedCall {
  id: string;
  name: string;
  phone: string | null;
  at: string;
  count: number;
  /** The CRM record it belongs to, when there is one the rep can see. */
  recordKey: string | null;
}

export interface TodayItem {
  key: string;
  kind: 'visit' | 'appointment' | 'task';
  /** "10:00 AM", "Overdue · Oct 3", or "" when there is no time. */
  when: string;
  title: string;
  subtitle: string | null;
  overdue: boolean;
  recordKey: string | null;
}

export interface SalesHomeData {
  /** Their DC Solar number, E.164, or null when none is assigned yet. */
  line: string | null;
  counts: SalesCounts;
  /** Records with unread texts, most recent first. */
  unread: WorkspaceRecord[];
  missed: MissedCall[];
  today: TodayItem[];
  /** Their commission in the current pay period, in cents (S4). */
  commissionCents: number;
}

/** How far back an unanswered call still counts as "needs attention". */
const MISSED_WINDOW_DAYS = 3;

/** The caller's own DC Solar number (`my_phone_line()`), or null. */
export async function fetchMyLine(): Promise<string | null> {
  try {
    const { data, error } = await supabase.rpc('my_phone_line');
    if (error || typeof data !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

export async function fetchSalesHome(myEmail: string | null): Promise<SalesHomeData> {
  const today = todayISO();
  const [recordsResult, line, recents, taskResult, appointments, visits, commissions, period] = await Promise.all([
    fetchWorkspaceRecords(),
    fetchMyLine(),
    fetchRecents(100),
    fetchTasks({ all: true }),
    fetchLeadAppointmentsRange(today, today),
    fetchScheduleRange(today, today),
    fetchCommissions(),
    fetchCurrentPayPeriod(),
  ]);

  const records = recordsResult.records.filter((r) => !(r.kind === 'customer' && r.serviceStatus === 'unpaid'));
  const leads = records.filter((r) => r.kind === 'lead');
  const status = (r: WorkspaceRecord) => r.lead?.status ?? 'new';

  const counts: SalesCounts = {
    prospects: leads.filter(isProspect).length,
    contacted: leads.filter((r) => status(r) === 'contacted').length,
    interested: leads.filter((r) => status(r) === 'interested').length,
    booked: leads.filter((r) => status(r) === 'scheduled' || status(r) === 'visit_done').length,
    customers: records.filter((r) => r.kind === 'customer').length,
  };

  const unread = records.filter((r) => r.unread > 0);

  // A missed call stops needing attention once anyone calls that party back:
  // the log is newest first, so a later call to the same party is seen first.
  const byCustomer = new Map(records.filter((r) => r.kind === 'customer').map((r) => [r.id, r.key]));
  const byPhone = new Map(records.filter((r) => r.phoneE164).map((r) => [r.phoneE164 as string, r.key]));
  const cutoff = Date.now() - MISSED_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const handled = new Set<string>();
  const missed: MissedCall[] = [];
  for (const call of recents) {
    const party = call.customerId ?? call.phone ?? call.id;
    if (handled.has(party)) continue;
    handled.add(party);
    if (!call.missed || call.direction !== 'in') continue;
    if (new Date(call.at).getTime() < cutoff) continue;
    missed.push({
      id: call.id,
      name: call.displayName,
      phone: call.phone,
      at: call.at,
      count: call.count,
      recordKey: (call.customerId ? byCustomer.get(call.customerId) : undefined) ?? (call.phone ? byPhone.get(call.phone) : undefined) ?? null,
    });
  }

  const todayItems: TodayItem[] = [];
  // A visit opens its customer once paid; until then the rep works the lead
  // that booked it (the customer behind it is hidden from them).
  const visitRecordKey = (jobId: string, customerId: string | null) => {
    const lead = recordsResult.records.find((r) => r.kind === 'lead' && r.lead?.converted_job_id === jobId);
    if (lead && records.includes(lead)) return lead.key;
    const key = customerId ? `customer:${customerId}` : null;
    return key && records.some((r) => r.key === key) ? key : null;
  };
  for (const v of visits) {
    if (!isServiceJob(v.job)) continue;
    todayItems.push({
      key: `visit:${v.id}`,
      kind: 'visit',
      when: formatTimeLabel(v.start_time) ?? '',
      title: `${v.job.job_type ?? 'Service'} visit · ${v.job.customer?.name ?? v.job.name}`,
      subtitle: v.job.service_paid_at ? 'Paid' : (v.job.address ?? null),
      overdue: false,
      recordKey: visitRecordKey(v.job.id, v.job.customer_id),
    });
  }
  for (const a of appointments) {
    if (a.outcome === 'canceled') continue;
    todayItems.push({
      key: `appt:${a.id}`,
      kind: 'appointment',
      when: formatTimeLabel(a.start_time) ?? '',
      title: `${KIND_LABEL[a.kind]} · ${a.lead_name}`,
      subtitle: a.lead_address,
      overdue: false,
      recordKey: `lead:${a.lead_id}`,
    });
  }
  // Timed items in time order; the tasks list follows.
  todayItems.sort((x, y) => (x.when && y.when ? sortableTime(x.when) - sortableTime(y.when) : x.when ? -1 : y.when ? 1 : 0));

  const me = myEmail?.toLowerCase() ?? null;
  const tasks = taskResult.status === 'ok' ? taskResult.tasks : [];
  for (const t of tasks) {
    if (t.assigned_to && me && t.assigned_to.toLowerCase() !== me) continue;
    const bucket = taskBucket(t);
    if (bucket !== 'overdue' && bucket !== 'today') continue;
    const recordKey = t.lead_id ? `lead:${t.lead_id}` : t.customer_id ? `customer:${t.customer_id}` : null;
    const record = recordKey ? recordsResult.records.find((r) => r.key === recordKey) : undefined;
    todayItems.push({
      key: `task:${t.id}`,
      kind: 'task',
      when: dueLabel(t),
      title: t.title,
      subtitle: record?.name ?? null,
      overdue: bucket === 'overdue',
      recordKey,
    });
  }

  return {
    line,
    counts,
    unread,
    missed,
    today: todayItems,
    commissionCents: period ? totalCents(commissions.filter((c) => c.periodStart === period.start)) : 0,
  };
}

/** "2:30 PM" → minutes since midnight, for ordering. */
function sortableTime(label: string): number {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(label);
  if (!m) return 24 * 60;
  let h = Number(m[1]) % 12;
  if ((m[3] ?? '').toUpperCase() === 'PM') h += 12;
  return h * 60 + Number(m[2]);
}
