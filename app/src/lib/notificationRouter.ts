/**
 * The ONE place a notification tap turns into navigation (2026-09-08;
 * rebuilt 2026-11-08).
 *
 *   tap → parseNotificationTarget(data) → routeForTarget(target, role) → router
 *
 * and the same path serves every case:
 *   - the app is open (response listener)
 *   - the app is in the background (same listener, on resume)
 *   - the app was terminated (`getLastNotificationResponse` on launch)
 *   - the on-device job reminders (their data folds into `schedule` / `job`)
 *   - a row tapped in the in-app Alerts list (`openNotificationTarget`)
 *
 * COLD START IS THE HARD CASE. On launch nothing is ready: expo-router has no
 * navigation state yet, the session has not been read, and `app/index.tsx`
 * is about to `replace()` the login route with the tabs. Navigating during
 * that dance loses the push or gets overwritten by the replace. So the
 * target is QUEUED and released only when the session exists and the person
 * has LANDED — decided from `useSegments()` (reactive), not from
 * `useRootNavigationState()`.
 *
 * 2026-11-08 — why every tap was lost:
 *  1. `useRootNavigationState()` called from the root layout returns the
 *     internal Slot navigator's state, whose one route is `__root`. "Landed"
 *     was therefore ALWAYS true; the tap was pushed over the login screen
 *     and index.tsx's `replace('/(tabs)')` then replaced the pushed record
 *     with Home.
 *  2. The pending tap was dequeued BEFORE a 150 ms timer whose effect
 *     cleanup cleared it, so any re-render in that window dropped it.
 *  3. The launch response was never cleared, so a JS reload (View as…,
 *     applying an update) replayed the last tap.
 * Now: landed = segments say we are past login; the tap stays queued until
 * the timer actually fires; the launch response is cleared once taken.
 *
 * ROLE-AWARE DESTINATIONS. Records open in the CRM workspace (texts on the
 * conversation pane) for admins and sales alike — the sales app is confined
 * to `/workspace`, `/schedule`, `/recents` and friends (lib/salesConfinement),
 * so a rep's tap must land inside that list or it would be bounced.
 *
 * FAILS SOFT. A target the router cannot place goes to the nearest sensible
 * screen; a record that no longer exists is the destination screen's
 * problem. Nothing here can throw into React.
 */

import * as Notifications from 'expo-notifications';
import { router, useSegments } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Platform } from 'react-native';

import { reportDiagnostic } from '@/lib/diagnostics';
import { parseNotificationTarget, type NotificationTarget } from '@/lib/notificationTargets';
import { getRole, type RoleInfo } from '@/lib/role';
import { supabase } from '@/lib/supabase';

export interface Route {
  pathname: string;
  params?: Record<string, string>;
}

/** What the routing needs to know about the person who tapped. */
export interface TapperRole {
  isAdmin: boolean;
  isSales: boolean;
}

function compact(params: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) if (v) out[k] = v;
  return out;
}

/** The CRM workspace record key (lib/crmWorkspace.ts: `customer:<id>` / `lead:<id>`). */
function recordKey(customerId?: string, leadId?: string): string | null {
  if (customerId) return `customer:${customerId}`;
  if (leadId) return `lead:${leadId}`;
  return null;
}

function workspace(key: string, channel?: 'sms' | 'email'): Route {
  return { pathname: '/workspace', params: compact({ open: key, channel }) };
}

/** The calendar for this person, on `day`. */
function calendarOn(day: string | undefined, who: TapperRole): Route {
  if (who.isSales) return { pathname: '/schedule', params: compact({ day }) };
  return { pathname: '/calendar', params: compact({ day }) };
}

/**
 * Where a target goes, for this person. `null` = no navigation (the test
 * push just confirms receipt).
 */
export function routeForTarget(target: NotificationTarget, who: TapperRole): Route | null {
  switch (target.type) {
    case 'sms_thread': {
      const key = recordKey(target.customerId, target.leadId);
      if (key) return workspace(key, 'sms');
      // A stranger / contact: the stand-alone thread (admins only).
      if (who.isAdmin) {
        return {
          pathname: '/messages/thread',
          params: compact({ contactId: target.contactId, phone: target.phone, name: target.name }),
        };
      }
      return { pathname: '/workspace' };
    }
    case 'call':
      // A missed call is a CALL LOG entry: Recents, on the Missed segment.
      // The sales app has its own top-level Recents (the Phone section is admin).
      return who.isAdmin
        ? { pathname: '/phone/recents', params: { segment: 'missed' } }
        : { pathname: '/recents', params: { segment: 'missed' } };
    case 'lead':
      return workspace(`lead:${target.leadId}`);
    case 'customer':
      return workspace(`customer:${target.customerId}`);
    case 'job':
      return { pathname: '/job/[id]', params: { id: target.jobId } };
    case 'schedule':
      return calendarOn(target.day, who);
    case 'task': {
      const key = recordKey(target.customerId, target.leadId);
      if (key) return workspace(key);
      return { pathname: '/' };
    }
    case 'appointment':
      if (target.day) return calendarOn(target.day, who);
      if (target.leadId) return workspace(`lead:${target.leadId}`);
      return calendarOn(undefined, who);
    case 'storm':
      return { pathname: '/storm-reports/[day]', params: { day: target.day } };
    case 'email_thread':
      return { pathname: '/inbox/[threadId]', params: { threadId: target.threadId } };
    case 'prospects':
      return { pathname: '/workspace', params: { lens: 'prospect' } };
    case 'financials':
      return who.isAdmin ? { pathname: '/financials' } : { pathname: '/' };
    case 'inbox':
      return who.isAdmin ? { pathname: '/inbox' } : { pathname: '/' };
    case 'test':
      return null;
  }
}

function tapperOf(role: RoleInfo | null): TapperRole {
  return { isAdmin: role?.isAdmin === true, isSales: role?.isSales === true };
}

/**
 * Navigate to a target now. Exported for the in-app Alerts list, the
 * incoming-call path and tests.
 */
export async function openNotificationTarget(target: NotificationTarget): Promise<void> {
  if (target.type === 'test') {
    reportDiagnostic('notification_tap', true, { targetType: 'test' });
    Alert.alert('Test notification received', 'Tapping notifications works on this phone.');
    return;
  }
  let route: Route | null = null;
  try {
    route = routeForTarget(target, tapperOf(await getRole()));
    if (!route) return;
    // `navigate` (not `push`) so a tab target JUMPs to the tab with its
    // params instead of stacking a second copy of it.
    router.navigate({ pathname: route.pathname, params: route.params ?? {} } as never);
    reportDiagnostic('notification_tap', true, { targetType: target.type, route: route.pathname });
  } catch (e) {
    reportDiagnostic('notification_tap', false, {
      targetType: target.type,
      route: route?.pathname ?? null,
      error: e instanceof Error ? e.message : String(e),
    });
    try {
      router.replace('/(tabs)' as never);
    } catch {
      // Nothing sensible left to do; the app is still on a real screen.
    }
  }
}

/** @deprecated kept for older call sites — same as openNotificationTarget. */
export function navigateToTarget(target: NotificationTarget): void {
  void openNotificationTarget(target);
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

/**
 * Take the queued tap (and mark it handled) in ONE plain function.
 *
 * 2026-11-08: this used to be inline in the release effect and React
 * Compiler folded the alias back into the module variable, shipping
 * `p=null, d.add(p.id)` — every tap crashed with "Cannot read property 'id'
 * of null". Keep the read-and-clear here, outside any component or hook.
 */
function takePending(): Pending | null {
  const next = pending;
  pending = null;
  if (next) handled.add(next.id);
  return next;
}

function hasPending(): boolean {
  return pending !== null;
}

function notifyListeners(): void {
  for (const fn of listeners) fn();
}

/** Queue a response's target (once per response), or ignore it. */
function enqueue(response: Notifications.NotificationResponse | null | undefined): void {
  if (!response) return;
  const id = response.notification.request.identifier;
  if (handled.has(id)) return;
  // Taken: a JS reload must not replay it (2026-11-08).
  try {
    Notifications.clearLastNotificationResponse();
  } catch {
    // Older native builds: harmless — `handled` still covers this run.
  }
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

/** First route segments that mean "not in the app yet": login and its gates. */
const PRE_LANDING = new Set(['set-password', 'sign-up', 'customer', 'join']);

/** True once the person is on a real app screen (Home is `(tabs)`). */
function landedOn(segments: readonly string[]): boolean {
  // The login route is `app/index.tsx`: no segments at all.
  if (segments.length === 0) return false;
  return !PRE_LANDING.has(segments[0]);
}

/**
 * Mount ONCE, in the root layout. Listens for taps, reads the launch
 * response, and releases the queue when the app is ready for it.
 */
export function useNotificationRouting(): void {
  // Opt out of React Compiler: this hook reads and writes module state
  // (`pending`), which the compiler assumes never changes (see takePending).
  'use no memo';
  const segments = useSegments();
  const [sessionReady, setSessionReady] = useState(false);
  const [version, setVersion] = useState(0);

  // Listen for taps (foreground + background) and read the cold-start tap.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const bump = () => setVersion((v) => v + 1);
    listeners.add(bump);
    const sub = Notifications.addNotificationResponseReceivedListener(enqueue);
    try {
      enqueue(Notifications.getLastNotificationResponse());
    } catch {
      // No launch response, or the module is unavailable: nothing queued.
    }
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

  const segmentKey = segments.join('/');
  const landed = landedOn(segments);

  // Release the queue when the session and the landing are both done.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (!hasPending() || !sessionReady || !landed) return;
    // One beat after landing so a `replace()` still in flight cannot bury
    // it. The tap stays QUEUED until the timer fires: if this effect is torn
    // down first, the next run simply starts a new timer.
    const timer = setTimeout(() => {
      const next = takePending();
      if (next) void openNotificationTarget(next.target);
    }, 250);
    return () => clearTimeout(timer);
  }, [segmentKey, landed, sessionReady, version]);
}
