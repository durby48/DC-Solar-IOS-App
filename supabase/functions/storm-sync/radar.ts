// NOAA MRMS radar hail (MESH) → swath polygons for the coverage counties.
// (2026-10-12; see 2026-10-12_hail_swaths.sql for the whole picture.)
//
// FILES: the public AWS bucket noaa-mrms-pds, e.g.
//   CONUS/MESH_Max_1440min_00.50/20260820/MRMS_MESH_Max_1440min_00.50_20260820-050000.grib2.gz
// gzip → GRIB2 edition 2, grid template 3.0 (lat/lon, 0.01°, 7000 × 3500 from
// 54.995 N / 129.995 W, rows north → south), data template 5.41 = one 16-bit
// grayscale PNG; value (mm) = (R + X · 2^E) / 10^D, ≤ 0 = no hail / no data.
//
// SPEED: the PNG is inflated as a STREAM and stops at the last row of the crop
// (~1,700 of 3,500 rows); only the crop's columns are kept. ~0.1 s per file —
// inside an edge function's CPU budget.

import { contours } from 'npm:d3-contour@4.0.2';

export const MRMS = 'https://noaa-mrms-pds.s3.amazonaws.com';

/** The crop: the ten coverage counties (38.45–39.53 N, 95.50–93.48 W) plus a margin. */
export const CROP = { north: 39.6, south: 38.38, west: -95.56, east: -93.42 };

/** Swath steps, inches. A hit needs >= storm_min_hail() (1 in) in the database. */
export const BANDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

const MM_PER_IN = 25.4;

export interface Grid {
  width: number;
  height: number;
  /** Centre of the top-left cell. */
  lat0: number;
  lon0: number;
  step: number;
  /** MESH in millimetres, row-major, north → south. */
  mm: Uint8Array;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Keys under a prefix (one page, ascending), optionally after `startAfter`. */
export async function listKeys(prefix: string, startAfter?: string, max = 1000): Promise<string[]> {
  const q = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': String(max) });
  if (startAfter) q.set('start-after', startAfter);
  const res = await fetch(`${MRMS}/?${q}`);
  if (!res.ok) return [];
  const xml = await res.text();
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
}

/** "MRMS_…_20260820-050000.grib2.gz" → its UTC time. */
export function keyTime(key: string): Date | null {
  const m = key.match(/_(\d{8})-(\d{6})\.grib2\.gz$/);
  if (!m) return null;
  const [d, t] = [m[1], m[2]];
  return new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`);
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}
function hms(d: Date): string {
  return d.toISOString().slice(11, 19).replaceAll(':', '');
}

/** The first file of a product at or after `at` (within `withinMin`), or null. */
export async function fileAtOrAfter(product: string, at: Date, withinMin = 40): Promise<string | null> {
  const prefix = `CONUS/${product}/${ymd(at)}/`;
  const startAfter = `${prefix}MRMS_${product}_${ymd(at)}-${hms(new Date(at.getTime() - 1000))}.grib2.gz`;
  const keys = await listKeys(prefix, startAfter, 30);
  for (const k of keys) {
    const t = keyTime(k);
    if (t && t >= at && t.getTime() - at.getTime() <= withinMin * 60000) return k;
  }
  return null;
}

/** The newest file of a product, looking back up to `lookbackMin`. */
export async function latestFile(product: string, now: Date, lookbackMin = 30): Promise<string | null> {
  const from = new Date(now.getTime() - lookbackMin * 60000);
  const days = ymd(from) === ymd(now) ? [now] : [from, now];
  let best: string | null = null;
  for (const d of days) {
    const prefix = `CONUS/${product}/${ymd(d)}/`;
    const after = d === now && ymd(from) === ymd(now) ? `${prefix}MRMS_${product}_${ymd(from)}-${hms(from)}.grib2.gz` : undefined;
    const keys = await listKeys(prefix, after);
    if (keys.length) best = keys[keys.length - 1];
  }
  return best;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function fetchGrib(key: string): Promise<Uint8Array> {
  const res = await fetch(`${MRMS}/${key}`);
  if (!res.ok) throw new Error(`MRMS ${res.status} for ${key}`);
  return await gunzip(new Uint8Array(await res.arrayBuffer()));
}

// ---------------------------------------------------------------------------
// GRIB2 (only what MRMS uses)
// ---------------------------------------------------------------------------

/** GRIB's scale factors are sign-and-magnitude, not two's complement. */
function signMag16(v: DataView, o: number): number {
  const raw = v.getUint16(o);
  return raw & 0x8000 ? -(raw & 0x7fff) : raw;
}
function signMag32(v: DataView, o: number): number {
  const raw = v.getUint32(o);
  return raw & 0x80000000 ? -(raw & 0x7fffffff) : raw;
}

/** Decode the crop of one MESH file into millimetres. */
export async function decodeCrop(buf: Uint8Array): Promise<Grid> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (String.fromCharCode(...buf.subarray(0, 4)) !== 'GRIB' || buf[7] !== 2) throw new Error('not GRIB2');
  const sec: Record<number, number> = {};
  let o = 16;
  while (o < buf.length - 4) {
    if (buf[o] === 0x37 && buf[o + 1] === 0x37 && buf[o + 2] === 0x37 && buf[o + 3] === 0x37) break; // "7777"
    const len = view.getUint32(o);
    sec[buf[o + 4]] = o;
    o += len;
  }
  const g = sec[3], r = sec[5], d = sec[7];
  if (g === undefined || r === undefined || d === undefined) throw new Error('GRIB2 sections missing');
  if (view.getUint16(g + 12) !== 0) throw new Error('grid is not lat/lon');
  if (view.getUint16(r + 9) !== 41) throw new Error('data is not PNG-packed');
  const Ni = view.getUint32(g + 30);
  const Nj = view.getUint32(g + 34);
  const la1 = signMag32(view, g + 46) / 1e6;
  const lo1 = view.getUint32(g + 50) / 1e6 - 360;
  const step = view.getUint32(g + 63) / 1e6;
  const R = view.getFloat32(r + 11);
  const E = signMag16(view, r + 15);
  const D = signMag16(view, r + 17);
  const bits = buf[r + 19];
  const row0 = Math.max(0, Math.floor((la1 - CROP.north) / step));
  const row1 = Math.min(Nj - 1, Math.ceil((la1 - CROP.south) / step));
  const col0 = Math.max(0, Math.floor((CROP.west - lo1) / step));
  const col1 = Math.min(Ni - 1, Math.ceil((CROP.east - lo1) / step));
  const W = col1 - col0 + 1;
  const H = row1 - row0 + 1;
  const crop = { width: W, height: H, lat0: la1 - row0 * step, lon0: lo1 + col0 * step, step };
  // 0 bits = every cell equals R (a quiet day): no image to read.
  if (bits === 0) {
    const v = R / Math.pow(10, D);
    return { ...crop, mm: new Uint8Array(W * H).fill(v <= 0 ? 0 : Math.min(255, Math.round(v))) };
  }
  // NOAA packs a quiet day in 8 bits, a stormy one in 16.
  if (bits !== 8 && bits !== 16) throw new Error(`unexpected ${bits}-bit PNG`);
  const bpp = bits / 8;

  // PNG inside section 7: gather IDAT.
  const pngStart = d + 5;
  const pngLen = view.getUint32(d) - 5;
  const png = buf.subarray(pngStart, pngStart + pngLen);
  const pv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let p = 8;
  let width = 0;
  const idat: Uint8Array[] = [];
  while (p < png.length) {
    const len = pv.getUint32(p);
    const type = String.fromCharCode(png[p + 4], png[p + 5], png[p + 6], png[p + 7]);
    if (type === 'IHDR') width = pv.getUint32(p + 8);
    else if (type === 'IDAT') idat.push(png.subarray(p + 8, p + 8 + len));
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (width !== Ni) throw new Error('PNG width does not match the grid');

  const stride = Ni * bpp;
  const need = (row1 + 1) * (stride + 1);

  // Inflate only as far as the crop's last row.
  const reader = new Blob(idat as BlobPart[]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const raw = new Uint8Array(need);
  let have = 0;
  while (have < need) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.length, need - have);
    raw.set(value.subarray(0, take), have);
    have += take;
  }
  await reader.cancel().catch(() => {});
  if (have < need) throw new Error('PNG ended early');

  const scaleE = Math.pow(2, E);
  const scaleD = Math.pow(10, D);
  const mm = new Uint8Array(W * H);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y <= row1; y++) {
    const off = y * (stride + 1);
    const ft = raw[off];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const v = raw[off + 1 + x];
      let f: number;
      if (ft === 0) f = v;
      else if (ft === 1) f = v + a;
      else if (ft === 2) f = v + b;
      else if (ft === 3) f = v + ((a + b) >> 1);
      else {
        const c = x >= bpp ? prev[x - bpp] : 0;
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        f = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      cur[x] = f & 255;
    }
    if (y >= row0) {
      const base = (y - row0) * W;
      for (let x = 0; x < W; x++) {
        const i = (col0 + x) * bpp;
        const X = bpp === 2 ? (cur[i] << 8) | cur[i + 1] : cur[i];
        const value = (R + X * scaleE) / scaleD;
        mm[base + x] = value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value);
      }
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return { ...crop, mm };
}

// ---------------------------------------------------------------------------
// Swaths
// ---------------------------------------------------------------------------

export function maxInches(grid: Grid): number {
  let m = 0;
  for (let i = 0; i < grid.mm.length; i++) if (grid.mm[i] > m) m = grid.mm[i];
  return Math.round((m / MM_PER_IN) * 100) / 100;
}

/** Signed ring area in grid cells (shoelace). */
function ringArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  return Math.abs(a / 2);
}

/** Contour the grid into one MultiPolygon per band (lon/lat). Speckles under ~2 km² are dropped. */
export function swathBands(grid: Grid): { band: number; geometry: { type: 'MultiPolygon'; coordinates: number[][][][] } }[] {
  const values = Array.from(grid.mm);
  const generator = contours().size([grid.width, grid.height]).thresholds(BANDS.map((b) => b * MM_PER_IN));
  const out: { band: number; geometry: { type: 'MultiPolygon'; coordinates: number[][][][] } }[] = [];
  const toLonLat = ([x, y]: number[]) => [
    Math.round((grid.lon0 + (x - 0.5) * grid.step) * 1e5) / 1e5,
    Math.round((grid.lat0 - (y - 0.5) * grid.step) * 1e5) / 1e5,
  ];
  for (const g of generator(values)) {
    const polys = (g.coordinates as number[][][][])
      .filter((poly) => poly.length && ringArea(poly[0]) >= 2)
      .map((poly) => [poly[0], ...poly.slice(1).filter((hole) => ringArea(hole) >= 2)].map((ring) => ring.map(toLonLat)));
    if (polys.length) {
      out.push({ band: Math.round((g.value / MM_PER_IN) * 100) / 100, geometry: { type: 'MultiPolygon', coordinates: polys } });
    }
  }
  return out;
}

/**
 * GROUND TRUTH (2026-10-12, the March 10 Parkville storm): MESH can badly
 * undersize giant hail — that evening radar said ~1–1.7″ where spotters
 * measured 3–4.5″ (KSHB: 4″ in Parkville). So hail REPORTS raise the grid,
 * never lower it:
 *   within RAISE_MILES of a report, every cell where radar shows hail
 *   (≥ 0.5″) goes up to the reported size;
 *   within CORE_MILES of the report, every cell does (the spotter saw it there).
 */
export const RAISE_MILES = 3;
export const CORE_MILES = 1;

export interface GroundReport {
  lat: number;
  lng: number;
  /** Inches. */
  size: number;
}

export function applyReports(grid: Grid, reports: GroundReport[]): number {
  const kmPerDegLat = 111.2;
  let raised = 0;
  for (const r of reports) {
    if (!(r.size >= 0.75)) continue;
    const sizeMm = Math.min(255, Math.round(r.size * MM_PER_IN));
    const kmPerDegLng = kmPerDegLat * Math.cos((r.lat * Math.PI) / 180);
    const raiseKm = RAISE_MILES * 1.609344;
    const coreKm = CORE_MILES * 1.609344;
    const dy = Math.ceil(raiseKm / kmPerDegLat / grid.step);
    const dx = Math.ceil(raiseKm / kmPerDegLng / grid.step);
    const cy = Math.round((grid.lat0 - r.lat) / grid.step);
    const cx = Math.round((r.lng - grid.lon0) / grid.step);
    for (let y = Math.max(0, cy - dy); y <= Math.min(grid.height - 1, cy + dy); y++) {
      for (let x = Math.max(0, cx - dx); x <= Math.min(grid.width - 1, cx + dx); x++) {
        const km = Math.hypot((y - cy) * grid.step * kmPerDegLat, (x - cx) * grid.step * kmPerDegLng);
        if (km > raiseKm) continue;
        const i = y * grid.width + x;
        if (grid.mm[i] >= sizeMm) continue;
        if (km <= coreKm || grid.mm[i] >= 0.5 * MM_PER_IN) {
          grid.mm[i] = sizeMm;
          raised++;
        }
      }
    }
  }
  return raised;
}

/** Cell-wise max of two grids with the same crop. */
export function mergeMax(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] > b[i] ? a[i] : b[i];
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
