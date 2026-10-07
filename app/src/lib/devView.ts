/**
 * Developer Tools (2026-10-08) — the actions behind "view as", the view log,
 * phone reports and the test tools. The current view itself lives in
 * `lib/devViewState.ts`; the database side is `2026-10-08_developer.sql`.
 *
 * A view is saved on the device and the app restarts into it, so every screen
 * and cache starts fresh as the viewed role/person; "Back to my view" clears
 * it and restarts again. A saved view ends by itself after 4 hours, or when
 * a different person signs in.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';
import { DevSettings, Platform } from 'react-native';

import {
  getDevView,
  setDevViewState,
  type DevView,
  type ViewRole,
} from '@/lib/devViewState';
import { getRealSession, supabase } from '@/lib/supabase';

const KEY = 'dc.devView.v1';
const MAX_AGE_MS = 4 * 60 * 60 * 1000;

async function save(next: DevView | null): Promise<void> {
  try {
    if (next) await AsyncStorage.setItem(KEY, JSON.stringify(next));
    else await AsyncStorage.removeItem(KEY);
  } catch {
    // Storage unavailable (private window): the view just won't survive the restart.
  }
}

/** Read the saved view at launch. Never throws; always settles the state. */
async function loadDevView(): Promise<void> {
  let next: DevView | null = null;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    next = raw ? (JSON.parse(raw) as DevView) : null;
    if (next) {
      const { data } = await getRealSession();
      const me = data.session?.user?.email?.toLowerCase() ?? null;
      const stale = Date.now() - next.startedAt > MAX_AGE_MS || !me || me !== next.by.toLowerCase();
      if (stale) {
        const logId = next.logId;
        next = null;
        await save(null);
        setDevViewState(null);
        if (logId && me) void supabase.rpc('dev_view_end', { p_id: logId });
        return;
      }
    }
  } catch {
    next = null;
  }
  setDevViewState(next);
}

void loadDevView();

// Signing out ends any view.
supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT' && getDevView()) {
    void save(null);
    setDevViewState(null);
  }
});

/** Restart the app so every screen loads fresh in the new view. */
function restart(): void {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.location.assign('/');
    return;
  }
  void Updates.reloadAsync().catch(() => DevSettings.reload());
}

async function myEmail(): Promise<string | null> {
  const { data } = await getRealSession();
  return data.session?.user?.email?.toLowerCase() ?? null;
}

export type DevResult = { ok: true } | { ok: false; message: string };

/** Show the screens of another role, with your own data. */
export async function startRoleView(role: ViewRole): Promise<DevResult> {
  const by = await myEmail();
  if (!by) return { ok: false, message: 'Not signed in.' };
  const { data, error } = await supabase.rpc('dev_view_start', { p_kind: 'role', p_role: role });
  if (error) return { ok: false, message: error.message };
  await endCurrentLog();
  await save({ kind: 'role', role, by, logId: (data as { id?: string } | null)?.id ?? null, startedAt: Date.now() });
  restart();
  return { ok: true };
}

/** Look through someone's eyes: their screens and data, look-only. */
export async function startPersonView(email: string): Promise<DevResult> {
  const by = await myEmail();
  if (!by) return { ok: false, message: 'Not signed in.' };
  const { data, error } = await supabase.rpc('dev_view_start', { p_kind: 'person', p_email: email });
  if (error) return { ok: false, message: error.message };
  const row = data as { id: string; email: string; name: string; role: ViewRole; uid: string | null };
  await endCurrentLog();
  await save({
    kind: 'person',
    by,
    email: row.email,
    name: row.name,
    role: row.role,
    uid: row.uid,
    logId: row.id,
    startedAt: Date.now(),
  });
  restart();
  return { ok: true };
}

async function endCurrentLog(): Promise<void> {
  const logId = getDevView()?.logId;
  if (logId) await supabase.rpc('dev_view_end', { p_id: logId });
}

/** Back to my normal view. */
export async function leaveDevView(): Promise<void> {
  await endCurrentLog().catch(() => {});
  await save(null);
  restart();
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface PickPerson {
  email: string;
  name: string;
  role: ViewRole;
  isTest: boolean;
}

/** Everyone a developer can view as (employees is admin-read; a developer is an admin). */
export async function fetchPeople(): Promise<PickPerson[]> {
  // dev_people(): developer-gated, so it works in the normal view too
  // (employees is admin-read, and a developer is an admin only in a role view).
  const { data } = await supabase.rpc('dev_people');
  return ((data ?? []) as { email: string; display_name: string | null; role: ViewRole; is_test: boolean | null }[]).map(
    (r) => ({ email: r.email, name: r.display_name ?? r.email, role: r.role, isTest: Boolean(r.is_test) }),
  );
}

export interface ViewLogEntry {
  id: string;
  developerEmail: string;
  kind: 'role' | 'person';
  targetRole: ViewRole | null;
  targetName: string | null;
  startedAt: string;
  endedAt: string | null;
}

export async function fetchViewLog(): Promise<ViewLogEntry[]> {
  const { data } = await supabase
    .from('dev_view_log')
    .select('id, developer_email, kind, target_role, target_name, started_at, ended_at')
    .order('started_at', { ascending: false })
    .limit(40);
  return ((data ?? []) as Record<string, string | null>[]).map((r) => ({
    id: r.id as string,
    developerEmail: r.developer_email as string,
    kind: r.kind as 'role' | 'person',
    targetRole: r.target_role as ViewRole | null,
    targetName: r.target_name,
    startedAt: r.started_at as string,
    endedAt: r.ended_at,
  }));
}

export interface PhoneReport {
  email: string;
  name: string;
  role: ViewRole;
  platform: string | null;
  appVersion: string | null;
  runtime: string | null;
  lastSeen: string | null;
  problems7d: number;
  lastProblemAt: string | null;
}

export async function fetchPhoneReports(): Promise<PhoneReport[]> {
  const { data } = await supabase.rpc('dev_phone_reports');
  return ((data ?? []) as Record<string, string | number | null>[]).map((r) => ({
    email: String(r.email),
    name: String(r.display_name),
    role: r.role as ViewRole,
    platform: (r.platform as string | null) ?? null,
    appVersion: (r.app_version as string | null) ?? null,
    runtime: (r.runtime as string | null) ?? null,
    lastSeen: (r.last_seen as string | null) ?? null,
    problems7d: Number(r.problems_7d ?? 0),
    lastProblemAt: (r.last_problem_at as string | null) ?? null,
  }));
}

export interface PhoneEvent {
  id: string;
  kind: string;
  ok: boolean | null;
  detail: Record<string, unknown> | null;
  appVersion: string | null;
  runtime: string | null;
  platform: string | null;
  createdAt: string;
}

/** One person's recent events, newest first. */
export async function fetchPhoneEvents(email: string): Promise<PhoneEvent[]> {
  const { data } = await supabase.rpc('dev_phone_events', { p_email: email });
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    kind: String(r.kind),
    ok: (r.ok as boolean | null) ?? null,
    detail: (r.detail as Record<string, unknown> | null) ?? null,
    appVersion: (r.app_version as string | null) ?? null,
    runtime: (r.runtime as string | null) ?? null,
    platform: (r.platform as string | null) ?? null,
    createdAt: String(r.created_at),
  }));
}

export async function sendTestPush(): Promise<DevResult> {
  const { error } = await supabase.rpc('dev_test_push');
  return error ? { ok: false, message: error.message } : { ok: true };
}

/** Add or remove the Developer tag (developers only — the database checks). */
export async function setDeveloper(email: string, on: boolean): Promise<DevResult> {
  const { error } = await supabase.rpc('set_developer', { p_email: email, p_on: on });
  return error ? { ok: false, message: error.message } : { ok: true };
}
