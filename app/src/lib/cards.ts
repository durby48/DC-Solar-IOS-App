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
// My deck — types
// ---------------------------------------------------------------------------

/**
 * How many packs this person has earned, spent, and has waiting.
 *
 * ONE PACK PER TEN HOURS WORKED, backdated over every hour on the books, so a
 * crew member who has been here two years opens their first pack owing
 * nothing. The arithmetic is the server's — `packs_earned` is floor(hours/10)
 * and `packs_available` is earned minus opened — because a client that could
 * compute its own entitlement is a client that could grant itself one.
 */
export interface PackStatus {
  /** Every hour on the clock, ever. */
  totalHours: number;
  packsEarned: number;
  packsOpened: number;
  packsAvailable: number;
  /** Hours still to work before the next pack. 0 when one is already waiting. */
  hoursToNext: number;
}

export type PackStatusResult = { status: 'ok'; value: PackStatus } | { status: 'unavailable' };

/**
 * ONE OWNED COPY — not one card.
 *
 * Pulling The Mothership twice is two `OwnedCard`s with the same `card.id`
 * and different `userCardId`s, and that is the point: duplicates are what
 * makes a deck a deck. `groupOwnedCards` collapses them for the grid.
 */
export interface OwnedCard {
  userCardId: string;
  obtainedAt: string | null;
  /** The finish THIS copy was pulled in. Rolled server-side, not a view mode. */
  variant: CardVariant;
  packId: string | null;
  card: CardRecord;
}

export type OwnedCardsResult = { status: 'ok'; cards: OwnedCard[] } | { status: 'unavailable' };

/** Every copy of one card, collapsed into a single cell of the collection. */
export interface OwnedGroup {
  card: CardRecord;
  copies: number;
  /** The finishes owned, in `base, foil, holo` order. */
  variants: CardVariant[];
  countsByVariant: Record<CardVariant, number>;
  firstObtainedAt: string | null;
  /** The most recent pull, which is what "New" is measured against. */
  newest: string | null;
}

/** The signed-in person's copies of one card. */
export interface CardOwnership {
  copies: number;
  countsByVariant: Record<CardVariant, number>;
  newest: string | null;
}

/**
 * One card off a pack, as the server dealt it.
 *
 * `open_card_pack` returns the ownership row only — id, finish, whether it is
 * new to this deck, and the slot it fell in — so `card` is hydrated from
 * `my_cards()` immediately afterwards. It is nullable because the reveal has
 * to survive that second read failing; the copy is already banked either way.
 */
export interface PackResult {
  userCardId: string;
  cardId: string;
  variant: CardVariant;
  /** First copy of this card in this deck. Earns the NEW ribbon. */
  isNew: boolean;
  /** 1..7. Slot 7 is the hit. */
  slot: number;
  card: CardRecord | null;
}

export type OpenPackResult =
  | { ok: true; cards: PackResult[] }
  | { ok: false; code: 'no_packs' | 'unavailable'; message: string };

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
 * THE FULL CATALOG — ADMIN ONLY.
 *
 * `cards` SELECT is restricted to owner/operator. Everyone else browses their
 * own deck (`fetchMyCards`) and only ever sees a card they have pulled.
 *
 * RLS does not raise for a viewer, it FILTERS: the query succeeds and comes
 * back with zero rows. So an empty read is treated as a denial rather than as
 * "the set is empty" — the printed set is 61 cards and is never legitimately
 * empty, and a screen that says "nothing has been printed yet" to a crew
 * member who simply isn't an admin is a lie. Callers get `unavailable` and
 * show "Admins only".
 *
 * Archived cards are hidden by default — a card that was pulled from the set
 * still exists (soft delete), it just isn't in the binder any more.
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
    const rows = (data ?? []) as Record<string, unknown>[];
    // Zero rows and no error === RLS filtered us out. See the note above.
    if (rows.length === 0) return { status: 'unavailable' };
    return { status: 'ok', cards: rows.map(normalizeCard) };
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * One card by slug from the CATALOG, or null when it's missing / unreadable.
 *
 * Null for a viewer on every card, owned or not — the catalog is admin-only.
 * `fetchOwnedCard` is the read that works for everybody.
 */
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
 * PER-ITEM FAILURE IS NORMAL NOW, NOT AN EDGE CASE. The bucket lets an admin
 * sign any card and a viewer sign only the cards they own, so asking for a
 * mixed batch comes back part-signed: each entry carries its own `error` and
 * an empty `signedUrl`, while the request as a whole still succeeds. A card
 * that couldn't be signed simply has no art, which every renderer already
 * handles — nothing here throws and nothing retries per card.
 *
 * Entries are matched back by `path` when Storage returns one and by index
 * otherwise, because a positional zip is only correct while the response is
 * the same length as the request.
 */
export async function fetchCardArtUrls(cards: CardRecord[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  try {
    const withArt = cards.filter(
      (card): card is CardRecord & { art_path: string } =>
        typeof card.art_path === 'string' && card.art_path.length > 0,
    );
    if (withArt.length === 0) return urls;

    // One card can be owned in several copies; sign each object once.
    const byPath = new Map<string, string>();
    for (const card of withArt) if (!byPath.has(card.art_path)) byPath.set(card.art_path, card.id);
    const paths = [...byPath.keys()];

    const { data, error } = await supabase.storage
      .from(ART_BUCKET)
      .createSignedUrls(paths, SIGNED_URL_TTL);
    if (error || !data) return urls;

    data.forEach((entry, index) => {
      const row = entry as { signedUrl?: string | null; path?: string | null; error?: unknown };
      if (row.error) return;
      const signed = row.signedUrl;
      if (!signed) return;
      const path = typeof row.path === 'string' && row.path.length > 0 ? row.path : paths[index];
      const cardId = path ? byPath.get(path) : undefined;
      if (!cardId) return;
      // Every card that shares this object gets the same URL.
      for (const card of withArt) if (card.art_path === path) urls.set(card.id, signed);
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
// My deck — packs, owned copies, and opening
// ---------------------------------------------------------------------------
//
// Everything below goes through SECURITY DEFINER functions rather than table
// reads, for the same reason the customer portal does: the deck is per-person
// and the entitlement is money-adjacent. `my_pack_status` counts the hours,
// `my_cards` returns the copies, and `open_card_pack` is the ONLY thing that
// can mint one — it decides the seven cards, their rarity slots and their
// finishes. Nothing in this file rolls a die.
//
// A viewer has no read on `cards` at all, so `my_cards` is also how a crew
// member's own card renders on the detail screen. See `fetchOwnedCard`.

export function isCardVariant(value: unknown): value is CardVariant {
  return typeof value === 'string' && (CARD_VARIANTS as readonly string[]).includes(value);
}

/** Rarest first. Used to order the collection and to spot a hit. */
const RARITY_RANK: Record<CardRarity, number> = {
  secret: 5,
  legendary: 4,
  rare: 3,
  uncommon: 2,
  common: 1,
};

/** Legendary and secret are the pulls worth a noise. */
export function isHitRarity(rarity: CardRarity): boolean {
  return rarity === 'legendary' || rarity === 'secret';
}

function emptyVariantCounts(): Record<CardVariant, number> {
  return { base: 0, foil: 0, holo: 0 };
}

/**
 * How many packs are waiting, and how far off the next one is.
 *
 * `unavailable` covers signed-out, not-staff (42501) and offline alike — the
 * deck header just doesn't draw its numbers. There is no partial state here:
 * a wrong pack count is worse than none.
 */
export async function fetchPackStatus(): Promise<PackStatusResult> {
  try {
    const { data, error } = await supabase.rpc('my_pack_status');
    if (error) return { status: 'unavailable' };
    const row = ((data ?? []) as Record<string, unknown>[])[0];
    if (!row) return { status: 'unavailable' };
    return {
      status: 'ok',
      value: {
        totalHours: num(row.total_hours) ?? 0,
        packsEarned: num(row.packs_earned) ?? 0,
        packsOpened: num(row.packs_opened) ?? 0,
        packsAvailable: num(row.packs_available) ?? 0,
        hoursToNext: num(row.hours_to_next) ?? 0,
      },
    };
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * Every copy this person owns, newest pull first.
 *
 * `my_cards()` returns the ownership row spread across every column of the
 * card, so one read is the whole deck — no join, no second query, and no
 * catalog access needed. The card half is run through the same
 * `normalizeCard` as an admin's catalog read so the renderer can't tell the
 * two sources apart.
 */
export async function fetchMyCards(): Promise<OwnedCardsResult> {
  try {
    const { data, error } = await supabase.rpc('my_cards');
    if (error) return { status: 'unavailable' };
    const rows = (data ?? []) as Record<string, unknown>[];
    const cards = rows.map((row) => ({
      userCardId: String(row.user_card_id ?? ''),
      obtainedAt: (row.obtained_at as string | null) ?? null,
      variant: isCardVariant(row.variant) ? row.variant : 'base',
      packId: (row.pack_id as string | null) ?? null,
      // `card_id` is the card's slug; the rest of the row IS the card.
      card: normalizeCard({ ...row, id: row.card_id ?? row.id }),
    }));
    cards.sort((a, b) => (b.obtainedAt ?? '').localeCompare(a.obtainedAt ?? ''));
    return { status: 'ok', cards };
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * Owned copies collapsed to one entry per card, rarest first then A–Z.
 *
 * Rarity descending is the order a binder is actually kept in — the secret
 * rare goes at the front, not wherever the alphabet puts it. Title is the
 * tiebreak so the grid is stable between refreshes.
 */
export function groupOwnedCards(owned: OwnedCard[]): OwnedGroup[] {
  const groups = new Map<string, OwnedGroup>();

  for (const copy of owned) {
    const id = copy.card.id;
    let group = groups.get(id);
    if (!group) {
      group = {
        card: copy.card,
        copies: 0,
        variants: [],
        countsByVariant: emptyVariantCounts(),
        firstObtainedAt: null,
        newest: null,
      };
      groups.set(id, group);
    }
    group.copies += 1;
    group.countsByVariant[copy.variant] += 1;
    const at = copy.obtainedAt;
    if (at) {
      if (!group.firstObtainedAt || at < group.firstObtainedAt) group.firstObtainedAt = at;
      if (!group.newest || at > group.newest) group.newest = at;
    }
  }

  for (const group of groups.values()) {
    group.variants = CARD_VARIANTS.filter((variant) => group.countsByVariant[variant] > 0);
  }

  return [...groups.values()].sort((a, b) => {
    const rarity = RARITY_RANK[b.card.rarity] - RARITY_RANK[a.card.rarity];
    if (rarity !== 0) return rarity;
    return a.card.title.localeCompare(b.card.title);
  });
}

/** This person's copies of one card, out of a list they already have. */
export function ownershipOf(owned: OwnedCard[], cardId: string): CardOwnership {
  const ownership: CardOwnership = {
    copies: 0,
    countsByVariant: emptyVariantCounts(),
    newest: null,
  };
  for (const copy of owned) {
    if (copy.card.id !== cardId) continue;
    ownership.copies += 1;
    ownership.countsByVariant[copy.variant] += 1;
    if (copy.obtainedAt && (!ownership.newest || copy.obtainedAt > ownership.newest)) {
      ownership.newest = copy.obtainedAt;
    }
  }
  return ownership;
}

/**
 * One card AND this person's copies of it, read from their own deck.
 *
 * This is the fallback that makes `/cards/[id]` work for a crew member: the
 * catalog read returns nothing for them, but `my_cards()` carries the full
 * card row for anything they've pulled. Null when they don't own it — which,
 * for a viewer, is the same answer as "no such card", and deliberately so.
 */
export async function fetchOwnedCard(
  cardId: string,
): Promise<{ card: CardRecord; ownership: CardOwnership } | null> {
  const result = await fetchMyCards();
  if (result.status !== 'ok') return null;
  const copies = result.cards.filter((copy) => copy.card.id === cardId);
  const first = copies[0];
  if (!first) return null;
  return { card: first.card, ownership: ownershipOf(copies, cardId) };
}

/**
 * Open a pack. THE SERVER DEALS IT.
 *
 * Seven cards in fixed rarity slots (four common, two uncommon, one hit) with
 * the foil/holo rolls made server-side, debited against the packs this person
 * has earned. The client's only jobs are to ask, to show what came out, and
 * to be honest when the answer is no.
 *
 * Error mapping, and why it is by SQLSTATE rather than by message text:
 *   P0001  the function's own raise — "no packs yet". The server's wording is
 *          passed straight through so the rule is stated once, in the
 *          database, not paraphrased in three screens.
 *   42501  not signed in as staff. Reported as `unavailable`, not as a
 *          failure the person could fix by tapping again.
 *   other  network, timeout, a migration mid-flight → `unavailable`.
 *
 * The pulled cards are hydrated from `my_cards()` in a second read, because
 * `open_card_pack` returns ownership rows rather than card rows. If that read
 * fails the pack is STILL open and the copies are STILL banked — the reveal
 * just has less to draw, which is why `card` is nullable rather than an error.
 */
export async function openPack(): Promise<OpenPackResult> {
  try {
    const { data, error } = await supabase.rpc('open_card_pack');
    if (error) {
      const code = (error as { code?: string }).code ?? '';
      const message = (error as { message?: string }).message ?? '';
      if (code === 'P0001') {
        return {
          ok: false,
          code: 'no_packs',
          message:
            message.trim() ||
            'No packs available yet — you earn one for every 10 hours worked.',
        };
      }
      if (code === '42501') {
        return {
          ok: false,
          code: 'unavailable',
          message: 'Sign in as a crew member to open packs.',
        };
      }
      return {
        ok: false,
        code: 'unavailable',
        message: message.trim() || 'The pack could not be opened. Try again in a moment.',
      };
    }

    const rows = (data ?? []) as Record<string, unknown>[];
    if (rows.length === 0) {
      return {
        ok: false,
        code: 'unavailable',
        message: 'The pack came back empty. Try again in a moment.',
      };
    }

    const pulls = rows
      .map((row) => ({
        userCardId: String(row.user_card_id ?? ''),
        cardId: String(row.card_id ?? ''),
        variant: isCardVariant(row.variant) ? row.variant : 'base',
        isNew: Boolean(row.is_new),
        slot: num(row.slot) ?? 0,
        card: null as CardRecord | null,
      }))
      .sort((a, b) => a.slot - b.slot);

    const mine = await fetchMyCards();
    if (mine.status === 'ok') {
      const byCopy = new Map(mine.cards.map((copy) => [copy.userCardId, copy.card]));
      const byCard = new Map(mine.cards.map((copy) => [copy.card.id, copy.card]));
      for (const pull of pulls) {
        pull.card = byCopy.get(pull.userCardId) ?? byCard.get(pull.cardId) ?? null;
      }
    }

    return { ok: true, cards: pulls };
  } catch (e) {
    return {
      ok: false,
      code: 'unavailable',
      message: e instanceof Error ? e.message : 'The pack could not be opened.',
    };
  }
}

/** Pulled within the last day — what the deck's "New" filter means. */
export const NEW_CARD_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isRecentlyObtained(at: string | null, now = Date.now()): boolean {
  if (!at) return false;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return false;
  return now - ms <= NEW_CARD_WINDOW_MS;
}

/** "×3" for the grid badge, or null for a single copy. */
export function copiesLabel(copies: number): string | null {
  return copies > 1 ? `×${copies}` : null;
}

/** "You own ×3 (foil ×1, holo ×1)". Null when this person owns none. */
export function ownershipLabel(ownership: CardOwnership): string | null {
  if (ownership.copies < 1) return null;
  const extras: string[] = [];
  if (ownership.countsByVariant.foil > 0) extras.push(`foil ×${ownership.countsByVariant.foil}`);
  if (ownership.countsByVariant.holo > 0) extras.push(`holo ×${ownership.countsByVariant.holo}`);
  const base = `You own ×${ownership.copies}`;
  return extras.length > 0 ? `${base} (${extras.join(', ')})` : base;
}

export function variantLabel(variant: CardVariant): string {
  return variant === 'base' ? 'Base' : variant === 'foil' ? 'Foil' : 'Holo';
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
