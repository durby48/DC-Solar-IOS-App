/**
 * THE NOTIFICATION TARGET CONTRACT — the app half (2026-09-08).
 *
 * Every push the `notify` edge function sends carries a `data` object saying
 * what the notification is ABOUT, with stable ids, so a tap can open the
 * exact screen without guessing from a name or a number. The server half is
 * `sanitizeTarget()` in supabase/functions/notify/index.ts; keep the two in
 * step. This file has no platform variants and no runtime imports, so any
 * module may import it.
 *
 * Local notifications (the on-device job reminders in lib/notifications.ts)
 * use `{ type: 'job-reminder', jobId }`; `parseNotificationTarget` folds
 * that into `job` so one router handles both.
 */

export type NotificationTarget =
  | { type: 'sms_thread'; customerId?: string; leadId?: string; contactId?: string; phone?: string; name?: string }
  | { type: 'call'; customerId?: string; leadId?: string; contactId?: string; phone?: string; name?: string }
  | { type: 'lead'; leadId: string }
  | { type: 'customer'; customerId: string }
  | { type: 'job'; jobId: string }
  | { type: 'task'; taskId: string; leadId?: string; customerId?: string }
  | { type: 'appointment'; appointmentId: string; leadId?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined;
}

function id(value: unknown): string | undefined {
  const s = str(value);
  return s && UUID_RE.test(s) ? s : undefined;
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
    case 'job':
    case 'job-reminder': {
      const jobId = id(d.jobId);
      return jobId ? { type: 'job', jobId } : null;
    }
    case 'task': {
      const taskId = id(d.taskId);
      return taskId ? { type: 'task', taskId, leadId: id(d.leadId), customerId: id(d.customerId) } : null;
    }
    case 'appointment': {
      const appointmentId = id(d.appointmentId);
      return appointmentId ? { type: 'appointment', appointmentId, leadId: id(d.leadId) } : null;
    }
    default:
      return null;
  }
}
