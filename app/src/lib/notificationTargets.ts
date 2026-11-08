/**
 * THE NOTIFICATION TARGET CONTRACT — the app half (2026-09-08; widened
 * 2026-11-08).
 *
 * Every push the `notify` edge function sends carries a `data` object saying
 * what the notification is ABOUT, with stable ids, so a tap can open the
 * exact screen without guessing from a name or a number. The server half is
 * `TARGET_RULES` / `sanitizeTarget()` in supabase/functions/notify/index.ts;
 * keep the two in step — the server now validates with the SAME per-type
 * rules, so a target the app would reject is never sent.
 *
 * The same targets are stored on each `notifications` row (the in-app Alerts
 * list), so an alert tap and a push tap take one path.
 *
 * Local notifications (the on-device job reminders in lib/notifications.ts)
 * use `{ type: 'job-reminder', jobId, day? }`; `parseNotificationTarget`
 * folds that into `schedule` (with a day) or `job`.
 */

export type NotificationTarget =
  | { type: 'sms_thread'; customerId?: string; leadId?: string; contactId?: string; phone?: string; name?: string }
  | { type: 'call'; customerId?: string; leadId?: string; contactId?: string; phone?: string; name?: string }
  | { type: 'lead'; leadId: string }
  | { type: 'customer'; customerId: string }
  | { type: 'job'; jobId: string }
  // A schedule change or job reminder (2026-11-08): opens the calendar on that day.
  | { type: 'schedule'; jobId: string; day: string }
  | { type: 'task'; taskId: string; leadId?: string; customerId?: string }
  | { type: 'appointment'; appointmentId: string; leadId?: string; day?: string }
  // A hail storm (2026-10-09) → its Storm report.
  | { type: 'storm'; day: string }
  // A CRM email reply (2026-11-08) → that Gmail thread in the inbox.
  | { type: 'email_thread'; threadId: string }
  // A batch of prospects handed to a rep → the CRM's Prospects lens.
  | { type: 'prospects' }
  // A payment with no job → Financials.
  | { type: 'financials' }
  // An email alert with no thread id → the inbox.
  | { type: 'inbox' }
  // Developer Tools → "Send me a test notification".
  | { type: 'test' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Gmail thread ids are hex strings.
const THREAD_RE = /^[A-Za-z0-9_-]{6,64}$/;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined;
}

function id(value: unknown): string | undefined {
  const s = str(value);
  return s && UUID_RE.test(s) ? s : undefined;
}

function day(value: unknown): string | undefined {
  const s = str(value);
  return s && DAY_RE.test(s) ? s : undefined;
}

/** A notification's `data` → a target, or null when it is not one of ours. */
export function parseNotificationTarget(data: unknown): NotificationTarget | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  switch (d.type) {
    case 'sms_thread':
    case 'call': {
      const customerId = id(d.customerId);
      const leadId = id(d.leadId);
      const contactId = id(d.contactId);
      const phone = str(d.phone);
      if (!customerId && !leadId && !contactId && !phone) return null;
      return { type: d.type, customerId, leadId, contactId, phone, name: str(d.name) };
    }
    case 'lead': {
      const leadId = id(d.leadId);
      return leadId ? { type: 'lead', leadId } : null;
    }
    case 'customer': {
      const customerId = id(d.customerId);
      return customerId ? { type: 'customer', customerId } : null;
    }
    case 'job': {
      const jobId = id(d.jobId);
      return jobId ? { type: 'job', jobId } : null;
    }
    case 'schedule':
    case 'job-reminder': {
      const jobId = id(d.jobId);
      if (!jobId) return null;
      const when = day(d.day);
      return when ? { type: 'schedule', jobId, day: when } : { type: 'job', jobId };
    }
    case 'task': {
      const taskId = id(d.taskId);
      return taskId ? { type: 'task', taskId, leadId: id(d.leadId), customerId: id(d.customerId) } : null;
    }
    case 'appointment': {
      const appointmentId = id(d.appointmentId);
      return appointmentId
        ? { type: 'appointment', appointmentId, leadId: id(d.leadId), day: day(d.day) }
        : null;
    }
    case 'storm': {
      const when = day(d.day);
      return when ? { type: 'storm', day: when } : null;
    }
    case 'email_thread': {
      const threadId = str(d.threadId);
      return threadId && THREAD_RE.test(threadId) ? { type: 'email_thread', threadId } : null;
    }
    case 'prospects':
    case 'financials':
    case 'inbox':
    case 'test':
      return { type: d.type };
    default:
      return null;
  }
}
