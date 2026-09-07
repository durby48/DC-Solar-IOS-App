/**
 * CRM follow-up tasks (Phase 5, 2026-09-07) — the `tasks` table.
 *
 * "Call George back Thursday", "send the Cromwell invoice", "check on the
 * permit". A title, an optional due time, an optional owner (an employee
 * EMAIL — the same identity `leads.assigned_to` and `customer_notes.author_
 * email` use), optionally pinned to a customer, a lead and/or a job. Done is
 * a timestamp, not a boolean, so un-doing is setting it back to NULL.
 *
 * The bucketing (Overdue / Today / Tomorrow / This week / Later) and the
 * "postpone to tomorrow / next week" actions are adapted from Atomic CRM
 * (marmelab/atomic-crm, MIT — src/components/atomic-crm/tasks/
 * tasksPredicate.ts and Task.tsx). Their date-fns helpers are inlined here
 * because the app does not carry date-fns; the semantics are theirs. One
 * addition: a "No date" bucket, because `due_at` is nullable for us.
 *
 * RLS (2026-09-07_tasks.sql): admins read everything; everyone else reads
 * what is assigned to them or created by them. Reads here never widen that —
 * an empty list is what a crew member with nothing assigned should see.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

export interface Task {
  id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  done_at: string | null;
  assigned_to: string | null;
  customer_id: string | null;
  lead_id: string | null;
  job_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const TASK_COLUMNS =
  'id, title, notes, due_at, done_at, assigned_to, customer_id, lead_id, job_id, created_by, created_at, updated_at';

export type TasksResult = { status: 'ok'; tasks: Task[] } | { status: 'unavailable' };
export type TaskMutation = { ok: true } | { ok: false; message: string };

function friendly(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (/row-level security|policy/i.test(raw)) return 'You can only change tasks assigned to you or that you created.';
  if (/relation .* does not exist/i.test(raw)) return 'Tasks need the latest database migration.';
  return raw;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type TaskScope = { customerId: string } | { leadId: string } | { all: true };

/**
 * Open tasks first (soonest due first, undated last), then done tasks newest
 * first. One read; the buckets are computed client-side from it.
 */
export async function fetchTasks(scope: TaskScope): Promise<TasksResult> {
  try {
    let query = supabase.from('tasks').select(TASK_COLUMNS).eq('company', COMPANY);
    if ('customerId' in scope) query = query.eq('customer_id', scope.customerId);
    else if ('leadId' in scope) query = query.eq('lead_id', scope.leadId);
    const { data, error } = await query
      .order('done_at', { ascending: true, nullsFirst: true })
      .order('due_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });
    if (error) return { status: 'unavailable' };
    return { status: 'ok', tasks: (data ?? []) as unknown as Task[] };
  } catch {
    return { status: 'unavailable' };
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createTask(input: {
  title: string;
  dueAt?: string | null;
  assignedTo?: string | null;
  notes?: string | null;
  customerId?: string | null;
  leadId?: string | null;
  jobId?: string | null;
}): Promise<TaskMutation> {
  const title = input.title.trim();
  if (!title) return { ok: false, message: 'Give the task a title.' };
  try {
    const { data: userData } = await supabase.auth.getUser();
    const email = userData?.user?.email ?? null;
    if (!email) return { ok: false, message: 'Sign in to add a task.' };
    const { error } = await supabase.from('tasks').insert({
      company: COMPANY,
      title,
      notes: input.notes?.trim() || null,
      due_at: input.dueAt ?? null,
      assigned_to: input.assignedTo ?? null,
      customer_id: input.customerId ?? null,
      lead_id: input.leadId ?? null,
      job_id: input.jobId ?? null,
      created_by: email,
    });
    if (error) return { ok: false, message: friendly(error.message, 'Could not add that task.') };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: friendly(e instanceof Error ? e.message : undefined, 'Could not add that task.') };
  }
}

export async function updateTask(
  id: string,
  patch: Partial<Pick<Task, 'title' | 'notes' | 'due_at' | 'done_at' | 'assigned_to'>>,
): Promise<TaskMutation> {
  try {
    if (patch.title !== undefined && !patch.title.trim()) return { ok: false, message: 'Give the task a title.' };
    const { error } = await supabase.from('tasks').update(patch).eq('id', id);
    if (error) return { ok: false, message: friendly(error.message, 'Could not update that task.') };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: friendly(e instanceof Error ? e.message : undefined, 'Could not update that task.') };
  }
}

/** Tick / untick. */
export function setTaskDone(id: string, done: boolean): Promise<TaskMutation> {
  return updateTask(id, { done_at: done ? new Date().toISOString() : null });
}

/**
 * Atomic's "postpone": tomorrow / next week counted from NOW, not from the
 * old due date — an overdue task pushed "to tomorrow" must land tomorrow.
 * Keeps the task's time of day when it had one.
 */
export function postponeTask(task: Task, days: number, now = new Date()): Promise<TaskMutation> {
  const next = defaultDueTime(addDays(now, days));
  if (task.due_at) {
    const old = new Date(task.due_at);
    if (Number.isFinite(old.getTime())) next.setHours(old.getHours(), old.getMinutes(), 0, 0);
  }
  return updateTask(task.id, { due_at: next.toISOString() });
}

export async function deleteTask(id: string): Promise<TaskMutation> {
  try {
    const { error } = await supabase.from('tasks').delete().eq('id', id);
    if (error) return { ok: false, message: friendly(error.message, 'Could not delete that task.') };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: friendly(e instanceof Error ? e.message : undefined, 'Could not delete that task.') };
  }
}

// ---------------------------------------------------------------------------
// Dates and buckets (adapted from Atomic CRM's tasksPredicate.ts)
// ---------------------------------------------------------------------------

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

/** Sunday-start week, like Atomic (`weekStartsOn: 0`): the coming Sunday 00:00. */
function endOfWeek(d: Date): Date {
  const start = startOfDay(d);
  return addDays(start, 7 - start.getDay());
}

/** "Due today" with no time given means 9 AM — the start of a work day, not midnight. */
export function defaultDueTime(day: Date): Date {
  const d = startOfDay(day);
  d.setHours(9, 0, 0, 0);
  return d;
}

/** ISO for a quick-pick: today / tomorrow / next week / a YYYY-MM-DD string. */
export function dueFromPick(pick: 'today' | 'tomorrow' | 'nextWeek' | string, now = new Date()): string | null {
  if (pick === 'today') return defaultDueTime(now).toISOString();
  if (pick === 'tomorrow') return defaultDueTime(addDays(now, 1)).toISOString();
  if (pick === 'nextWeek') return defaultDueTime(addDays(now, 7)).toISOString();
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(pick.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(d.getTime()) || d.getMonth() !== Number(m[2]) - 1) return null;
  return defaultDueTime(d).toISOString();
}

export type TaskBucket = 'overdue' | 'today' | 'tomorrow' | 'thisWeek' | 'later' | 'noDate' | 'done';

export const BUCKET_ORDER: TaskBucket[] = ['overdue', 'today', 'tomorrow', 'thisWeek', 'later', 'noDate', 'done'];

export const BUCKET_LABEL: Record<TaskBucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  tomorrow: 'Tomorrow',
  thisWeek: 'This week',
  later: 'Later',
  noDate: 'No date',
  done: 'Done',
};

export function taskBucket(task: Task, now = new Date()): TaskBucket {
  if (task.done_at) return 'done';
  if (!task.due_at) return 'noDate';
  const due = new Date(task.due_at);
  if (!Number.isFinite(due.getTime())) return 'noDate';
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const dayAfter = addDays(today, 2);
  if (due < today) return 'overdue';
  if (due < tomorrow) return 'today';
  if (due < dayAfter) return 'tomorrow';
  if (due < endOfWeek(now)) return 'thisWeek';
  return 'later';
}

export function bucketTasks(tasks: Task[], now = new Date()): { bucket: TaskBucket; tasks: Task[] }[] {
  const map = new Map<TaskBucket, Task[]>();
  for (const t of tasks) {
    const b = taskBucket(t, now);
    const list = map.get(b) ?? [];
    list.push(t);
    map.set(b, list);
  }
  return BUCKET_ORDER.filter((b) => map.has(b)).map((b) => ({ bucket: b, tasks: map.get(b) as Task[] }));
}

/** "Today 9:00 AM", "Tomorrow", "Thu, Sep 11", "Overdue · Sep 3", or "" for no date. */
export function dueLabel(task: Task, now = new Date()): string {
  if (!task.due_at) return '';
  const due = new Date(task.due_at);
  if (!Number.isFinite(due.getTime())) return '';
  const bucket = task.done_at ? null : taskBucket(task, now);
  const time = due.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const day =
    due.getFullYear() === now.getFullYear()
      ? due.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      : due.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (bucket === 'overdue') return `Overdue · ${due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  if (bucket === 'today') return `Today ${time}`;
  if (bucket === 'tomorrow') return `Tomorrow ${time}`;
  return day;
}

/** Open tasks that need attention now: overdue or due today. */
export function countDueNow(tasks: Task[], now = new Date()): number {
  return tasks.filter((t) => {
    const b = taskBucket(t, now);
    return b === 'overdue' || b === 'today';
  }).length;
}
