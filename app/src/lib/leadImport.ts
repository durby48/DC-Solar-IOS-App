import { supabase } from '@/lib/supabase';
import { type Sheet } from '@/lib/spreadsheet';

/**
 * Lead import (2026-10-07): spreadsheet rows → unassigned, call-first
 * Prospects via `import_leads()` (2026-10-07_lead_import.sql).
 *
 *   1. findHeaderRow — lists often start with title lines; the header is the
 *      first row that reads like column names.
 *   2. guessField   — each column gets a target (Name, Phone, Address…, Notes,
 *      Skip) from its header; the admin can change any of them.
 *   3. buildRows    — one lead per row: the address assembled from street /
 *      city / state / ZIP, every Notes column folded into the lead's notes as
 *      "Header: value". Rows are skipped with a reason: no phone and no email,
 *      marked a duplicate in the file, or the same phone/email + address seen
 *      earlier in the file. A shared phone at a DIFFERENT address is its own
 *      lead (Carson, 2026-10-07).
 *   4. runImport    — sends the kept rows in chunks; the database re-checks
 *      everything and also skips people already in the CRM.
 */

export type Field =
  | 'name'
  | 'phone'
  | 'email'
  | 'street'
  | 'city'
  | 'state'
  | 'zip'
  | 'installer'
  | 'notes'
  | 'duplicate'
  | 'skip';

export const FIELD_LABEL: Record<Field, string> = {
  name: 'Name',
  phone: 'Phone',
  email: 'Email',
  street: 'Address',
  city: 'City',
  state: 'State',
  zip: 'ZIP',
  installer: 'Installer',
  notes: 'Notes',
  duplicate: 'Duplicate marker',
  skip: 'Skip',
};
export const FIELD_ORDER: Field[] = ['name', 'phone', 'email', 'street', 'city', 'state', 'zip', 'installer', 'notes', 'duplicate', 'skip'];

const PATTERNS: [Field, RegExp][] = [
  ['duplicate', /duplicate/i],
  // Before Name: "Solar company" / "Installed by" is the installer, not the lead.
  ['installer', /installer|installed by|install(ing|ation)? company|solar company|contractor/i],
  ['email', /e-?mail/i],
  ['phone', /phone|mobile|cell|tel\b/i],
  ['zip', /\bzip|postal/i],
  ['state', /^state$|province/i],
  ['city', /^city$|town/i],
  ['street', /address|street/i],
  ['name', /company|organi[sz]ation|business|^name$|contact name|customer/i],
  ['notes', /note|status|permit|description|source|title|url|comment/i],
];

export function guessField(header: string): Field {
  const h = header.trim();
  if (!h || /^(entry|#|id|row)$/i.test(h)) return 'skip';
  for (const [field, re] of PATTERNS) if (re.test(h)) return field;
  return 'skip';
}

/** The first row (of the top 30) that looks like column names. */
export function findHeaderRow(rows: Sheet): number {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const filled = rows[i].filter(Boolean);
    if (filled.length < 3) continue;
    const known = filled.filter((c) => guessField(c) !== 'skip').length;
    if (known >= 2) return i;
  }
  return 0;
}

export interface ImportRow {
  name: string;
  phone: string;
  email: string;
  address: string;
  /** The original solar installer (goes on the lead AND into its notes). */
  installer: string;
  notes: string;
  /** Why this row will not be imported; undefined = it will be. */
  skip?: 'no_contact' | 'duplicate' | 'no_name';
}

const blank = (v: string) => !v || /^(n\/?a|none|null|-|—)$/i.test(v.trim());

export function buildRows(rows: Sheet, headerIndex: number, fields: Field[]): ImportRow[] {
  const header = rows[headerIndex] ?? [];
  const seen = new Set<string>();
  const out: ImportRow[] = [];
  for (const raw of rows.slice(headerIndex + 1)) {
    if (raw.every((c) => !c)) continue;
    const pick = (f: Field) =>
      fields
        .map((field, i) => (field === f && !blank(raw[i] ?? '') ? raw[i].trim() : ''))
        .filter(Boolean);
    const name = pick('name')[0] ?? '';
    const phone = pick('phone')[0] ?? '';
    const email = (pick('email')[0] ?? '').toLowerCase();
    const street = pick('street').join(' ');
    const cityLine = [pick('city')[0], [pick('state')[0], pick('zip')[0]].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const address = [street, cityLine].filter(Boolean).join(', ');
    const notes = fields
      .map((f, i) => (f === 'notes' && !blank(raw[i] ?? '') ? `${header[i] || 'Note'}: ${raw[i].trim()}` : ''))
      .filter(Boolean)
      .join('\n');
    const installer = pick('installer')[0] ?? '';
    const row: ImportRow = { name, phone, email, address, installer, notes };
    const digits = phone.replace(/\D/g, '').slice(-10);
    const key = `${digits || email}|${address.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    if (!name) row.skip = 'no_name';
    else if (!digits && !email) row.skip = 'no_contact';
    else if (pick('duplicate').length > 0 || seen.has(key)) row.skip = 'duplicate';
    if (!row.skip) seen.add(key);
    out.push(row);
  }
  return out;
}

export interface ImportResult {
  inserted: number;
  /** Existing leads that got missing details filled in (update mode). */
  updated: number;
  skippedExisting: number;
  skippedInvalid: number;
  skippedDuplicate: number;
}

/** Send the kept rows to the database, 500 at a time. */
/**
 * `update`: a row that matches a lead already in the CRM fills in what that
 * lead is missing (installer, email, phone) instead of being skipped.
 */
export async function runImport(
  source: string,
  rows: ImportRow[],
  update = false,
): Promise<{ ok: true; result: ImportResult } | { ok: false; message: string }> {
  const keep = rows
    .filter((r) => !r.skip)
    .map(({ name, phone, email, address, installer, notes }) => ({ name, phone, email, address, installer, notes }));
  const total: ImportResult = { inserted: 0, updated: 0, skippedExisting: 0, skippedInvalid: 0, skippedDuplicate: 0 };
  try {
    for (let i = 0; i < keep.length; i += 500) {
      const { data, error } = await supabase.rpc('import_leads', {
        p_source: source,
        p_rows: keep.slice(i, i + 500),
        p_update: update,
      });
      if (error) {
        return {
          ok: false,
          message: `${error.message}${total.inserted ? ` (${total.inserted} were already imported before this stopped)` : ''}`,
        };
      }
      const r = data as {
        inserted: number;
        updated?: number;
        skipped_existing: number;
        skipped_invalid: number;
        skipped_duplicate: number;
      };
      total.inserted += r.inserted;
      total.updated += r.updated ?? 0;
      total.skippedExisting += r.skipped_existing;
      total.skippedInvalid += r.skipped_invalid;
      total.skippedDuplicate += r.skipped_duplicate;
    }
    return { ok: true, result: total };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'The import failed.' };
  }
}

/** Admin: hand these pool leads to one person, with one push for the batch. */
export async function assignLeads(ids: string[], repEmail: string): Promise<{ ok: true; count: number } | { ok: false; message: string }> {
  try {
    const { data, error } = await supabase.rpc('assign_leads', { p_ids: ids, p_rep: repEmail });
    if (error) return { ok: false, message: error.message };
    return { ok: true, count: Number(data ?? 0) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not assign.' };
  }
}
