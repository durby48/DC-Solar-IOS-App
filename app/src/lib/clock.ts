/**
 * Time-clock helpers — Supabase-backed clock in/out with GPS stamps.
 * All punches degrade gracefully: GPS is best-effort (never blocks the punch)
 * and network failures surface as { ok: false } so screens can fall back to
 * the local AsyncStorage punch.
 */

import * as Location from 'expo-location';

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';
const GPS_TIMEOUT_MS = 5000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TimeEntry {
  id: string;
  created_at: string;
  company: string;
  employee: string;
  job_id: string | null;
  clock_in: string;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  clock_in_accuracy: number | null;
  clock_out: string | null;
  clock_out_lat: number | null;
  clock_out_lng: number | null;
  clock_out_accuracy: number | null;
  note: string | null;
}

export type ClockResult =
  | { ok: true; entry: TimeEntry }
  | { ok: false; message: string };

interface GpsStamp {
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  /** 'no GPS permission' | 'GPS timeout' when coords are unavailable. */
  note: string | null;
}

/** Email of the signed-in employee, or null when signed out / demo mode. */
export async function getSessionEmail(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.user?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * The employee's currently open punch (clock_out is null), newest first.
 * Server state is the source of truth for the clock card.
 */
export async function fetchOpenEntry(email: string): Promise<TimeEntry | null> {
  try {
    const { data, error } = await supabase
      .from('time_entries')
      .select('*')
      .eq('employee', email)
      .is('clock_out', null)
      .order('clock_in', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    return data as TimeEntry;
  } catch {
    return null;
  }
}

/**
 * Best-effort GPS fix: ask foreground permission, then race a Balanced-accuracy
 * fix against a ~5s timeout. Never throws and never blocks the punch — returns
 * nulls plus a note when unavailable.
 */
async function captureGps(): Promise<GpsStamp> {
  const none = (note: string): GpsStamp => ({
    lat: null,
    lng: null,
    accuracy: null,
    note,
  });
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return none('no GPS permission');

    const position = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), GPS_TIMEOUT_MS)),
    ]);
    if (!position) return none('GPS timeout');

    return {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy ?? null,
      note: null,
    };
  } catch {
    return none('GPS timeout');
  }
}

/**
 * Insert a clock-in punch for the signed-in employee. `jobId` may be a mock
 * (non-uuid) id; those are recorded in the note instead of the uuid column.
 */
export async function clockIn(params: {
  email: string;
  jobId: string | null;
  jobLabel?: string | null;
}): Promise<ClockResult> {
  const { email, jobId, jobLabel } = params;
  const gps = await captureGps();

  const validJobId = jobId !== null && UUID_RE.test(jobId) ? jobId : null;
  const notes: string[] = [];
  if (gps.note) notes.push(gps.note);
  if (jobId !== null && validJobId === null && jobLabel) notes.push(`job: ${jobLabel}`);

  try {
    const { data, error } = await supabase
      .from('time_entries')
      .insert({
        company: COMPANY,
        employee: email,
        job_id: validJobId,
        clock_in: new Date().toISOString(),
        clock_in_lat: gps.lat,
        clock_in_lng: gps.lng,
        clock_in_accuracy: gps.accuracy,
        note: notes.length > 0 ? notes.join('; ') : null,
      })
      .select('*')
      .single();

    if (error || !data) {
      return { ok: false, message: error?.message ?? 'Could not save the punch.' };
    }
    return { ok: true, entry: data as TimeEntry };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the punch.' };
  }
}

/**
 * Seconds worked today across the employee's COMPLETED punches (open punches
 * are excluded — the caller adds live elapsed time itself). Zero on error.
 */
export async function fetchTodayCompletedSeconds(email: string): Promise<number> {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const { data, error } = await supabase
      .from('time_entries')
      .select('clock_in, clock_out')
      .eq('company', COMPANY)
      .eq('employee', email)
      .gte('clock_in', startOfDay.toISOString())
      .not('clock_out', 'is', null);
    if (error || !data) return 0;
    let seconds = 0;
    for (const row of data as { clock_in: string; clock_out: string }[]) {
      const ms = new Date(row.clock_out).getTime() - new Date(row.clock_in).getTime();
      if (Number.isFinite(ms) && ms > 0) seconds += ms / 1000;
    }
    return seconds;
  } catch {
    return 0;
  }
}

/** Close an open punch with a clock-out timestamp and fresh best-effort coords. */
export async function clockOut(entry: TimeEntry): Promise<ClockResult> {
  const gps = await captureGps();

  const notes = [entry.note, gps.note ? `clock out: ${gps.note}` : null].filter(
    (n): n is string => n !== null && n.length > 0,
  );

  try {
    const { data, error } = await supabase
      .from('time_entries')
      .update({
        clock_out: new Date().toISOString(),
        clock_out_lat: gps.lat,
        clock_out_lng: gps.lng,
        clock_out_accuracy: gps.accuracy,
        note: notes.length > 0 ? notes.join('; ') : null,
      })
      .eq('id', entry.id)
      .select('*')
      .single();

    if (error || !data) {
      return { ok: false, message: error?.message ?? 'Could not save the punch.' };
    }
    return { ok: true, entry: data as TimeEntry };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the punch.' };
  }
}
