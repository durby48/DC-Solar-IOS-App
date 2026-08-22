/**
 * DC SOLAR: The Trading Card Game — the app's data layer.
 *
 * The deck used to be a JSON file in a separate repo next to a static HTML
 * print sheet. It now lives in Postgres (`cards` + `card_sets`, see
 * supabase/migrations/2026-08-22_trading_cards.sql) with the artwork in the
 * private `cards` bucket, so the crew can browse it on a phone and an admin
 * can add the card for a job that finished last week.
 *
 * Three rules hold across this file:
 *
 *   1. NOTHING HERE THROWS. A card game is the least important thing in this
 *      app; it must never be the reason a screen crashes. Reads return a
 *      `status` union, writes return an `ok` union, and every path is wrapped.
 *   2. NULL AND ZERO ARE DIFFERENT, and the difference is printed on the card.
 *      `power: 0` is The Inspector genuinely contributing nothing; `panels:
 *      null` is a Critter Guard job that isn't measured in panels. Nothing in
 *      here coalesces one into the other — `??` is used, never `||`, on any
 *      numeric column.
 *   3. ART IS SIGNED IN ONE REQUEST. `fetchCardArtUrls` makes exactly one
 *      `createSignedUrls` call for the whole deck, the same shape
 *      `lib/artwork.ts` uses for the pipeline. Sixty-one individual signing
 *      round trips on a phone over LTE is not a grid, it's a progress bar.
 *
 * Regenerating art costs real money (~4¢ a call, billed to Devon's Gemini
 * key). `regenerateCardArt` is the ONLY thing in the app allowed to call the
 * `card-art` function, it is admin-gated server-side, and nothing calls it on
 * mount — a person has to ask for it, twice.
 */

import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Platform } from 'react-native';

import { readFunctionError } from '@/lib/artwork';
import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';
const SET_CODE = 'DCS26';
const ART_BUCKET = 'cards';
/** Signed URLs live an hour; every screen re-signs on focus anyway. */
const SIGNED_URL_TTL = 3600;
/** Uploaded art is capped at the same box `scripts/tcg/import.mjs` uses. */
const ART_MAX = { width: 900, height: 1200 };
const ART_QUALITY = 0.82;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CardType = 'job' | 'crew' | 'tool' | 'event' | 'special';
export type CardRarity = 'common' | 'uncommon' | 'rare' | 'legendary' | 'secret';
/** The three finishes the print template renders. Not stored — a view mode. */
export type CardVariant = 'base' | 'foil' | 'holo';

export const CARD_TYPES: readonly CardType[] = ['job', 'crew', 'tool', 'event', 'special'];
export const CARD_RARITIES: readonly CardRarity[] = [
  'common',
  'uncommon',
  'rare',
  'legendary',
  'secret',
];
export const CARD_VARIANTS: readonly CardVariant[] = ['base', 'foil', 'holo'];

export function isCardType(value: unknown): value is CardType {
  return typeof value === 'string' && (CARD_TYPES as readonly string[]).includes(value);
}

export function isCardRarity(value: unknown): value is CardRarity {
  return typeof value === 'string' && (CARD_RARITIES as readonly string[]).includes(value);
}

/** One row of `public.cards`, every column, named exactly as the database. */
export interface CardRecord {
  id: string;
  company: string;
  set_code: string;
  card_number: number | null;
  sort_order: number;
  card_type: CardType;
  title: string;
  rarity: CardRarity;
  ability: string | null;
  flavor: string | null;
  art_prompt: string | null;

  // Job cards (and The Mothership)
  job_number: string | null;
  job_id: string | null;
  location: string | null;
  service_type: string | null;
  panels: number | null;
  kw_dc: number | null;
  annual_kwh: number | null;
  difficulty: number | null;
  reward_kw: number | null;

  // Crew cards
  employee_id: string | null;
  role: string | null;
  power: number | null;

  // Tool cards
  bonus: number | null;

  // Presentation
  full_art: boolean;
  holo_only: boolean;
  art_path: string | null;

  // Bookkeeping
  version: number;
  archived_at: string | null;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** One row of `public.card_sets` — the printing, plus the rules. */
export interface CardSet {
  company: string;
  code: string;
  name: string;
  tagline: string | null;
  version: string | null;
  notes: string | null;
  rules_md: string | null;
  generated_on: string | null;
}

export type CardsResult =
  | { status: 'ok'; cards: CardRecord[] }
  | { status: 'unavailable' };

export type CardWriteResult =
  | { ok: true; id: string; created: boolean }
  | { ok: false; message: string };

export type CardArtResult =
  | { ok: true; artPath: string; version: number }
  | { ok: false; message: string };

export type CardRegenerateResult =
  | { ok: true; artPath: string; version: number; cached: boolean }
  | { ok: false; message: string };

/** Everything an admin may edit. `id` present = update, absent = insert. */
export interface CardInput {
  id?: string | null;
  card_type: CardType;
  title: string;
  rarity: CardRarity;
  ability?: string | null;
  flavor?: string | null;
  art_prompt?: string | null;
  job_number?: string | null;
  job_id?: string | null;
  location?: string | null;
  service_type?: string | null;
  panels?: number | null;
  kw_dc?: number | null;
  annual_kwh?: number | null;
  difficulty?: number | null;
  reward_kw?: number | null;
  employee_id?: string | null;
  role?: string | null;
  power?: number | null;
  bonus?: number | null;
  full_art?: boolean;
  holo_only?: boolean;
  card_number?: number | null;
  sort_order?: number | null;
}

// ---------------------------------------------------------------------------
// Normalising
// ---------------------------------------------------------------------------

/**
 * `??`, never `||` — see rule 2 in the header. `Number(null)` is 0, which is
 * exactly the bug this guards against, so the null check comes first.
 */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeCard(row: Record<string, unknown>): CardRecord {
  return {
    id: String(row.id ?? ''),
    company: (row.company as string) ?? COMPANY,
    set_code: (row.set_code as string) ?? SET_CODE,
    card_number: num(row.card_number),
    sort_order: num(row.sort_order) ?? 0,
    card_type: isCardType(row.card_type) ? row.card_type : 'special',
    title: (row.title as string) ?? '',
    rarity: isCardRarity(row.rarity) ? row.rarity : 'common',
    ability: (row.ability as string | null) ?? null,
    flavor: (row.flavor as string | null) ?? null,
    art_prompt: (row.art_prompt as string | null) ?? null,

    job_number: (row.job_number as string | null) ?? null,
    job_id: (row.job_id as string | null) ?? null,
    location: (row.location as string | null) ?? null,
    service_type: (row.service_type as string | null) ?? null,
    panels: num(row.panels),
    kw_dc: num(row.kw_dc),
    annual_kwh: num(row.annual_kwh),
    difficulty: num(row.difficulty),
    reward_kw: num(row.reward_kw),

    employee_id: (row.employee_id as string | null) ?? null,
    role: (row.role as string | null) ?? null,
    power: num(row.power),

    bonus: num(row.bonus),

    full_art: Boolean(row.full_art),
    holo_only: Boolean(row.holo_only),
    art_path: (row.art_path as string | null) ?? null,

    version: num(row.version) ?? 1,
    archived_at: (row.archived_at as string | null) ?? null,
    created_by: (row.created_by as string | null) ?? null,
    created_at: (row.created_at as string | null) ?? null,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The printing: name, tagline, version note and the rules Markdown. */
export async function fetchCardSet(): Promise<CardSet | null> {
  try {
    const { data, error } = await supabase
      .from('card_sets')
      .select('company, code, name, tagline, version, notes, rules_md, generated_on')
      .eq('company', COMPANY)
      .eq('code', SET_CODE)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as Record<string, unknown>;
    return {
      company: (row.company as string) ?? COMPANY,
      code: (row.code as string) ?? SET_CODE,
      name: (row.name as string) ?? 'DC Solar TCG',
      tagline: (row.tagline as string | null) ?? null,
      version: (row.version as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      rules_md: (row.rules_md as string | null) ?? null,
      generated_on: (row.generated_on as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * The whole deck in printed order. Archived cards are hidden by default — a
 * card that was pulled from the set still exists (soft delete), it just isn't
 * in the binder any more.
 */
export async function fetchCards(
  options: { includeArchived?: boolean } = {},
): Promise<CardsResult> {
  try {
    let query = supabase
      .from('cards')
      .select('*')
      .eq('company', COMPANY)
      .order('sort_order', { ascending: true });
    if (!options.includeArchived) query = query.is('archived_at', null);

    const { data, error } = await query;
    if (error) return { status: 'unavailable' };
    return {
      status: 'ok',
      cards: ((data ?? []) as Record<string, unknown>[]).map(normalizeCard),
    };
  } catch {
    return { status: 'unavailable' };
  }
}

/** One card by slug, or null when it's missing / unreadable. */
export async function fetchCard(id: string): Promise<CardRecord | null> {
  try {
    const { data, error } = await supabase
      .from('cards')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return null;
    return normalizeCard(data as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Signed art URLs keyed by card id, in ONE request for the whole deck.
 *
 * Storage's `createSignedUrls` returns results positionally, and a failure for
 * one object is a null `signedUrl` in that slot rather than an error for the
 * batch — so the paths are zipped back to their cards by index and anything
 * that failed simply has no art, which every card renderer already handles.
 */
export async function fetchCardArtUrls(cards: CardRecord[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  try {
    const withArt = cards.filter(
      (card): card is CardRecord & { art_path: string } =>
        typeof card.art_path === 'string' && card.art_path.length > 0,
    );
    if (withArt.length === 0) return urls;

    const { data, error } = await supabase.storage
      .from(ART_BUCKET)
      .createSignedUrls(
        withArt.map((card) => card.art_path),
        SIGNED_URL_TTL,
      );
    if (error || !data) return urls;

    data.forEach((entry, index) => {
      const signed = (entry as { signedUrl?: string | null }).signedUrl;
      const card = withArt[index];
      if (signed && card) urls.set(card.id, signed);
    });
  } catch {
    // fall through to whatever we managed to sign
  }
  return urls;
}

export interface CardJobOption {
  id: string;
  jobNumber: string | null;
  name: string | null;
}

/**
 * Jobs an admin can point a card at, newest first.
 *
 * Every job, not just active ones — a card is a keepsake of work that is by
 * definition finished. Capped because the picker is a list a person scrolls,
 * not a report.
 */
export async function fetchCardJobOptions(): Promise<CardJobOption[]> {
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select('id, job_number, name')
      .eq('company', COMPANY)
      .order('job_number', { ascending: false })
      .limit(300);
    if (error || !data) return [];
    return (data as Record<string, unknown>[]).map((row) => ({
      id: String(row.id ?? ''),
      jobNumber: (row.job_number as string | null) ?? null,
      name: (row.name as string | null) ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * The display name behind a crew card's `employee_id`.
 *
 * Four cards are drawn from a real person's likeness and the detail screen
 * says whose. Null when the row is gone or unreadable — the card still stands
 * on its own, which is the whole point of `ON DELETE SET NULL` on that column.
 */
export async function fetchCardEmployeeName(employeeId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('employees')
      .select('display_name, email')
      .eq('id', employeeId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { display_name?: string | null; email?: string | null };
    return str(row.display_name ?? null) ?? str(row.email ?? null);
  } catch {
    return null;
  }
}

/** Just the rules Markdown, for `/cards/rules`. */
export async function fetchRules(): Promise<string | null> {
  const set = await fetchCardSet();
  return set?.rules_md ?? null;
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * The slug is the primary key AND the art filename, so it has to satisfy the
 * `card-art` function's `^[a-z0-9][a-z0-9-]{0,80}$` — the same regex, kept in
 * sync deliberately. Type prefix first ("crew-", "tool-") because that is the
 * convention the printed deck already uses and it makes a bucket listing
 * readable.
 */
export function slugifyCardId(title: string, cardType: CardType): string {
  const body = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  const slug = body.length > 0 ? body : `card-${Date.now().toString(36)}`;
  // Don't double the prefix on "Crew Chief" → crew-crew-chief.
  if (slug.startsWith(`${cardType}-`)) return slug;
  return `${cardType}-${slug}`;
}

/** An id that isn't taken yet, tried with a numeric suffix. Never throws. */
async function availableId(base: string): Promise<string> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    try {
      const { data, error } = await supabase
        .from('cards')
        .select('id')
        .eq('id', candidate)
        .maybeSingle();
      if (error) return candidate;
      if (!data) return candidate;
    } catch {
      return candidate;
    }
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Next free position at the end of the set. Falls back to a timestamp-ish. */
async function nextOrder(): Promise<{ sortOrder: number; cardNumber: number }> {
  try {
    const { data, error } = await supabase
      .from('cards')
      .select('sort_order, card_number')
      .eq('company', COMPANY)
      .order('sort_order', { ascending: false })
      .limit(1);
    const row = ((data ?? []) as Record<string, unknown>[])[0];
    if (error || !row) return { sortOrder: 0, cardNumber: 1 };
    const sortOrder = (num(row.sort_order) ?? -1) + 1;
    const cardNumber = (num(row.card_number) ?? sortOrder) + 1;
    return { sortOrder, cardNumber };
  } catch {
    return { sortOrder: 0, cardNumber: 1 };
  }
}

// ---------------------------------------------------------------------------
// Writes (admin — RLS enforces it, this just fails politely)
// ---------------------------------------------------------------------------

/**
 * Insert or update one card.
 *
 * An `id` on the input means update; no id means a new card whose slug is
 * derived from the title. The slug is NEVER regenerated on an update — it is
 * the art filename and a deep link, and renaming a card must not orphan
 * either.
 *
 * Every type-specific column is written on every save, including as null,
 * because the editor can move a card between types and a stale `power` on a
 * card that is now a Tool would print a phantom stat pill.
 */
export async function saveCard(input: CardInput): Promise<CardWriteResult> {
  try {
    const title = str(input.title);
    if (!title) return { ok: false, message: 'The card needs a title.' };
    if (!isCardType(input.card_type)) {
      return { ok: false, message: `"${String(input.card_type)}" is not a card type.` };
    }
    if (!isCardRarity(input.rarity)) {
      return { ok: false, message: `"${String(input.rarity)}" is not a rarity.` };
    }

    const isJobLike = input.card_type === 'job' || input.card_type === 'special';
    const payload: Record<string, unknown> = {
      card_type: input.card_type,
      title,
      rarity: input.rarity,
      ability: str(input.ability ?? null),
      flavor: str(input.flavor ?? null),
      art_prompt: str(input.art_prompt ?? null),

      job_number: isJobLike ? str(input.job_number ?? null) : null,
      job_id: isJobLike ? (input.job_id ?? null) : null,
      location: isJobLike ? str(input.location ?? null) : null,
      service_type: isJobLike ? str(input.service_type ?? null) : null,
      panels: isJobLike ? (input.panels ?? null) : null,
      kw_dc: isJobLike ? (input.kw_dc ?? null) : null,
      annual_kwh: isJobLike ? (input.annual_kwh ?? null) : null,
      difficulty: isJobLike ? (input.difficulty ?? null) : null,
      reward_kw: isJobLike ? (input.reward_kw ?? null) : null,

      employee_id: input.card_type === 'crew' ? (input.employee_id ?? null) : null,
      role: input.card_type === 'crew' ? str(input.role ?? null) : null,
      power: input.card_type === 'crew' ? (input.power ?? null) : null,

      bonus: input.card_type === 'tool' ? (input.bonus ?? null) : null,

      full_art: Boolean(input.full_art),
      holo_only: Boolean(input.holo_only),
    };

    const existingId = str(input.id ?? null);
    if (existingId) {
      const { error } = await supabase.from('cards').update(payload).eq('id', existingId);
      if (error) return { ok: false, message: writeMessage(error.message) };
      return { ok: true, id: existingId, created: false };
    }

    const id = await availableId(slugifyCardId(title, input.card_type));
    const order = await nextOrder();
    const { error } = await supabase.from('cards').insert({
      ...payload,
      id,
      company: COMPANY,
      set_code: SET_CODE,
      sort_order: input.sort_order ?? order.sortOrder,
      card_number: input.card_number ?? order.cardNumber,
    });
    if (error) return { ok: false, message: writeMessage(error.message) };
    return { ok: true, id, created: true };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'The card could not be saved.',
    };
  }
}

/** RLS denials read like Postgres. Say what actually happened instead. */
function writeMessage(message: string): string {
  if (/row-level security|permission denied|42501/i.test(message)) {
    return 'Only an admin can change the card set.';
  }
  return message;
}

/** Soft delete — a printed card never leaves anyone's binder. */
export async function archiveCard(id: string): Promise<CardWriteResult> {
  return setArchived(id, new Date().toISOString());
}

export async function unarchiveCard(id: string): Promise<CardWriteResult> {
  return setArchived(id, null);
}

async function setArchived(id: string, value: string | null): Promise<CardWriteResult> {
  try {
    const { error } = await supabase.from('cards').update({ archived_at: value }).eq('id', id);
    if (error) return { ok: false, message: writeMessage(error.message) };
    return { ok: true, id, created: false };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'That card could not be updated.',
    };
  }
}

// ---------------------------------------------------------------------------
// Artwork
// ---------------------------------------------------------------------------

/**
 * Shrink a picked image toward the 900×1200 box the imported deck uses.
 *
 * SDK 57's object API, not the deprecated `manipulateAsync`: `manipulate()`
 * opens a context, `renderAsync()` resolves to an `ImageRef` that KNOWS ITS
 * OWN SIZE, and only then is a resize scheduled. Rendering first is what lets
 * this avoid upscaling — `resize({width: 900})` on a 400px photo makes the
 * file bigger and the picture no better, and the picker does not always report
 * dimensions.
 *
 * WebP only where the platform actually encodes it (Android). iOS will accept
 * `SaveFormat.WEBP` and hand back bytes the bucket then serves under the wrong
 * content type.
 *
 * NEVER THROWS. A device that can't run the manipulator uploads the original
 * file: worse for the data plan, completely fine for the card. `art_path` is
 * read back from the row and never guessed, so whichever extension the
 * fallback lands on is still correct downstream.
 */
async function compressArt(
  uri: string,
): Promise<{ uri: string; ext: 'webp' | 'jpg'; contentType: string }> {
  const useWebp = Platform.OS === 'android';
  const fallback = {
    uri,
    ext: (useWebp ? 'webp' : 'jpg') as 'webp' | 'jpg',
    contentType: useWebp ? 'image/webp' : 'image/jpeg',
  };
  try {
    const context = ImageManipulator.manipulate(uri);
    let rendered = await context.renderAsync();

    const { width, height } = rendered;
    if (width > ART_MAX.width || height > ART_MAX.height) {
      const scale = Math.min(ART_MAX.width / width, ART_MAX.height / height);
      context.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
      });
      rendered = await context.renderAsync();
    }

    const saved = await rendered.saveAsync({
      compress: ART_QUALITY,
      format: useWebp ? SaveFormat.WEBP : SaveFormat.JPEG,
    });
    if (!saved?.uri) return fallback;
    return { ...fallback, uri: saved.uri };
  } catch {
    return fallback;
  }
}

/**
 * Replace one card's artwork from the photo library.
 *
 * The object key is `<id>.<ext>` with `upsert`, matching what the importer and
 * the edge function both write, and `version` is bumped so any screen holding
 * a stale signed URL can tell the art moved.
 */
export async function uploadCardArt(params: {
  cardId: string;
  uri: string;
  /** Current version, to bump. Read from the row when omitted. */
  version?: number | null;
}): Promise<CardArtResult> {
  try {
    const compressed = await compressArt(params.uri);

    const response = await fetch(compressed.uri);
    const blob = await response.blob();
    const contentType = blob.type || compressed.contentType;
    const ext = contentType.includes('webp')
      ? 'webp'
      : contentType.includes('png')
        ? 'png'
        : 'jpg';
    const artPath = `${params.cardId}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from(ART_BUCKET)
      .upload(artPath, blob, { contentType, upsert: true });
    if (upErr) return { ok: false, message: writeMessage(upErr.message) };

    let version = params.version ?? null;
    if (version == null) {
      const current = await fetchCard(params.cardId);
      version = current?.version ?? 1;
    }
    const nextVersion = version + 1;

    const { error } = await supabase
      .from('cards')
      .update({ art_path: artPath, version: nextVersion })
      .eq('id', params.cardId);
    if (error) return { ok: false, message: writeMessage(error.message) };

    return { ok: true, artPath, version: nextVersion };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'That artwork could not be saved.',
    };
  }
}

/**
 * Ask the `card-art` edge function to draw this card with Gemini.
 *
 * THIS COSTS MONEY — roughly four cents a call, and about twenty seconds. It
 * is admin-only server-side, it returns the existing art untouched unless
 * `force` is set, and every caller in the app puts a confirmation in front of
 * it. Do not call it on mount, in a retry loop, or for a list.
 */
export async function regenerateCardArt(
  cardId: string,
  force = false,
): Promise<CardRegenerateResult> {
  try {
    const { data, error } = await supabase.functions.invoke('card-art', {
      body: { cardId, force },
    });

    if (error) {
      const status = functionStatus(error);
      const detail = await readFunctionError(error);
      if (status === 503) {
        return {
          ok: false,
          message:
            "Card art generation isn't configured yet — it needs a Gemini API key on the " +
            'server. Upload artwork from your photos instead.',
        };
      }
      if (status === 403) {
        return { ok: false, message: detail ?? 'Only an admin can generate card art.' };
      }
      if (status === 401) {
        return { ok: false, message: detail ?? 'Sign in again and try that once more.' };
      }
      return { ok: false, message: detail ?? error.message ?? 'Card art generation failed.' };
    }

    const result = data as
      | { ok?: boolean; artPath?: string; version?: number; cached?: boolean; error?: string }
      | null;
    if (!result?.ok || !result.artPath) {
      return { ok: false, message: result?.error ?? 'Card art generation failed.' };
    }
    return {
      ok: true,
      artPath: result.artPath,
      version: result.version ?? 1,
      cached: Boolean(result.cached),
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Card art generation failed.',
    };
  }
}

/**
 * The HTTP status hiding on a supabase-js FunctionsHttpError. supabase-js
 * flattens every non-2xx into one message and parks the real `Response` on
 * `error.context`; `readFunctionError` reads its body, this reads its status,
 * which is how a 503 "no API key" is told apart from a 502 "Gemini said no".
 */
function functionStatus(error: unknown): number | null {
  const context = (error as { context?: unknown })?.context;
  if (!context || typeof context !== 'object') return null;
  const status = (context as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

// ---------------------------------------------------------------------------
// Presentation helpers (shared by the renderer and the detail screen)
// ---------------------------------------------------------------------------

/**
 * The stat pills, ported verbatim from `print/print_sheets.html::statBlock`
 * INCLUDING its quirks, because the printed cards are the reference:
 *   • job/special print only the stats that are non-null;
 *   • crew ALWAYS print POWER, even Power 0 (The Inspector);
 *   • tools print their bonus only when it is truthy, so The Sharpie's +0
 *     prints nothing at all.
 */
export function cardStats(card: CardRecord): string[] {
  const out: string[] = [];
  if (card.card_type === 'job' || card.card_type === 'special') {
    if (card.panels != null) out.push(`${card.panels} panels`);
    if (card.kw_dc != null) out.push(`${card.kw_dc} kWdc`);
    if (card.annual_kwh != null) out.push(`${card.annual_kwh.toLocaleString()} kWh/yr`);
    if (card.difficulty != null) out.push(`DIFF ${card.difficulty}`);
    if (card.reward_kw != null) out.push(`+${card.reward_kw} kW`);
  }
  if (card.card_type === 'crew') out.push(`POWER ${card.power ?? 0}`);
  if (card.card_type === 'tool' && card.bonus) out.push(`+${card.bonus} PWR`);
  return out;
}

/** The typeline's left half: "Install · Overland Park, KS" or the role. */
export function cardTypeline(card: CardRecord): string {
  if (card.card_type === 'job' || card.card_type === 'special') {
    return [card.service_type, card.location].filter(Boolean).join(' · ');
  }
  return card.role ?? card.card_type;
}

/** The head band's right half: the job number, else the type in caps. */
export function cardCorner(card: CardRecord): string {
  return card.job_number ?? card.card_type.toUpperCase();
}

const TYPE_LABELS: Record<CardType, string> = {
  job: 'Job',
  crew: 'Crew',
  tool: 'Tool',
  event: 'Event',
  special: 'Special',
};

export function cardTypeLabel(type: CardType): string {
  return TYPE_LABELS[type] ?? type;
}

export function rarityLabel(rarity: CardRarity): string {
  return rarity.charAt(0).toUpperCase() + rarity.slice(1);
}

/**
 * Which finish a card is actually shown in. `holo_only` cards (Sold a Damn
 * Cow) ignore the collection's variant toggle — that is what "holographic
 * full-art only" means on the printed sheet.
 */
export function effectiveVariant(card: CardRecord, variant: CardVariant): CardVariant {
  return card.holo_only ? 'holo' : variant;
}
