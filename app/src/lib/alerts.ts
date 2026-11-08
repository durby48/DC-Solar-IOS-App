/**
 * Alerts (2026-11-08) — the in-app list of every push this person was sent.
 *
 * The `notify` edge function writes one `notifications` row per recipient
 * for every push it sends (and for people with no registered phone, so the
 * web and permission-less phones see them too). RLS: you read and mark only
 * your own rows (supabase/migrations/2026-11-08_notifications_overhaul.sql).
 *
 * The unread count is ONE shared live value (realtime on `notifications` +
 * a refresh whenever the app returns to the foreground) read by every bell
 * through `useUnreadAlerts()`, and mirrored onto the app icon badge.
 */

import * as Notifications from 'expo-notifications';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';

import { parseNotificationTarget, type NotificationTarget } from '@/lib/notificationTargets';
import { supabase } from '@/lib/supabase';

export interface AlertRow {
  id: string;
  title: string;
  body: string;
  target: NotificationTarget | null;
  source: string | null;
  createdAt: string;
  readAt: string | null;
}

export async function fetchAlerts(limit = 100): Promise<{ status: 'ok'; alerts: AlertRow[] } | { status: 'error'; message: string }> {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('id, title, body, target, source, created_at, read_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return { status: 'error', message: error.message };
    return {
      status: 'ok',
      alerts: ((data ?? []) as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        title: String(r.title ?? ''),
        body: String(r.body ?? ''),
        target: parseNotificationTarget(r.target),
        source: (r.source as string | null) ?? null,
        createdAt: String(r.created_at),
        readAt: (r.read_at as string | null) ?? null,
      })),
    };
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : 'Could not load alerts' };
  }
}

/** Mark some (ids) or all (null) of my alerts read. */
export async function markAlertsRead(ids: string[] | null): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('mark_notifications_read', { p_ids: ids });
    if (!error) void refreshUnreadAlerts();
    return !error;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The shared unread count
// ---------------------------------------------------------------------------

const store = { unread: 0 };
const subscribers = new Set<() => void>();
let users = 0;
let channel: ReturnType<typeof supabase.channel> | null = null;
let appStateSub: { remove: () => void } | null = null;
let authSub: { unsubscribe: () => void } | null = null;
let channelSeq = 0;

function publish(n: number): void {
  if (n === store.unread) return;
  store.unread = n;
  for (const fn of subscribers) fn();
  if (Platform.OS !== 'web') void Notifications.setBadgeCountAsync(n).catch(() => {});
}

export async function refreshUnreadAlerts(): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      publish(0);
      return;
    }
    const { count, error } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .is('read_at', null);
    if (!error && typeof count === 'number') publish(count);
  } catch {
    // Keep the last value; the next refresh tries again.
  }
}

function subscribeLive(): void {
  if (channel) {
    void supabase.removeChannel(channel);
    channel = null;
  }
  channelSeq += 1;
  try {
    // RLS limits what realtime delivers to this person's own rows.
    const next = supabase
      .channel(`alerts-${channelSeq}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, () => {
        void refreshUnreadAlerts();
      });
    next.subscribe();
    channel = next;
  } catch {
    // No live updates: foreground refreshes still cover it.
  }
}

function start(): void {
  users += 1;
  if (users > 1) return;
  void refreshUnreadAlerts();
  subscribeLive();
  appStateSub = AppState.addEventListener('change', (state) => {
    if (state === 'active') void refreshUnreadAlerts();
  });
  const { data } = supabase.auth.onAuthStateChange(() => {
    subscribeLive();
    void refreshUnreadAlerts();
  });
  authSub = data.subscription;
}

function stop(): void {
  users -= 1;
  if (users > 0) return;
  appStateSub?.remove();
  appStateSub = null;
  authSub?.unsubscribe();
  authSub = null;
  if (channel) void supabase.removeChannel(channel);
  channel = null;
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

function snapshot(): number {
  return store.unread;
}

/** The live unread Alerts count (shared by every bell). */
export function useUnreadAlerts(): number {
  const n = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    start();
    return stop;
  }, []);
  return n;
}
