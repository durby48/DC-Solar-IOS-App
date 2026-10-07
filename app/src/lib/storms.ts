/**
 * Storm coverage (2026-10-09) — hail after-care. The data and the rules are
 * in the database (2026-10-09_storms.sql) and the `storm-sync` edge function:
 * NOAA hail / wind reports within 150 miles of Kansas City (2 years), a
 * STORM = hail ≥ 1 inch on one Central-time day, a HIT = a lead / customer
 * within 3 miles of it. Every read here is an RPC that scopes to the caller:
 * admins and the sales manager see everyone; a rep their own leads and
 * customers.
 */

import { supabase } from '@/lib/supabase';

export interface Storm {
  day: string; // YYYY-MM-DD (Central)
  maxHail: number | null;
  places: string[];
  hailReports: number;
  leads: number;
  customers: number;
  checkedAt: string | null;
}

export interface StormHit {
  kind: 'lead' | 'customer';
  recordId: string;
  name: string;
  address: string | null;
  miles: number;
  hailSize: number | null;
  owner: string | null;
  status: string | null;
  checkedAt: string | null;
  phone: string | null;
}

export interface StormReport {
  id: string;
  kind: 'hail' | 'wind';
  size: number | null;
  occurredAt: string;
  day: string;
  lat: number;
  lng: number;
  location: string | null;
  county: string | null;
  state: string | null;
}

export async function fetchStorms(): Promise<Storm[]> {
  const { data, error } = await supabase.rpc('storm_list', { p_limit: 200 });
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map((r) => ({
    day: String(r.storm_day),
    maxHail: r.max_hail == null ? null : Number(r.max_hail),
    places: (r.places as string[] | null) ?? [],
    hailReports: Number(r.hail_reports ?? 0),
    leads: Number(r.leads ?? 0),
    customers: Number(r.customers ?? 0),
    checkedAt: (r.checked_at as string | null) ?? null,
  }));
}

export async function fetchStormHits(day: string): Promise<StormHit[]> {
  const { data, error } = await supabase.rpc('storm_detail', { p_day: day });
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map((r) => ({
    kind: r.kind as 'lead' | 'customer',
    recordId: String(r.record_id),
    name: String(r.name ?? 'Unnamed'),
    address: (r.address as string | null) ?? null,
    miles: Number(r.miles ?? 0),
    hailSize: r.hail_size == null ? null : Number(r.hail_size),
    owner: (r.owner as string | null) ?? null,
    status: (r.status as string | null) ?? null,
    checkedAt: (r.checked_at as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
  }));
}

export async function checkStormHit(day: string, kind: 'lead' | 'customer', id: string, on: boolean) {
  const { error } = await supabase.rpc('storm_check_hit', { p_day: day, p_kind: kind, p_id: id, p_on: on });
  return error ? { ok: false as const, message: error.message } : { ok: true as const };
}

/** The whole storm handled — closes its Storm check task. Admins / sales manager. */
export async function markStormChecked(day: string, on: boolean) {
  const { error } = await supabase.rpc('storm_mark_checked', { p_day: day, p_on: on });
  return error ? { ok: false as const, message: error.message } : { ok: true as const };
}

/** Hail / wind reports in a time window, for the map's Storms layer. */
export async function fetchStormReports(from: Date, to: Date): Promise<StormReport[]> {
  const { data, error } = await supabase.rpc('storm_reports_range', {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    kind: r.kind as 'hail' | 'wind',
    size: r.size == null ? null : Number(r.size),
    occurredAt: String(r.occurred_at),
    day: String(r.storm_day),
    lat: Number(r.lat),
    lng: Number(r.lng),
    location: (r.location as string | null) ?? null,
    county: (r.county as string | null) ?? null,
    state: (r.state as string | null) ?? null,
  }));
}

/** "Aug 19, 2026" from 'YYYY-MM-DD' (no timezone shift). */
export function stormDayLabel(day: string, withYear = true): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

/** 1.75 → "1.75 in", 1 → "1 in" */
export function hailLabel(size: number | null | undefined): string {
  if (size == null) return 'hail';
  return `${Number(size.toFixed(2))} in`;
}

/** A record's last hail, from its last_hail_* columns: "Aug 19, 2026 · 1.75 in · 1.2 mi". */
export function lastHailLabel(at: string | null | undefined, size: number | null | undefined, miles: number | null | undefined): string | null {
  if (!at) return null;
  const d = new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return [d, hailLabel(size ?? null), miles != null ? `${Number(miles).toFixed(1)} mi away` : null].filter(Boolean).join(' · ');
}

/** Within the last N days? */
export function hailWithin(at: string | null | undefined, days: number, now = Date.now()): boolean {
  if (!at) return false;
  return now - new Date(at).getTime() <= days * 86400000;
}

/** The saved text "Storm check" fills — editable before sending. */
export function stormCheckText(day: string): string {
  return `Hi, this is DC Solar. Hail came through your area on ${stormDayLabel(day, false)}. Want us to come check your solar panels? Just reply and we'll set it up.`;
}
