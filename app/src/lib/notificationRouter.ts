/**
 * The ONE place a notification tap turns into navigation (2026-09-08).
 *
 * Before this existed a tap only brought the app to the front: pushes had no
 * `data`, and nothing listened for the response. Now:
 *
 *   tap → parseNotificationTarget(data) → routeForTarget() → router.push()
 *
 * and the same path serves every case:
 *   - the app is open (response listener)
 *   - the app is in the background (same listener, on resume)
 *   - the app was terminated (`getLastNotificationResponseAsync` on launch)
 *   - the on-device job reminders (their data folds into `job`)
 *
 * COLD START IS THE HARD CASE. On launch nothing is ready: expo-router has no
 * navigation state yet, the session has not been read, and `app/index.tsx`
 * is about to `replace()` the login route with the tabs. Navigating during
 * that dance loses the push or gets overwritten by the replace. So the
 * target is QUEUED and released only when three things are true: the root
 * navigator has a key, a session exists, and the pathname has left `/` (the
 * login/index route) — which is exactly when index.tsx has finished landing
 * the person in the app. A tap while signed out waits through the login and
 * then continues to the record.
 *
 * FAILS SOFT. A target the router cannot place goes to the nearest sensible
 * screen; a record that no longer exists is the destination screen's
 * problem, and every one of those screens already has its own "not found"
 * state. Nothing here can throw into React.
 */

import * as Notifications from 'expo-notifications';
import { router, usePathname, useRootNavigationState } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { reportDiagnostic } from '@/lib/diagnostics';
import { parseNotificationTarget, type NotificationTarget } from '@/lib/notificationTargets';
import { supabase } from '@/lib/supabase';

export interface Route {
  pathname: string;
  params?: Record<string, string>;
}

function compact(params: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v) out[k] = v;
  return out;
}

/** Where a target goes. The routes are the phone's screens; none is web-only. */
export function routeForTarget(target: NotificationTarget): Route {
  switch (target.type) {
    case 'sms_thread':
      return {
        pathname: '/messages/thread',
        params: compact({
          customerId: target.customerId,
          leadId: target.leadId,
          contactId: target.contactId,
          phone: target.phone,
          name: target.name,
        }),
      };
    case 'call':
      // A missed call is a CALL LOG entry, not a conversation: Phone →
      // Recents, opened on the Missed segment. (Routing this into the SMS
      // thread was the 2026-09-08 misroute.)
      return { pathname: '/phone/recents', params: { segment: 'missed' } };
    case 'lead':
      return { pathname: '/leads/[id]', params: { id: target.leadId } };
    case 'customer':
      return { pathname: '/crm/[id]', params: { id: target.customerId } };
    case 'job':
      return { pathname: '/job/[id]', params: { id: target.jobId } };
    case 'task':
      // Tasks live on the record they belong to (the CRM workspace is web
      // only); a task with no record lands on Home.
      if (target.leadId) return { pathname: '/leads/[id]', params: { id: target.leadId } };
      if (target.customerId) return { pathname: '/crm/[id]', params: { id: target.customerId } };
      return { pathname: '/(tabs)' };
    case 'appointment':
      if (target.leadId) return { pathname: '/leads/[id]', params: { id: target.leadId } };
      return { pathname: '/(tabs)/calendar' };
  }
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

interface Pending {
  id: string;
  target: NotificationTarget;
}

let pending: Pending | null = null;
const handled = new Set<string>();
const listeners = new Set<() => void>();

function notifyListeners(): void {
  for (const fn of listeners) fn();
}

/** Queue a response's target (once per response), or ignore it. */
function enqueue(response: Notifications.NotificationResponse | null | undefined): void {
  if (!response) return;
  const id = response.notification.request.identifier;
  if (handled.has(id)) return;
  const data = response.notification.request.content.data;
  const target = parseNotificationTarget(data);
  if (!target) {
    handled.add(id);
    reportDiagnostic('notification_tap', false, {
      reason: 'no target',
      dataType: typeof (data as { type?: unknown } | null)?.type === 'string' ? String((data as { type?: unknown }).type) : null,
    });
    return;
  }
  pending = { id, target };
  reportDiagnostic('notification_tap', null, { stage: 'queued', targetType: target.type });
  notifyListeners();
}

/** Navigate to a target now. Exported for the incoming-call path and tests. */
export function navigateToTarget(target: NotificationTarget): void {
  const route = routeForTarget(target);
  try {
    router.push({ pathname: route.pathname, params: route.params ?? {} } as never);
    reportDiagnostic('notification_tap', true, { targetType: target.type, route: route.pathname });
  } catch (e) {
    reportDiagnostic('notification_tap', false, {
      targetType: target.type,
      route: route.pathname,
      error: e instanceof Error ? e.message : String(e),
    });
    try {
      router.replace('/(tabs)' as never);
    } catch {
      // Nothing sensible left to do; the app is still on a real screen.
    }
  }
}

/**
 * Mount ONCE, in the root layout. Listens for taps, reads the launch
 * response, and releases the queue when the app is ready for it.
 */
export function useNotificationRouting(): void {
  const navState = useRootNavigationState();
  const pathname = usePathname();
  const [sessionReady, setSessionReady] = useState(false);
  const [version, setVersion] = useState(0);

  // Listen for taps (foreground + background) and read the cold-start tap.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const bump = () => setVersion((v) => v + 1);
    listeners.add(bump);
    const sub = Notifications.addNotificationResponseReceivedListener(enqueue);
    void Notifications.getLastNotificationResponseAsync()
      .then(enqueue)
      .catch(() => {
        // No launch response, or the module is unavailable: nothing queued.
      });
    return () => {
      listeners.delete(bump);
      sub.remove();
    };
  }, []);

  // Know whether someone is signed in.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let cancelled = false;
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!cancelled) setSessionReady(Boolean(data.session));
      })
      .catch(() => {});
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!cancelled) setSessionReady(Boolean(session));
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  // Release the queue when the router, the session and the landing are all done.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (!pending) return;
    const navReady = Boolean(navState?.key);
    const landed = pathname !== '/' && pathname !== '';
    if (!navReady || !sessionReady || !landed) return;
    const next = pending;
    pending = null;
    handled.add(next.id);
    // One tick after landing, so a `replace()` still in flight cannot bury it.
    const timer = setTimeout(() => navigateToTarget(next.target), 150);
    return () => clearTimeout(timer);
  }, [navState?.key, pathname, sessionReady, version]);
}
