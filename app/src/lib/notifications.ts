/**
 * Notifications — two halves:
 *
 * 1. LOCAL job reminders: scheduled on-device 24 hours and 1 hour before each
 *    upcoming scheduled work day (from job_schedule_dates). Rescheduled from
 *    scratch every time the Today screen loads, so edits to the schedule are
 *    picked up next open. No server involved.
 *
 * 2. REMOTE push groundwork: each signed-in device registers its Expo push
 *    token into push_tokens (migration 9). Server-side triggers (payment
 *    received, contract signed, …) will use these tokens in a later phase.
 *
 * Everything is best-effort and iOS/Android-only: web and permission-denied
 * cases silently no-op — notifications must never break the app.
 */

import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { formatTimeLabel } from '@/lib/time';
import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';
const REMINDER_TYPE = 'job-reminder';
/** How far ahead to keep reminders scheduled. */
const HORIZON_DAYS = 14;
/** Assumed start hour for schedule days with no start_time (time TBD). */
const DEFAULT_START_HOUR = 8;

/** Foreground behavior: show banners even while the app is open. */
export function configureNotificationHandler(): void {
  if (Platform.OS === 'web') return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

/** Ask once; remember the answer. Returns whether notifications are allowed. */
async function ensurePermission(): Promise<boolean> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) return false;
    const requested = await Notifications.requestPermissionsAsync();
    return requested.granted;
  } catch {
    return false;
  }
}

interface ReminderJob {
  id: string;
  name: string;
  job_number: string | null;
  address: string | null;
}

/** Local date+time for a schedule row (work_date 'YYYY-MM-DD', HH:MM:SS|null). */
function startDateFor(workDate: string, startTime: string | null): Date {
  const [y, m, d] = workDate.split('-').map(Number);
  let hours = DEFAULT_START_HOUR;
  let minutes = 0;
  if (startTime) {
    const [h, min] = startTime.split(':').map(Number);
    if (Number.isFinite(h)) hours = h;
    if (Number.isFinite(min)) minutes = min;
  }
  return new Date(y, (m ?? 1) - 1, d ?? 1, hours, minutes, 0, 0);
}

/**
 * Re-sync the device's local 24h/1h job reminders against the upcoming
 * schedule. Cancels our previous reminders first (matched by data.type) so
 * schedule edits and re-runs never double up.
 */
export async function scheduleJobReminders(jobs: ReminderJob[]): Promise<void> {
  if (Platform.OS === 'web') return;
  if (!(await ensurePermission())) return;

  try {
    const today = new Date();
    const startISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const horizon = new Date(today.getTime() + HORIZON_DAYS * 86_400_000);
    const endISO = `${horizon.getFullYear()}-${String(horizon.getMonth() + 1).padStart(2, '0')}-${String(horizon.getDate()).padStart(2, '0')}`;

    const { data, error } = await supabase
      .from('job_schedule_dates')
      .select('job_id, work_date, start_time')
      .eq('company', COMPANY)
      .gte('work_date', startISO)
      .lte('work_date', endISO);
    if (error || !data) return;

    // Replace all of our previously scheduled reminders.
    const existing = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      existing
        .filter((n) => n.content.data?.type === REMINDER_TYPE)
        .map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier)),
    );

    const jobById = new Map(jobs.map((j) => [j.id, j]));
    const now = Date.now();

    for (const row of data as {
      job_id: string;
      work_date: string;
      start_time: string | null;
    }[]) {
      const job = jobById.get(row.job_id);
      if (!job) continue;
      const start = startDateFor(row.work_date, row.start_time);
      const timeLabel = row.start_time
        ? (formatTimeLabel(row.start_time) ?? 'time TBD')
        : 'time TBD';
      const jobLabel = job.job_number ? `${job.job_number} — ${job.name}` : job.name;
      const where = job.address ? `\n${job.address}` : '';

      const reminders: { offsetMs: number; title: string; body: string }[] = [
        {
          offsetMs: 24 * 3_600_000,
          title: 'Job tomorrow',
          body: `${jobLabel} starts tomorrow (${timeLabel}).${where}`,
        },
        {
          offsetMs: 3_600_000,
          title: 'Job in 1 hour',
          body: `${jobLabel} starts in 1 hour (${timeLabel}).${where}`,
        },
      ];

      for (const reminder of reminders) {
        const fireAt = start.getTime() - reminder.offsetMs;
        if (fireAt <= now + 60_000) continue; // already past (or about to be)
        await Notifications.scheduleNotificationAsync({
          content: {
            title: reminder.title,
            body: reminder.body,
            data: { type: REMINDER_TYPE, jobId: job.id },
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: new Date(fireAt),
          },
        });
      }
    }
  } catch {
    // best-effort
  }
}

/**
 * Register this device's Expo push token under the signed-in employee so
 * future server-side triggers (payment received, contract signed, …) can
 * reach them. Safe to call on every sign-in; upserts by token.
 */
export async function registerPushToken(email: string): Promise<void> {
  if (Platform.OS === 'web') return;
  if (!(await ensurePermission())) return;
  try {
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) return;
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!token) return;
    await supabase.from('push_tokens').upsert(
      {
        company: COMPANY,
        email: email.toLowerCase(),
        token,
        platform: Platform.OS,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'token' },
    );
  } catch {
    // best-effort — the push_tokens table may not exist until migration 9 runs
  }
}
