/**
 * geocode-addresses — put leads and customers on the Lead map (2026-10-07).
 *
 * POST (no body) → { ok, placed, unmatched, remaining }
 *
 * Looks up to BATCH addresses that have no coordinates yet, or whose address
 * changed since the last lookup (address <> geocoded_address), with the US
 * Census geocoder (free, no key, US street addresses) and stores lat / lng /
 * geocode_status. When the Census has no match, OpenStreetMap's Nominatim is
 * asked instead — one request a second, a few per call, per its usage policy
 * — and a street / ZIP / city-level hit is stored as 'approx'. Only when both
 * miss is it 'no_match', not retried until the address is edited. `remaining` tells the Lead map whether to
 * call again.
 *
 * The map screen calls this when it opens, so new and edited addresses get
 * placed without a cron. Callers: any employee (their JWT), or the service
 * role key for a backfill. Writes use the service role; the coordinates are
 * not sensitive beyond the address itself, and every reader is still bound by
 * the tables' RLS.
 *
 * Auth: verify_jwt ON. No secrets beyond the Supabase ones.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const COMPANY = 'dc-solar';
const BATCH = 60;
const CONCURRENCY = 6;

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS_HEADERS } });
}

interface Row {
  table: 'leads' | 'customers';
  id: string;
  address: string;
}

/** Nominatim fallback: house-level → 'ok', anything coarser → 'approx'. */
async function osm(address: string): Promise<{ lat: number; lng: number; exact: boolean } | null> {
  try {
    const res = await fetch(
      'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' + encodeURIComponent(address),
      { headers: { 'User-Agent': 'DC Solar CRM lead map (app.dcsolarkc.com)' }, signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) return null;
    const hit = ((await res.json()) as { lat: string; lon: string; type?: string; addresstype?: string }[])[0];
    if (!hit) return null;
    return { lat: Number(hit.lat), lng: Number(hit.lon), exact: hit.type === 'house' || hit.addresstype === 'building' };
  } catch {
    return null;
  }
}
const OSM_PER_CALL = 5;

async function census(address: string): Promise<{ lat: number; lng: number } | null | 'error'> {
  const url =
    'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=' +
    encodeURIComponent(address);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return 'error';
    const data = (await res.json()) as { result?: { addressMatches?: { coordinates?: { x: number; y: number } }[] } };
    const c = data.result?.addressMatches?.[0]?.coordinates;
    return c ? { lat: c.y, lng: c.x } : null;
  } catch {
    return 'error';
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(supabaseUrl, serviceKey);

    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (jwt !== serviceKey) {
      const { data: userData } = await admin.auth.getUser(jwt);
      const email = userData?.user?.email?.toLowerCase();
      if (!email) return reply(401, { ok: false, error: 'Sign in first.' });
      const { data: employee } = await admin.from('employees').select('role').ilike('email', email).maybeSingle();
      if (!employee) return reply(403, { ok: false, error: 'Staff only.' });
    }

    // Rows needing a lookup: an address, and never looked up or edited since.
    const pending: Row[] = [];
    for (const table of ['leads', 'customers'] as const) {
      const { data } = await admin
        .from(table)
        .select('id, address, geocoded_address')
        .eq('company', COMPANY)
        .not('address', 'is', null)
        .limit(2000);
      for (const r of (data ?? []) as { id: string; address: string | null; geocoded_address: string | null }[]) {
        const address = (r.address ?? '').trim();
        if (address.length < 6 || /^n\/?a$/i.test(address)) continue;
        if (r.geocoded_address === address) continue;
        pending.push({ table, id: r.id, address });
      }
    }

    const batch = pending.slice(0, BATCH);
    let placed = 0;
    let unmatched = 0;
    let failed = 0;
    const misses: Row[] = [];
    for (let i = 0; i < batch.length; i += CONCURRENCY) {
      await Promise.all(
        batch.slice(i, i + CONCURRENCY).map(async (row) => {
          const hit = await census(row.address);
          if (hit === 'error') {
            failed += 1; // leave it pending; the next call retries
            return;
          }
          if (!hit && misses.length < OSM_PER_CALL) {
            misses.push(row); // asked of OpenStreetMap below, one a second
            return;
          }
          await admin
            .from(row.table)
            .update(
              hit
                ? { lat: hit.lat, lng: hit.lng, geocoded_address: row.address, geocode_status: 'ok' }
                : { lat: null, lng: null, geocoded_address: row.address, geocode_status: 'no_match' },
            )
            .eq('id', row.id);
          if (hit) placed += 1;
          else unmatched += 1;
        }),
      );
    }
    for (const row of misses) {
      await new Promise((r) => setTimeout(r, 1100));
      const hit = await osm(row.address);
      await admin
        .from(row.table)
        .update(
          hit
            ? { lat: hit.lat, lng: hit.lng, geocoded_address: row.address, geocode_status: hit.exact ? 'ok' : 'approx' }
            : { lat: null, lng: null, geocoded_address: row.address, geocode_status: 'no_match' },
        )
        .eq('id', row.id);
      if (hit) placed += 1;
      else unmatched += 1;
    }
    return reply(200, { ok: true, placed, unmatched, failed, remaining: pending.length - batch.length + failed });
  } catch (e) {
    return reply(500, { ok: false, error: e instanceof Error ? e.message : 'Unexpected error.' });
  }
});
