import { commercialFitLine, fetchServicePlans, type ServicePlan } from '@/lib/servicePlans';
import { fetchStorms } from '@/lib/storms';

/**
 * The call script, filled in for the person being called (2026-10-12).
 *
 * The script lives in `sales_resources` (kind 'script') and says things like
 * "Hey {{first_name}}, … hit by that storm on {{storm_date}}?". This file
 * works out each field for a lead or customer; `ResourceText` draws the filled
 * values highlighted and anything it could not fill as a highlighted blank, so
 * a rep never reads "{{first_name}}" out loud.
 *
 * Storm date: the record's own last hail (≥ 1 in within 3 miles — the
 * last_hail_* columns kept by storm-sync), as the Central-time day. A record
 * with no hail on file falls back to the newest storm the caller can see
 * (storm_list is already scoped to the rep's own leads).
 */

export type ScriptFields = Record<string, string | null>;

export interface ScriptPerson {
  name: string | null;
  address?: string | null;
  last_hail_at?: string | null;
  last_hail_size?: number | null;
  last_hail_miles?: number | null;
  /** A business (2026-10-12): the commercial script and prices. */
  is_commercial?: boolean;
  panel_count?: number | null;
}

/** The fields a script may use, for the token picker and the docs. */
export const SCRIPT_FIELDS: { token: string; label: string }[] = [
  { token: 'first_name', label: 'Their first name' },
  { token: 'storm_date', label: 'Their storm date' },
  { token: 'storm_detail', label: 'Radar hail at their address (skipped when unknown)' },
  { token: 'street', label: 'Street address' },
  { token: 'rep_first', label: 'Your first name' },
  { token: 'business', label: 'The business / record name' },
  { token: 'panel_count', label: 'Panels on the lead' },
  { token: 'shield_quote', label: 'Commercial tiers that fit the panels (skipped when unknown)' },
];

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** "2026-08-19" → "Tuesday, August 19th" (+ ", 2025" when not this year). */
export function spokenDay(day: string, now = new Date()): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  const weekday = date.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const month = date.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const thisYear = Number(now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }).slice(0, 4));
  return `${weekday}, ${month} ${ordinal(d)}${y !== thisYear ? `, ${y}` : ''}`;
}

/** A timestamp → its Kansas City calendar day, "YYYY-MM-DD" (storm days are Central days). */
export function centralDay(at: string): string {
  return new Date(at).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

/** First word of a name, ignoring a company-looking name ("Acme LLC" stays whole). */
function firstOf(name: string | null | undefined): string | null {
  const n = name?.trim();
  if (!n) return null;
  if (/\b(llc|inc|co|corp|company|church|school|hoa|ltd|group|properties)\b\.?/i.test(n)) return null;
  return n.split(/\s+/)[0] ?? null;
}

let latestStorm: { at: number; day: string | null } | null = null;

/** The newest storm the caller can see, cached for 10 minutes. */
async function newestStormDay(): Promise<string | null> {
  if (latestStorm && Date.now() - latestStorm.at < 10 * 60 * 1000) return latestStorm.day;
  const storms = await fetchStorms();
  const day = storms.map((s) => s.day).sort().pop() ?? null;
  latestStorm = { at: Date.now(), day };
  return day;
}

let plansCache: { at: number; plans: ServicePlan[] } | null = null;

async function plans(): Promise<ServicePlan[]> {
  if (plansCache && Date.now() - plansCache.at < 10 * 60 * 1000) return plansCache.plans;
  const p = await fetchServicePlans();
  plansCache = { at: Date.now(), plans: p };
  return p;
}

/** Fill every script field for one person. Unknown values are null (drawn as a blank). */
export async function scriptFieldsFor(person: ScriptPerson, repName: string | null): Promise<ScriptFields> {
  const ownDay = person.last_hail_at ? centralDay(person.last_hail_at) : null;
  const day = ownDay ?? (await newestStormDay());
  const street = person.address?.split(',')[0]?.trim() || null;

  let detail: string | null = null;
  if (ownDay) {
    const size = person.last_hail_size != null ? `${Number(Number(person.last_hail_size).toFixed(2))}-inch hail` : 'hail';
    // Radar hits (2026-10-12) are AT the address; older report hits had a distance.
    detail =
      person.last_hail_miles != null && Number(person.last_hail_miles) > 0
        ? `Reports put ${size} about ${Number(person.last_hail_miles).toFixed(1)} miles from ${street ?? 'their home'}.`
        : `Radar puts ${size} right over ${street ?? 'their building'}.`;
  }

  const panels = person.panel_count ?? null;
  const fit = person.is_commercial && panels ? commercialFitLine(await plans(), panels) : null;

  return {
    business: person.name?.trim() || null,
    panel_count: panels ? String(panels) : null,
    shield_quote: fit ? `For ${panels} panels, that's ${fit}.` : null,
    first_name: firstOf(person.name),
    storm_date: day ? spokenDay(day) : null,
    storm_detail: detail,
    street,
    rep_first: firstOf(repName),
  };
}

/** The script person for a CRM record: its name, address and last hail. */
export function scriptPersonOf(record: {
  name: string;
  address: string | null;
  lead?: ScriptPerson | null;
  customer?: ScriptPerson | null;
}): ScriptPerson {
  const src = record.lead ?? record.customer ?? null;
  return {
    name: record.name,
    address: record.address,
    last_hail_at: src?.last_hail_at ?? null,
    last_hail_size: src?.last_hail_size ?? null,
    last_hail_miles: src?.last_hail_miles ?? null,
    is_commercial: src?.is_commercial === true,
    panel_count: src?.panel_count ?? null,
  };
}

// Calling from the CRM hands the record to the call screen in memory (never
// in the URL), so its Script button can fill the same fields.
let pendingCall: { digits: string; person: ScriptPerson } | null = null;
const last10 = (phone: string) => phone.replace(/\D/g, '').slice(-10);

export function rememberCallPerson(to: string, person: ScriptPerson) {
  pendingCall = { digits: last10(to), person };
}

/** The person the CRM was calling at this number, if any; else just a name. */
export function callPersonFor(to: string, name: string | null): ScriptPerson {
  if (pendingCall && to && pendingCall.digits === last10(to)) return pendingCall.person;
  return { name };
}
