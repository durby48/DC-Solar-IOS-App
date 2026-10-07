// storm-sync (2026-10-09) — NOAA storm reports → storms, hits, alerts.
//
// Called by pg_cron with header `x-storm-secret: <STORM_SYNC_SECRET>`:
//   { mode: 'sync' }     every 30 min: today's and yesterday's SPC reports;
//                        a storm with someone in its path that has not been
//                        announced yet → one push per person + one Storm
//                        check task (for the sales manager).
//   { mode: 'summary' }  7 AM Central: yesterday's storm, once.
//   { mode: 'backfill', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
//                        history (no alerts, no tasks).
//
// SPC files: https://www.spc.noaa.gov/climo/reports/YYMMDD_rpts_filtered_{hail,wind}.csv
// — one per convective day (12Z → 12Z), times in UTC (HHMM; < 1200 = the
// next UTC date). Hail size is in hundredths of an inch; wind in mph or UNK.
// Only reports within 150 miles of Kansas City are kept.
//
// The rules (≥ 1 inch, 3 miles, grouping by Central-time day) live in the
// database: storm_recompute_day() — see 2026-10-09_storms.sql.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const COMPANY = 'dc-solar';
const KC = { lat: 39.0997, lng: -94.5786 };
const REGION_MILES = 150;
const SPC = 'https://www.spc.noaa.gov/climo/reports';

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function miles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

/** 'YYYY-MM-DD' (a UTC date) → 'YYMMDD'. */
function yymmdd(iso: string): string {
  return iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The Central-time calendar date of an instant. */
function centralDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

interface Row {
  id: string;
  company: string;
  kind: 'hail' | 'wind';
  size: number | null;
  occurred_at: string;
  storm_day: string;
  lat: number;
  lng: number;
  location: string | null;
  county: string | null;
  state: string | null;
  comments: string | null;
}

/** One SPC file → rows inside the region. */
async function fetchDay(convDay: string, kind: 'hail' | 'wind'): Promise<Row[]> {
  const res = await fetch(`${SPC}/${yymmdd(convDay)}_rpts_filtered_${kind}.csv`, {
    headers: { 'user-agent': 'DC Solar KC storm sync (app.dcsolarkc.com)' },
  });
  if (!res.ok) return [];
  const text = await res.text();
  const out: Row[] = [];
  for (const line of text.split('\n').slice(1)) {
    if (!line.trim()) continue;
    const parts = line.split(',');
    if (parts.length < 7) continue;
    const [time, sizeRaw, location, county, state, latRaw, lngRaw] = parts;
    const comments = parts.slice(7).join(',').trim() || null;
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (miles(KC.lat, KC.lng, lat, lng) > REGION_MILES) continue;
    const hhmm = time.trim().padStart(4, '0');
    const date = Number(hhmm) < 1200 ? addDays(convDay, 1) : convDay;
    const at = new Date(`${date}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00Z`);
    if (Number.isNaN(at.getTime())) continue;
    const n = Number(sizeRaw);
    const size = Number.isFinite(n) ? (kind === 'hail' ? n / 100 : n) : null;
    out.push({
      id: `${kind}|${at.toISOString()}|${lat.toFixed(3)}|${lng.toFixed(3)}`,
      company: COMPANY,
      kind,
      size,
      occurred_at: at.toISOString(),
      storm_day: centralDay(at),
      lat,
      lng,
      location: location?.trim() || null,
      county: county?.trim() || null,
      state: state?.trim() || null,
      comments: comments ? comments.slice(0, 500) : null,
    });
  }
  return out;
}

async function ingest(admin: SupabaseClient, convDays: string[]): Promise<Set<string>> {
  const rows: Row[] = [];
  for (const d of convDays) {
    const [hail, wind] = await Promise.all([fetchDay(d, 'hail'), fetchDay(d, 'wind')]);
    rows.push(...hail, ...wind);
  }
  // SPC files can list the same report twice; one row per id per batch.
  const unique = [...new Map(rows.map((r) => [r.id, r])).values()];
  rows.length = 0;
  rows.push(...unique);
  const days = new Set<string>();
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await admin.from('storm_reports').upsert(chunk, { onConflict: 'id' });
    if (error) throw new Error(`storm_reports upsert: ${error.message}`);
  }
  for (const r of rows) if (r.kind === 'hail') days.add(r.storm_day);
  for (const day of days) {
    const { error } = await admin.rpc('storm_recompute_day', { p_day: day });
    if (error) throw new Error(`storm_recompute_day ${day}: ${error.message}`);
  }
  return days;
}

function dayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

async function push(title: string, body: string, emails: string[], day: string): Promise<void> {
  const secret = Deno.env.get('NOTIFY_SECRET');
  const url = Deno.env.get('SUPABASE_URL');
  if (!secret || !url || emails.length === 0) return;
  await fetch(`${url}/functions/v1/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-notify-secret': secret },
    body: JSON.stringify({ title, body, emails, pref: 'storms', target: { type: 'storm', day } }),
  }).catch(() => {});
}

interface StormRow {
  storm_day: string;
  max_hail: number | null;
  places: string[];
  lead_count: number;
  customer_count: number;
  alerted_at: string | null;
  summary_sent_at: string | null;
  task_id: string | null;
}

function where(s: StormRow): string {
  const p = (s.places ?? []).slice(0, 2).join(', ');
  return p ? ` near ${p}` : '';
}

function counts(leads: number, customers: number): string {
  const parts: string[] = [];
  if (leads) parts.push(`${leads} lead${leads === 1 ? '' : 's'}`);
  if (customers) parts.push(`${customers} customer${customers === 1 ? '' : 's'}`);
  return parts.join(' and ');
}

/** One push per person: everything for admins / the manager, their own for a rep. */
async function announce(admin: SupabaseClient, s: StormRow, kind: 'alert' | 'summary'): Promise<number> {
  const { data } = await admin.rpc('storm_alert_targets', { p_day: s.storm_day });
  const targets = (data ?? []) as { email: string; scope: 'all' | 'own'; leads: number; customers: number }[];
  const size = s.max_hail ? `${Number(s.max_hail).toFixed(2).replace(/0$/, '')} in` : '';
  let sent = 0;
  for (const t of targets) {
    if (t.leads + t.customers === 0) continue;
    const what = counts(t.leads, t.customers);
    const title =
      kind === 'alert'
        ? `🌩️ Hail ${size}${where(s)}`
        : `🌩️ Yesterday's hail (${dayLabel(s.storm_day)}): up to ${size}`;
    const body =
      t.scope === 'all'
        ? `${what} in the path. Open the Storm report to assign leads and check customers.`
        : `${what} of yours ${t.leads + t.customers === 1 ? 'is' : 'are'} in the path.`;
    await push(title, body, [t.email], s.storm_day);
    sent += 1;
  }
  return sent;
}

/** ONE Storm check task per storm, for the sales manager (else the owner). */
async function ensureTask(admin: SupabaseClient, s: StormRow): Promise<void> {
  if (s.task_id) return;
  const { data: people } = await admin
    .from('employees')
    .select('email, role')
    .eq('company', COMPANY)
    .in('role', ['sales_manager', 'owner'])
    .eq('is_test', false);
  const list = (people ?? []) as { email: string; role: string }[];
  const who = (list.find((p) => p.role === 'sales_manager') ?? list.find((p) => p.role === 'owner'))?.email?.toLowerCase();
  if (!who) return;
  const what = counts(s.lead_count, s.customer_count) || 'nobody yet';
  const { data: task, error } = await admin
    .from('tasks')
    .insert({
      company: COMPANY,
      title: `Storm check: ${dayLabel(s.storm_day)} hail · ${what}`,
      notes: `Hail up to ${s.max_hail ?? '?'} in${where(s)}. Open Storm reports → ${dayLabel(s.storm_day)} to assign the leads and check the customers.`,
      due_at: new Date().toISOString(),
      assigned_to: who,
      // Same person as the assignee, so the "task for you" push does not double the storm alert.
      created_by: who,
    })
    .select('id')
    .single();
  if (!error && task) {
    await admin.from('storms').update({ task_id: (task as { id: string }).id }).eq('storm_day', s.storm_day);
  }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });
  const secret = Deno.env.get('STORM_SYNC_SECRET');
  if (!secret || req.headers.get('x-storm-secret') !== secret) return json(401, { error: 'unauthorized' });

  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return json(500, { error: 'missing environment' });
  const admin = createClient(url, key);

  const body = (await req.json().catch(() => ({}))) as { mode?: string; from?: string; to?: string };
  const mode = body.mode ?? 'sync';

  try {
    if (mode === 'backfill') {
      const from = body.from ?? '';
      const to = body.to ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return json(400, { error: 'from/to' });
      const conv: string[] = [];
      for (let d = from; d <= to; d = addDays(d, 1)) conv.push(d);
      if (conv.length > 45) return json(400, { error: 'at most 45 days per call' });
      const days = await ingest(admin, conv);
      // History never alerts.
      if (days.size) {
        await admin
          .from('storms')
          .update({ alerted_at: new Date().toISOString(), summary_sent_at: new Date().toISOString() })
          .in('storm_day', [...days])
          .is('alerted_at', null);
      }
      return json(200, { ok: true, days: days.size });
    }

    const now = new Date();
    const today = centralDay(now);

    if (mode === 'summary') {
      const yesterday = addDays(today, -1);
      const { data } = await admin.from('storms').select('*').eq('storm_day', yesterday).maybeSingle();
      const s = data as StormRow | null;
      if (!s || s.summary_sent_at || s.lead_count + s.customer_count === 0) return json(200, { ok: true, summary: false });
      await ensureTask(admin, s);
      const sent = await announce(admin, s, 'summary');
      await admin.from('storms').update({ summary_sent_at: now.toISOString(), alerted_at: s.alerted_at ?? now.toISOString() }).eq('storm_day', yesterday);
      return json(200, { ok: true, summary: true, sent });
    }

    // sync: the current and previous convective days
    const conv0 = new Date(now.getTime() - 12 * 3600 * 1000).toISOString().slice(0, 10);
    await ingest(admin, [addDays(conv0, -1), conv0]);
    const { data: fresh } = await admin
      .from('storms')
      .select('*')
      .is('alerted_at', null)
      .gte('storm_day', addDays(today, -1));
    let alerted = 0;
    for (const s of (fresh ?? []) as StormRow[]) {
      if (s.lead_count + s.customer_count === 0) continue;
      await ensureTask(admin, s);
      alerted += await announce(admin, s, 'alert');
      await admin.from('storms').update({ alerted_at: now.toISOString() }).eq('storm_day', s.storm_day);
    }
    return json(200, { ok: true, alerted });
  } catch (e) {
    return json(500, { error: e instanceof Error ? e.message : 'failed' });
  }
});
