/**
 * The Lead map's Storms layer (2026-10-09; reworked same day) — what the map
 * draws, platform-free.
 *
 * Storms are picked from a LIST, in two categories:
 *   Hail  one storm = hail ≥ 1 inch on one Central-time day
 *   Wind  one storm = damaging-wind reports on one Central-time day
 * Each storm's IMPACT ZONE is a 3-mile circle around every report — the same
 * rule the Storm reports use for "in the path" — coloured by hail size (wind:
 * one colour). Picking a storm highlights the pins inside its zone and fades
 * the rest. The overviews (7 days … 2 years) draw every storm's zone in the
 * window at once.
 *
 *   radar     live NEXRAD radar tiles (drawn by the map itself)
 *   warnings  active NWS Severe Thunderstorm / Tornado warnings (MO + KS)
 *   reports   NOAA SPC reports (storm_reports)
 */

import { fetchStormReports, hailLabel, type StormReport } from '@/lib/storms';

export const ZONE_MILES = 3;
export const ZONE_METERS = ZONE_MILES * 1609.344;
export const MIN_HAIL = 1;

export type StormKind = 'hail' | 'wind';

export interface StormWarning {
  id: string;
  label: string;
  tornado: boolean;
  /** Rings of [lat, lng]. */
  rings: [number, number][][];
}

export interface StormReportPoint {
  id: string;
  kind: StormKind;
  size: number | null;
  lat: number;
  lng: number;
  day: string;
  label: string;
}

/** One storm day in one category, with who is in its path. */
export interface MapStorm {
  key: string; // `${kind}:${day}`
  kind: StormKind;
  day: string;
  maxSize: number | null;
  place: string | null;
  reports: StormReportPoint[];
  affected: string[]; // map point keys within ZONE_MILES
}

export interface StormLayers {
  radar: boolean;
  warnings: StormWarning[];
  /** Report dots + zones to draw. */
  reports: StormReportPoint[];
  /** Pins to highlight (in the path); null = no storm picked, nothing fades. */
  highlight: Set<string> | null;
  /** Changes only when the map should zoom to `reports` (a storm was picked). */
  fitKey: string | null;
}

export type StormWindow = '7d' | '30d' | '6m' | '1y' | '2y';

export const STORM_WINDOWS: { key: StormWindow; label: string; days: number }[] = [
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '6m', label: '6 months', days: 182 },
  { key: '1y', label: '1 year', days: 365 },
  { key: '2y', label: '2 years', days: 730 },
];

/** Zone colour by hail size (wind: orange). */
export function zoneColor(r: { kind: StormKind; size: number | null }): string {
  if (r.kind === 'wind') return '#FF8C1A';
  const s = r.size ?? 1;
  if (s >= 2.5) return '#E5484D';
  if (s >= 1.5) return '#F5A524';
  return '#F2D33D';
}

export const ZONE_LEGEND: { color: string; label: string }[] = [
  { color: '#F2D33D', label: '1–1.5 in' },
  { color: '#F5A524', label: '1.5–2.5 in' },
  { color: '#E5484D', label: '2.5 in +' },
];

function miles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

function reportLabel(r: StormReport): string {
  const when = new Date(r.occurredAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const what = r.kind === 'hail' ? `${hailLabel(r.size)} hail` : r.size ? `${r.size} mph wind` : 'Damaging wind';
  return `${what} · ${when}${r.location ? ` · ${r.location}` : ''}`;
}

/** Two years of reports, once per session (they change every 30 min at most). */
let cache: { at: number; reports: StormReportPoint[] } | null = null;
export async function loadAllReports(): Promise<StormReportPoint[]> {
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.reports;
  const to = new Date();
  const from = new Date(to.getTime() - 731 * 86400000);
  const reports = (await fetchStormReports(from, to)).map((r) => ({
    id: r.id,
    kind: r.kind,
    size: r.size,
    lat: r.lat,
    lng: r.lng,
    day: r.day,
    label: reportLabel(r),
  }));
  cache = { at: Date.now(), reports };
  return reports;
}

/** Points (lat/lng + key) within the zone of any of these reports. */
export function inPath(points: { key: string; lat: number; lng: number }[], reports: StormReportPoint[]): string[] {
  const out: string[] = [];
  for (const p of points) {
    for (const r of reports) {
      if (Math.abs(r.lat - p.lat) > 0.06 || Math.abs(r.lng - p.lng) > 0.08) continue;
      if (miles(p.lat, p.lng, r.lat, r.lng) <= ZONE_MILES) {
        out.push(p.key);
        break;
      }
    }
  }
  return out;
}

/** Group reports into storms (one per category per day), newest first. */
export function groupStorms(
  reports: StormReportPoint[],
  points: { key: string; lat: number; lng: number }[],
): MapStorm[] {
  const byKey = new Map<string, StormReportPoint[]>();
  for (const r of reports) {
    if (r.kind === 'hail' && (r.size ?? 0) < MIN_HAIL) continue;
    const key = `${r.kind}:${r.day}`;
    const list = byKey.get(key) ?? [];
    list.push(r);
    byKey.set(key, list);
  }
  const storms: MapStorm[] = [];
  for (const [key, list] of byKey) {
    const [kind, day] = key.split(':') as [StormKind, string];
    const sizes = list.map((r) => r.size).filter((s): s is number => s != null);
    const biggest = list.reduce((a, b) => ((b.size ?? 0) > (a.size ?? 0) ? b : a), list[0]);
    storms.push({
      key,
      kind,
      day,
      maxSize: sizes.length ? Math.max(...sizes) : null,
      place: biggest.label.split(' · ')[2] ?? null,
      reports: list,
      affected: inPath(points, list),
    });
  }
  return storms.sort((a, b) => b.day.localeCompare(a.day));
}

/** Active severe thunderstorm / tornado warnings over Missouri and Kansas. */
export async function loadWarnings(): Promise<StormWarning[]> {
  try {
    const res = await fetch(
      'https://api.weather.gov/alerts/active?area=MO,KS&event=Severe%20Thunderstorm%20Warning,Tornado%20Warning',
      { headers: { Accept: 'application/geo+json' } },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      features?: { id: string; geometry: { type: string; coordinates: number[][][] } | null; properties: { event: string; expires?: string } }[];
    };
    const out: StormWarning[] = [];
    for (const f of data.features ?? []) {
      if (!f.geometry || f.geometry.type !== 'Polygon') continue;
      const until = f.properties.expires
        ? ` until ${new Date(f.properties.expires).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
        : '';
      out.push({
        id: f.id,
        label: `${f.properties.event}${until}`,
        tornado: f.properties.event.startsWith('Tornado'),
        rings: f.geometry.coordinates.map((ring) => ring.map(([lng, lat]) => [lat, lng] as [number, number])),
      });
    }
    return out;
  } catch {
    return [];
  }
}
