/**
 * Company contacts — the directory of people who are not customers or leads.
 *
 * WHAT LIVES HERE (2026-09-12). Phase 1 (2026-09-06) put a narrow `contacts`
 * table behind the Phone section's Contacts tab and three helpers in
 * `lib/comms.ts`. Phase 2 grows the table — tags, a title, a link to ONE
 * customer, an import key — and this module owns every read and write of it.
 * `lib/comms.ts` re-exports the Phase 1 names so nothing that imported them
 * has to move.
 *
 * THE MODEL
 *   customer ─< contacts     a contractor customer ("Cromwell") has many
 *                            people: a PM, an office line, a site lead. One of
 *                            them is `is_primary`. A contact with no customer
 *                            is a stand-alone entry: a distributor, a driver,
 *                            a city inspector.
 *   tags text[]              Devon's own words, no fixed list. `kind` (Phase
 *                            1, NOT NULL) is kept in step as the FIRST tag on
 *                            every write, so the twilio-inbound thread label
 *                            and any older screen keep reading something.
 *   external_id              the iPhone contact identifier. A re-import finds
 *                            its own rows by this before falling back to the
 *                            phone number, so importing twice never doubles.
 *
 * HOUSE RULES FOLLOWED HERE
 * - NOTHING THROWS. Reads return an empty array or null; writes return
 *   `{ok:true, …}` or `{ok:false, message}`. The crew can READ this table
 *   (member SELECT) but not write it (admin per verb), and an RLS denial on
 *   an update is "zero rows matched", which is why every update checks the
 *   returned row count and not only `error`.
 * - `phone_e164` IS GENERATED SERVER-SIDE and never written from here. The
 *   `toE164` below is a CLIENT-SIDE MIRROR of the same expression, used only
 *   to decide, before an import, which device contact already has a row.
 *   The database remains the authority on the stored value.
 * - Import is selection-only. `importContacts` takes the rows a person
 *   ticked; there is no "import everything" entry point on purpose.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

const CONTACT_COLUMNS =
  'id, company, kind, name, org, title, phone, phone_e164, email, notes, tags, customer_id, ' +
  'source, external_id, is_primary, archived_at, created_at, created_by';

/** Insert batches: PostgREST is happy with far more, but the UI reports per chunk. */
const IMPORT_CHUNK = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContactSource = 'manual' | 'ios_import';

/** One row of `public.contacts`, as a screen wants it. */
export interface CompanyContact {
  id: string;
  /** Phase 1 column; always equals `tags[0]` after a Phase 2 write. */
  kind: string;
  name: string;
  /** "Kansas City Solar Supply". The business, when the person has one. */
  org: string | null;
  /** Their role at the org: "Project manager", "Dispatcher". */
  title: string | null;
  /** As typed. */
  phone: string | null;
  /** GENERATED: +1XXXXXXXXXX or null. The number twilio-inbound matches on. */
  phoneE164: string | null;
  email: string | null;
  notes: string | null;
  /** Never empty for display: falls back to `[kind]` for Phase 1 rows. */
  tags: string[];
  /** The customer this person belongs to, or null for a stand-alone contact. */
  customerId: string | null;
  source: ContactSource;
  /** iOS contact identifier when imported from a phone. */
  externalId: string | null;
  /** The person to ring first for `customerId`. */
  isPrimary: boolean;
  archivedAt: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface ContactInput {
  name: string;
  org?: string | null;
  title?: string | null;
  phone?: string | null;
  email?: string | null;
  /**
   * Phase 1 field. Ignored when `tags` is given (kind becomes tags[0]);
   * otherwise becomes the one tag. Free text server-side.
   */
  kind?: string;
  notes?: string | null;
  tags?: string[];
  customerId?: string | null;
  isPrimary?: boolean;
}

export type ContactResult = { ok: true } | { ok: false; message: string; code?: string };
export type ContactCreateResult = { ok: true; id: string } | { ok: false; message: string; code?: string };

/** One ticked row from the phone, normalised by the import screen. */
export interface DeviceContactInput {
  /** iOS contact identifier — becomes `external_id`. */
  externalId: string;
  name: string;
  org?: string | null;
  title?: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface ImportSummary {
  inserted: number;
  updated: number;
  /** Rows with no name at all — nothing to file them under. */
  skipped: number;
  /** First error message, when any chunk failed. */
  message: string | null;
}

export type ImportResult = ({ ok: true } & ImportSummary) | ({ ok: false } & ImportSummary);

/**
 * Tags offered before anyone has typed one. Devon's examples plus the Phase 1
 * kinds. A tag typed on the import screen joins this list for the session and
 * lives in the database from then on — this is a starting vocabulary, not a
 * constraint.
 */
export const PRESET_TAGS: readonly string[] = [
  'supplier',
  'distributor',
  'vendor',
  'contractor',
  'electrician',
  'driver',
  'city inspector',
  'inspector',
  'utility',
  'other',
];

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Signed-in email, lowercased, or null. Never throws. */
async function currentEmail(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const email = data.session?.user?.email;
    return email ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * The database's `phone_e164` expression, character for character, on the
 * client — 10 digits or a leading-1 eleven → E.164, anything else → null.
 * Used ONLY to match device contacts against existing rows before an import;
 * the stored value is always the generated column.
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** "City Inspector " → "city inspector". Empty strings and duplicates fall out. */
export function normalizeTags(tags: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of tags ?? []) {
    const tag = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** "city inspector" → "City inspector". */
export function tagLabel(tag: string): string {
  return tag.charAt(0).toUpperCase() + tag.slice(1);
}

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function toContact(row: Record<string, unknown>): CompanyContact {
  const kind = ((row.kind as string | null) ?? '').trim();
  const tags = normalizeTags(toStringArray(row.tags));
  return {
    id: String(row.id),
    kind: kind || 'other',
    name: ((row.name as string | null) ?? '').trim() || 'Unnamed',
    org: (row.org as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    phoneE164: (row.phone_e164 as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    // Phase 1 rows have kind but no tags; the migration backfills, but a row
    // written by an older build in between still reads sensibly.
    tags: tags.length > 0 ? tags : kind ? [kind.toLowerCase()] : [],
    customerId: (row.customer_id as string | null) ?? null,
    source: row.source === 'ios_import' ? 'ios_import' : 'manual',
    externalId: (row.external_id as string | null) ?? null,
    isPrimary: row.is_primary === true,
    archivedAt: (row.archived_at as string | null) ?? null,
    createdAt: (row.created_at as string) ?? new Date().toISOString(),
    createdBy: (row.created_by as string | null) ?? null,
  };
}

function writeError(
  error: { code?: string; message?: string },
  verb: string,
): { ok: false; message: string; code?: string } {
  const raw = error.message ?? '';
  if (error.code === '42501' || /row-level security|policy|permission denied/i.test(raw)) {
    return { ok: false, code: 'forbidden', message: `Only owners and operators can ${verb} contacts.` };
  }
  if (error.code === '23505' || /duplicate key|unique constraint/i.test(raw)) {
    return { ok: false, code: 'duplicate', message: 'That phone contact is already in the directory.' };
  }
  return { ok: false, code: error.code, message: raw || `Could not ${verb} the contact.` };
}

/** Turn an input into the column map the table wants. `kind` follows tags[0]. */
function toRow(input: ContactInput): Record<string, unknown> {
  const tags = normalizeTags(input.tags ?? (input.kind ? [input.kind] : []));
  const kind = tags[0] ?? 'other';
  const row: Record<string, unknown> = {
    name: (input.name ?? '').trim(),
    kind,
    tags: tags.length > 0 ? tags : [kind],
  };
  if (input.org !== undefined) row.org = input.org?.trim() || null;
  if (input.title !== undefined) row.title = input.title?.trim() || null;
  if (input.phone !== undefined) row.phone = input.phone?.trim() || null;
  if (input.email !== undefined) row.email = input.email?.trim().toLowerCase() || null;
  if (input.notes !== undefined) row.notes = input.notes?.trim() || null;
  if (input.customerId !== undefined) row.customer_id = input.customerId || null;
  if (input.isPrimary !== undefined) row.is_primary = input.isPrimary;
  return row;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The company's contacts, A–Z. Member-readable, so this — unlike
 * `phone_directory()` — works for the whole crew. Empty for the signed-out,
 * for a database without the migration, and on any error.
 */
export async function fetchContacts(options?: {
  includeArchived?: boolean;
  /** Only the people filed under this customer. */
  customerId?: string;
  /** Only stand-alone contacts (no customer) — the "attach existing" picker. */
  unattachedOnly?: boolean;
}): Promise<CompanyContact[]> {
  try {
    let query = supabase.from('contacts').select(CONTACT_COLUMNS).eq('company', COMPANY);
    if (!options?.includeArchived) query = query.is('archived_at', null);
    if (options?.customerId) query = query.eq('customer_id', options.customerId);
    if (options?.unattachedOnly) query = query.is('customer_id', null);
    const { data, error } = await query.order('name', { ascending: true });
    if (error || !data) return [];
    return (data as unknown as Record<string, unknown>[]).map(toContact);
  } catch {
    return [];
  }
}

/**
 * A customer's people: primary first, then A–Z. What the "Contacts" segment
 * on the customer record renders.
 */
export async function fetchContactsForCustomer(customerId: string): Promise<CompanyContact[]> {
  const rows = await fetchContacts({ customerId });
  return rows.sort((a, b) =>
    a.isPrimary === b.isPrimary ? a.name.localeCompare(b.name) : a.isPrimary ? -1 : 1,
  );
}

/** Every tag in use, most-used first — the filter chips and the tag picker. */
export async function fetchContactTags(): Promise<string[]> {
  const rows = await fetchContacts({ includeArchived: true });
  return collectTags(rows);
}

/** The distinct tags across a list, most-used first, ties A–Z. */
export function collectTags(rows: readonly CompanyContact[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const tag of row.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a, na], [b, nb]) => (nb !== na ? nb - na : a.localeCompare(b)))
    .map(([tag]) => tag);
}

/**
 * One contact, for the thread header. Null when missing or unreadable.
 * Phase 1 shape plus `title` and `customerId`, so the thread can say
 * "Bob · Cromwell · Project manager" when it wants to.
 */
export async function fetchContactById(id: string): Promise<{
  id: string;
  name: string;
  org: string | null;
  phoneE164: string | null;
  title: string | null;
  customerId: string | null;
  tags: string[];
} | null> {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .select(CONTACT_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return null;
    const contact = toContact(data as unknown as Record<string, unknown>);
    return {
      id: contact.id,
      name: contact.name,
      org: contact.org,
      phoneE164: contact.phoneE164,
      title: contact.title,
      customerId: contact.customerId,
      tags: contact.tags,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Writes (admin)
// ---------------------------------------------------------------------------

/** Admin: add one contact by hand. */
export async function createContact(input: ContactInput): Promise<ContactCreateResult> {
  try {
    const name = input.name.trim();
    if (!name) return { ok: false, message: 'Give the contact a name.' };
    const email = await currentEmail();
    const { data, error } = await supabase
      .from('contacts')
      .insert({ company: COMPANY, source: 'manual', created_by: email, ...toRow(input) })
      .select('id')
      .maybeSingle();
    if (error) return writeError(error, 'add');
    const id = (data as { id?: unknown } | null)?.id;
    if (!id) return { ok: false, code: 'forbidden', message: 'Only owners and operators can add contacts.' };
    return { ok: true, id: String(id) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the contact.' };
  }
}

/** Admin: edit a contact. Only the fields passed change. */
export async function updateContact(id: string, patch: Partial<ContactInput>): Promise<ContactResult> {
  try {
    if (patch.name !== undefined && !patch.name.trim()) {
      return { ok: false, message: 'Give the contact a name.' };
    }
    const row = toRow({ ...patch, name: patch.name ?? '' });
    if (patch.name === undefined) delete row.name;
    // `toRow` always derives kind/tags; drop them again when the caller did
    // not touch tags, so an org-only edit does not rewrite the kind.
    if (patch.tags === undefined && patch.kind === undefined) {
      delete row.kind;
      delete row.tags;
    }
    if (Object.keys(row).length === 0) return { ok: true };
    const { data, error } = await supabase.from('contacts').update(row).eq('id', id).select('id');
    if (error) return writeError(error, 'edit');
    if (!data || data.length === 0) {
      return { ok: false, code: 'forbidden', message: 'Only owners and operators can edit contacts.' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the contact.' };
  }
}

/** Admin: hide a contact from the directory without losing their thread. */
export async function archiveContact(id: string): Promise<ContactResult> {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .update({ archived_at: new Date().toISOString(), is_primary: false })
      .eq('id', id)
      .select('id');
    if (error) return writeError(error, 'archive');
    if (!data || data.length === 0) {
      return { ok: false, code: 'forbidden', message: 'Only owners and operators can archive contacts.' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not archive the contact.' };
  }
}

/** Admin: bring an archived contact back. */
export async function unarchiveContact(id: string): Promise<ContactResult> {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .update({ archived_at: null })
      .eq('id', id)
      .select('id');
    if (error) return writeError(error, 'restore');
    if (!data || data.length === 0) {
      return { ok: false, code: 'forbidden', message: 'Only owners and operators can restore contacts.' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not restore the contact.' };
  }
}

/**
 * Admin: file a contact under a customer (or detach with null). Detaching
 * also clears `is_primary` — a primary contact of nobody is meaningless.
 */
export async function attachContactToCustomer(
  id: string,
  customerId: string | null,
): Promise<ContactResult> {
  const patch: Record<string, unknown> = { customer_id: customerId };
  if (!customerId) patch.is_primary = false;
  try {
    const { data, error } = await supabase.from('contacts').update(patch).eq('id', id).select('id');
    if (error) return writeError(error, 'file');
    if (!data || data.length === 0) {
      return { ok: false, code: 'forbidden', message: 'Only owners and operators can file contacts.' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not file the contact.' };
  }
}

/**
 * Admin: make ONE of a customer's contacts the primary. Two writes, no
 * transaction: clear the others first, then set this one, so the worst
 * failure mode is "nobody primary" rather than "two primaries".
 */
export async function setPrimaryContact(customerId: string, contactId: string): Promise<ContactResult> {
  try {
    const clear = await supabase
      .from('contacts')
      .update({ is_primary: false })
      .eq('company', COMPANY)
      .eq('customer_id', customerId)
      .eq('is_primary', true)
      .neq('id', contactId);
    if (clear.error) return writeError(clear.error, 'edit');
    const { data, error } = await supabase
      .from('contacts')
      .update({ is_primary: true, customer_id: customerId })
      .eq('id', contactId)
      .select('id');
    if (error) return writeError(error, 'edit');
    if (!data || data.length === 0) {
      return { ok: false, code: 'forbidden', message: 'Only owners and operators can edit contacts.' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not set the primary contact.' };
  }
}

// ---------------------------------------------------------------------------
// Import from the phone
// ---------------------------------------------------------------------------

/**
 * Admin: bring the TICKED device contacts in, with one set of tags and an
 * optional customer applied to all of them.
 *
 * DEDUPE, in order, per row:
 *   1. same `external_id` (this phone's identifier)  → UPDATE that row
 *   2. else same `phone_e164` as an existing contact  → UPDATE that row and
 *      stamp the external_id on it, so next time rule 1 catches it
 *   3. else                                            → INSERT
 * A ticked row with no name is skipped and counted. Tags are MERGED into an
 * existing row (never removed); org/title/phone/email are filled where the
 * device has a value and the row does not, and the device value wins for
 * name. The customer link is set only when the caller chose one — an import
 * never detaches anyone.
 *
 * One read up front (the existing rows), then one INSERT per chunk of 100
 * and one UPDATE per matched row. Updates are the re-import case and rare.
 * Nothing here matches customers/leads by number: a customer's own number
 * stays on the customer, and the directory de-dups those on display.
 */
export async function importContacts(input: {
  contacts: readonly DeviceContactInput[];
  tags?: readonly string[];
  customerId?: string | null;
}): Promise<ImportResult> {
  const summary: ImportSummary = { inserted: 0, updated: 0, skipped: 0, message: null };
  const tags = normalizeTags(input.tags);
  const customerId = input.customerId ?? null;
  const fail = (message: string): ImportResult => ({ ok: false, ...summary, message });

  try {
    const email = await currentEmail();
    if (!email) return fail('Sign in first.');

    const rows = input.contacts.filter((c) => {
      if (c.name.trim().length > 0) return true;
      summary.skipped += 1;
      return false;
    });
    if (rows.length === 0) return fail('Nothing to import — every ticked contact was missing a name.');

    // One read: every existing row that could match by id or by number.
    const externalIds = rows.map((c) => c.externalId).filter((id) => id.length > 0);
    const numbers = rows.map((c) => toE164(c.phone)).filter((n): n is string => Boolean(n));
    const byExternal = new Map<string, CompanyContact>();
    const byNumber = new Map<string, CompanyContact>();
    const existing = await fetchContacts({ includeArchived: true });
    for (const row of existing) {
      if (row.externalId && externalIds.includes(row.externalId)) byExternal.set(row.externalId, row);
      if (row.phoneE164 && numbers.includes(row.phoneE164) && !byNumber.has(row.phoneE164)) {
        byNumber.set(row.phoneE164, row);
      }
    }

    const inserts: Record<string, unknown>[] = [];
    const updates: { id: string; patch: Record<string, unknown> }[] = [];
    const seenThisRun = new Set<string>();

    for (const c of rows) {
      const e164 = toE164(c.phone);
      const match = byExternal.get(c.externalId) ?? (e164 ? byNumber.get(e164) : undefined);
      const base: ContactInput = {
        name: c.name,
        org: c.org ?? null,
        title: c.title ?? null,
        phone: c.phone ?? null,
        email: c.email ?? null,
      };
      if (match) {
        const mergedTags = normalizeTags([...match.tags, ...tags]);
        const patch: Record<string, unknown> = {
          name: c.name.trim(),
          org: match.org ?? (c.org?.trim() || null),
          title: match.title ?? (c.title?.trim() || null),
          phone: match.phone ?? (c.phone?.trim() || null),
          email: match.email ?? (c.email?.trim().toLowerCase() || null),
          tags: mergedTags,
          kind: mergedTags[0] ?? match.kind,
          external_id: match.externalId ?? c.externalId,
          source: match.source === 'manual' && !match.externalId ? 'ios_import' : match.source,
          archived_at: null,
        };
        if (customerId) patch.customer_id = customerId;
        updates.push({ id: match.id, patch });
      } else {
        // Two ticked rows with the same number (home + mobile listed twice on
        // the phone): the first one is inserted, the second is skipped rather
        // than tripping the unique index on external_id or making a twin.
        const key = e164 ?? `ext:${c.externalId}`;
        if (seenThisRun.has(key)) {
          summary.skipped += 1;
          continue;
        }
        seenThisRun.add(key);
        inserts.push({
          company: COMPANY,
          source: 'ios_import',
          external_id: c.externalId || null,
          created_by: email,
          ...toRow({ ...base, tags: tags.length > 0 ? tags : ['other'], customerId }),
        });
      }
    }

    for (let i = 0; i < inserts.length; i += IMPORT_CHUNK) {
      const chunk = inserts.slice(i, i + IMPORT_CHUNK);
      const { data, error } = await supabase.from('contacts').insert(chunk).select('id');
      if (error) return fail(writeError(error, 'import').message);
      const count = data?.length ?? 0;
      if (count === 0) return fail('Only owners and operators can import contacts.');
      summary.inserted += count;
    }

    for (const { id, patch } of updates) {
      const { data, error } = await supabase.from('contacts').update(patch).eq('id', id).select('id');
      if (error) return fail(writeError(error, 'import').message);
      if (data && data.length > 0) summary.updated += 1;
    }

    return { ok: true, ...summary };
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'The import did not finish.');
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** "Project manager · Cromwell" / "Cromwell" / "Project manager" / "". */
export function contactSubtitle(contact: { title: string | null; org: string | null }): string {
  return [contact.title, contact.org].filter((part) => part && part.trim().length > 0).join(' · ');
}
