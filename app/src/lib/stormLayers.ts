/**
 * The Lead map's Storms layer (2026-10-09): what the map draws, platform-free.
 *
 *   radar     live NEXRAD radar tiles (drawn by the map itself)
 *   warnings  active NWS Severe Thunderstorm / Tornado warnings for Missouri
 *             and Kansas, as polygons (api.weather.gov — public, no key)
 *   reports   NOAA hail / wind reports in the chosen window (storm_reports)
 *   fitTo     points to zoom to (a storm opened from its Storm report)
 */

import { fetchStormReports, hailLabel, type StormReport } from '@/lib/storms';

export interface StormWarning {
  id: string;
  label: string;
  tornado: boolean;
  /** Rings of [lat, lng]. */
  rings: [number, number][][];
}

export interface StormReportPoint {
  id: string;
  kind: 'hail' | 'wind';
  size: number | null;
  lat: number;
  lng: number;
  label: string;
}

export interface StormLayers {
  radar: boolean;
  warnings: StormWarning[];
  reports: StormReportPoint[];
  fitTo?: { lat: number; lng: number }[];
}

export type StormWindow = '24h' | '7d' | '30d' | '1y' | '2y';

export const STORM_WINDOWS: { key: StormWindow; label: string; days: number }[] = [
  { key: '24h', label: '24 hours', days: 1 },
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '1y', label: '1 year', days: 365 },
  { key: '2y', label: '2 years', days: 730 },
];

function reportLabel(r: StormReport): string {
  const when = new Date(r.occurredAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const what = r.kind === 'hail' ? `${hailLabel(r.size)} hail` : r.size ? `${r.size} mph wind` : 'Damaging wind';
  return `${what} · ${when}${r.location ? ` · ${r.location}` : ''}`;
}

export function toPoints(reports: StormReport[]): StormReportPoint[] {
  return reports.map((r) => ({ id: r.id, kind: r.kind, size: r.size, lat: r.lat, lng: r.lng, label: reportLabel(r) }));
}

/** Reports in the last N days. */
export async function loadReportsWindow(days: number): Promise<StormReportPoint[]> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  return toPoints(await fetchStormReports(from, to));
}

/** One storm day's reports (a Central-time day), hail first. */
export async function loadReportsForDay(day: string): Promise<StormReportPoint[]> {
  const from = new Date(`${day}T05:00:00Z`);
  const to = new Date(from.getTime() + 25 * 3600 * 1000);
  return toPoints((await fetchStormReports(from, to)).filter((r) => r.day === day));
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
      features?: { id: string; geometry: { type: string; coordinates: number[][][] } | null; properties: { event: string; areaDesc?: string; expires?: string } }[];
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
