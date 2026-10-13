/**
 * The Lead map's Storms layer — what the map draws, platform-free.
 *
 * HAIL = RADAR SWATHS (2026-10-12, Devon). Each hail storm is a Central day of
 * NOAA MRMS radar hail (MESH) over the ten coverage counties, contoured into
 * bands (0.75″ … 3″) by storm-sync and stored in hail_swaths. The map fills
 * each band in its colour, outlines the coverage, and the ≥ 1″ shapes are
 * AREAS: tap inside one and the screen lists only the prospects, leads and
 * customers inside it (pointIn / pointsInArea below). The storm list itself is
 * storm_list() — the same storms (and counts) as the Storm reports.
 *
 * WIND stays as it was (2026-10-09): one storm = damaging-wind SPC reports on
 * one Central day, each report's 3-mile zone in orange.
 *
 *   radar     live NEXRAD radar tiles (drawn by the map itself)
 *   warnings  active NWS Severe Thunderstorm / Tornado warnings (MO + KS)
 *   reports   NOAA SPC spotter reports (dots; ground truth)
 */

import { fetchStormReports, hailLabel, type StormReport, type SwathRow } from '@/lib/storms';

export const ZONE_MILES = 3;
export const ZONE_METERS = ZONE_MILES * 1609.344;
/** The hit threshold, inches — storm_min_hail() in the database. */
export const MIN_HAIL = 1;

export type StormKind = 'hail' | 'wind';
export type LatLng = [number, number];

/** Where a map is looking — passed to the full-screen map so it opens right there. */
export interface MapViewState {
  lat: number;
  lng: number;
  zoom: number;
}

export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

export interface StormWarning {
  id: string;
  label: string;
  tornado: boolean;
  /** Rings of [lat, lng]. */
  rings: LatLng[][];
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

/** One filled swath polygon (one band, one shape). */
export interface SwathShape {
  id: string;
  day: string;
  band: number;
  /** Outer ring first, then holes. */
  rings: LatLng[][];
}

/** A tappable ≥ 1″ swath area and the biggest hail inside it. */
export interface SwathArea {
  id: string;
  day: string;
  rings: LatLng[][];
  maxBand: number;
  bounds: Bounds;
}

/** One storm day in one category, for the list. */
export interface MapStorm {
  key: string; // `${kind}:${day}`
  kind: StormKind;
  day: string;
  maxSize: number | null;
  place: string | null;
  /** Wind: its reports. Hail: none (drawn from swaths). */
  reports: StormReportPoint[];
  /** How many leads + customers it hit (hail: storm_list; wind: pins within 3 mi). */
  affectedCount: number;
  /** Wind only: the map point keys within 3 mi. */
  affected: string[];
}

export interface StormLayers {
  radar: boolean;
  warnings: StormWarning[];
  /** Report dots to draw. */
  reports: StormReportPoint[];
  /** Draw a 3-mile zone around each report (wind only). */
  zones: boolean;
  /** Filled radar swaths, smallest band first. */
  swaths: SwathShape[];
  /** The ≥ 1″ areas (a tapped one is outlined). */
  areas: SwathArea[];
  selectedArea: string | null;
  /** The coverage counties' outline. */
  coverage: LatLng[][];
  /** Pins to highlight; null = nothing fades. */
  highlight: Set<string> | null;
  /** Changes only when the map should zoom to `fitBounds` (a storm was picked). */
  fitKey: string | null;
  fitBounds: Bounds | null;
}

export type StormWindow = '7d' | '30d' | '6m' | '1y' | '2y';

export const STORM_WINDOWS: { key: StormWindow; label: string; days: number }[] = [
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '6m', label: '6 months', days: 182 },
  { key: '1y', label: '1 year', days: 365 },
  { key: '2y', label: '2 years', days: 730 },
];

/** Swath colour by band (inches) — the usual hail-map ramp. */
const BAND_COLORS: [number, string][] = [
  [4, '#4B1F70'],
  [3, '#8E3FBF'],
  [2.5, '#C2306E'],
  [2, '#E5484D'],
  [1.75, '#EF6F2E'],
  [1.5, '#F5962B'],
  [1.25, '#F5B82E'],
  [1, '#F2D33D'],
  [0.75, '#7CC66B'],
];
export function bandColor(band: number): string {
  for (const [b, c] of BAND_COLORS) if (band >= b) return c;
  return '#7CC66B';
}

/** Report dot colour (wind: orange). */
export function zoneColor(r: { kind: StormKind; size: number | null }): string {
  if (r.kind === 'wind') return '#FF8C1A';
  return bandColor(r.size ?? 1);
}

/** The hail legend (radar bands). Kept as ZONE_LEGEND for the screens that import it. */
export const SWATH_LEGEND: { color: string; label: string }[] = [
  { color: '#7CC66B', label: '¾″' },
  { color: '#F2D33D', label: '1″' },
  { color: '#F5962B', label: '1½″' },
  { color: '#E5484D', label: '2″' },
  { color: '#C2306E', label: '2½″' },
  { color: '#4B1F70', label: '4″+' },
];
export const ZONE_LEGEND = SWATH_LEGEND;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function inRing(lat: number, lng: number, ring: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i];
    const [yj, xj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside the outer ring and outside every hole. */
export function pointIn(lat: number, lng: number, rings: LatLng[][]): boolean {
  if (!rings.length || !inRing(lat, lng, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) if (inRing(lat, lng, rings[h])) return false;
  return true;
}

function boundsOf(rings: LatLng[][]): Bounds {
  const b = { north: -90, south: 90, east: -180, west: 180 };
  for (const [lat, lng] of rings[0] ?? []) {
    b.north = Math.max(b.north, lat);
    b.south = Math.min(b.south, lat);
    b.east = Math.max(b.east, lng);
    b.west = Math.min(b.west, lng);
  }
  return b;
}

export function mergeBounds(list: Bounds[]): Bounds | null {
  if (!list.length) return null;
  return list.reduce((a, b) => ({
    north: Math.max(a.north, b.north),
    south: Math.min(a.south, b.south),
    east: Math.max(a.east, b.east),
    west: Math.min(a.west, b.west),
  }));
}

function inBounds(lat: number, lng: number, b: Bounds): boolean {
  return lat <= b.north && lat >= b.south && lng <= b.east && lng >= b.west;
}

/** Swath rows → one shape per polygon, smallest band first (so bigger hail draws on top). */
export function swathShapes(rows: SwathRow[]): SwathShape[] {
  const out: SwathShape[] = [];
  for (const r of rows) r.polygons.forEach((rings, i) => out.push({ id: `${r.day}|${r.band}|${i}`, day: r.day, band: r.band, rings }));
  return out.sort((a, b) => a.band - b.band || a.day.localeCompare(b.day));
}

/** The ≥ 1″ shapes as tappable areas, each with the biggest band inside it. */
export function swathAreas(shapes: SwathShape[]): SwathArea[] {
  const base = shapes.filter((s) => s.band === MIN_HAIL);
  return base.map((s) => {
    const bounds = boundsOf(s.rings);
    let maxBand = s.band;
    for (const t of shapes) {
      if (t.day !== s.day || t.band <= maxBand) continue;
      const [lat, lng] = t.rings[0]?.[0] ?? [0, 0];
      if (inBounds(lat, lng, bounds) && pointIn(lat, lng, s.rings)) maxBand = t.band;
    }
    return { id: s.id, day: s.day, rings: s.rings, maxBand, bounds };
  });
}

/** The area under a tap — the most recent storm wins where swaths overlap. */
export function areaAt(areas: SwathArea[], lat: number, lng: number): SwathArea | null {
  const hits = areas.filter((a) => inBounds(lat, lng, a.bounds) && pointIn(lat, lng, a.rings));
  return hits.sort((a, b) => b.day.localeCompare(a.day))[0] ?? null;
}

/** Pins inside one area. */
export function pointsInArea<P extends { lat: number; lng: number }>(area: SwathArea, points: P[]): P[] {
  return points.filter((p) => inBounds(p.lat, p.lng, area.bounds) && pointIn(p.lat, p.lng, area.rings));
}

/** Pin keys inside any of these areas. */
export function keysInAreas(areas: SwathArea[], points: { key: string; lat: number; lng: number }[]): Set<string> {
  const out = new Set<string>();
  for (const p of points) {
    if (areas.some((a) => inBounds(p.lat, p.lng, a.bounds) && pointIn(p.lat, p.lng, a.rings))) out.add(p.key);
  }
  return out;
}

/** The radar hail at a point on a day: the biggest band whose shape covers it. */
export function hailAt(shapes: SwathShape[], day: string, lat: number, lng: number): number | null {
  let best: number | null = null;
  for (const s of shapes) {
    if (s.day !== day || (best !== null && s.band <= best)) continue;
    if (pointIn(lat, lng, s.rings)) best = s.band;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Reports (dots) + wind storms
// ---------------------------------------------------------------------------

function miles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

function reportLabel(r: StormReport): string {
  const when = new Date(r.occurredAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  // Entered news reports (id 'manual|…', e.g. Parkville 4″ on 2026-03-10) are labelled as such.
  const source = r.id.startsWith('manual|') ? 'news report' : 'spotter';
  const what = r.kind === 'hail' ? `${hailLabel(r.size)} hail (${source})` : r.size ? `${r.size} mph wind` : 'Damaging wind';
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

/** Points (lat/lng + key) within 3 miles of any of these reports (wind). */
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

/** Wind reports grouped into storms (one per Central day), newest first. */
export function groupWindStorms(reports: StormReportPoint[], points: { key: string; lat: number; lng: number }[]): MapStorm[] {
  const byDay = new Map<string, StormReportPoint[]>();
  for (const r of reports) {
    if (r.kind !== 'wind') continue;
    const list = byDay.get(r.day) ?? [];
    list.push(r);
    byDay.set(r.day, list);
  }
  const storms: MapStorm[] = [];
  for (const [day, list] of byDay) {
    const sizes = list.map((r) => r.size).filter((s): s is number => s != null);
    const affected = inPath(points, list);
    storms.push({
      key: `wind:${day}`,
      kind: 'wind',
      day,
      maxSize: sizes.length ? Math.max(...sizes) : null,
      place: list[0]?.label.split(' · ')[2] ?? null,
      reports: list,
      affected,
      affectedCount: affected.length,
    });
  }
  return storms.sort((a, b) => b.day.localeCompare(a.day));
}

export function reportBounds(reports: StormReportPoint[]): Bounds | null {
  if (!reports.length) return null;
  return {
    north: Math.max(...reports.map((r) => r.lat)),
    south: Math.min(...reports.map((r) => r.lat)),
    east: Math.max(...reports.map((r) => r.lng)),
    west: Math.min(...reports.map((r) => r.lng)),
  };
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
        rings: f.geometry.coordinates.map((ring) => ring.map(([lng, lat]) => [lat, lng] as LatLng)),
      });
    }
    return out;
  } catch {
    return [];
  }
}
