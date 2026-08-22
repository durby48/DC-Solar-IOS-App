/**
 * The photo library: `media_assets`, `dropbox_folders`, and the `dropbox-sync`
 * edge function.
 *
 * Devon drops photos into two Dropbox folders and a scheduled function mirrors
 * them into the EXISTING private `job-photos` bucket —
 * `eom/library/<id>.<ext>` and `marketing/<YYYY>/<id>.<ext>` — writing one
 * `media_assets` row per file. This module is everything the app does with
 * those rows. See supabase/migrations/2026-08-22_media_dropbox.sql,
 * supabase/functions/dropbox-sync/index.ts and docs/DROPBOX_SETUP.md.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * "NOT CONNECTED YET" IS A FIRST-CLASS ANSWER, NOT AN ERROR
 * ─────────────────────────────────────────────────────────────────────────
 * Until Devon completes the fifteen-minute Dropbox setup the function answers
 * `503 not_configured` — by design, not as a fault. Every path in this module
 * distinguishes that from a real failure so the UI can say "Dropbox isn't
 * connected yet — see docs/DROPBOX_SETUP.md" instead of "Sync failed", which
 * would send somebody looking for a bug that isn't there.
 *
 * ONE SIGNING REQUEST. `fetchMediaUrls` signs the whole page in a single
 * `createSignedUrls` call, the way `lib/artwork.ts::fetchArtworkUrls` signs
 * the pipeline's property art. Sixty thumbnails must never mean sixty round
 * trips from a phone parked in a driveway.
 *
 * ONE WAY, ALWAYS. Nothing here writes to Dropbox and nothing here deletes a
 * storage object. `archiveMediaAsset` stamps `archived_at`; the bytes stay.
 *
 * NEVER UPLOAD TO THESE PREFIXES FROM A CLIENT. `job-photos` has no UPDATE
 * policy, so the stable paths the sync writes can only be rewritten by the
 * service role. Reads and metadata edits are all this module does.
 *
 * Nothing here throws.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';
const PHOTO_BUCKET = 'job-photos';
/** Signed URLs live an hour; every gallery refetches on focus or pull anyway. */
const SIGNED_URL_TTL = 3600;
const DEFAULT_LIMIT = 200;

/**
 * The one sentence the whole app says about an unconfigured Dropbox. Shown by
 * the gallery header, the "Sync now" button and the EOM picker alike, so a
 * person who sees it twice sees the same words twice.
 */
export const DROPBOX_NOT_CONFIGURED =
  "Dropbox isn't connected yet — see docs/DROPBOX_SETUP.md.";

export type MediaUsage = 'eom' | 'marketing';

export interface MediaAsset {
  id: string;
  usage: MediaUsage;
  /** 'dropbox' for a mirrored file, 'upload' for one added in the app. */
  source: string;
  storageBucket: string;
  storagePath: string;
  fileName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  /** EXIF capture time when Dropbox reported one, else the modified time. */
  takenAt: string | null;
  createdAt: string;
  caption: string | null;
  tags: string[];
  jobId: string | null;
  featured: boolean;
  archivedAt: string | null;
}

export type MediaAssetsResult =
  | { status: 'ok'; assets: MediaAsset[] }
  | { status: 'unavailable' };

interface MediaRow {
  id: string;
  usage: string;
  source: string | null;
  storage_bucket: string | null;
  storage_path: string;
  file_name: string | null;
  content_type: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  taken_at: string | null;
  created_at: string;
  caption: string | null;
  tags: string[] | null;
  job_id: string | null;
  featured: boolean | null;
  archived_at: string | null;
}

const SELECT_COLUMNS =
  'id, usage, source, storage_bucket, storage_path, file_name, content_type, ' +
  'size_bytes, width, height, taken_at, created_at, caption, tags, job_id, ' +
  'featured, archived_at';

function toAsset(row: MediaRow): MediaAsset {
  return {
    id: row.id,
    usage: (row.usage === 'eom' ? 'eom' : 'marketing') as MediaUsage,
    source: row.source ?? 'dropbox',
    storageBucket: row.storage_bucket ?? PHOTO_BUCKET,
    storagePath: row.storage_path,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    takenAt: row.taken_at,
    createdAt: row.created_at,
    caption: row.caption,
    tags: Array.isArray(row.tags) ? row.tags.filter((t) => typeof t === 'string') : [],
    jobId: row.job_id,
    featured: row.featured === true,
    archivedAt: row.archived_at,
  };
}

export interface FetchMediaOptions {
  /** Only assets carrying this tag (Postgres `tags @> {tag}`). */
  tag?: string | null;
  /** Only assets tagged to this job. */
  jobId?: string | null;
  limit?: number;
  /** Archived rows are hidden unless this is true. */
  includeArchived?: boolean;
}

/**
 * One page of the library, newest first.
 *
 * Ordered `taken_at desc nulls last, created_at desc` — a file with no EXIF
 * date belongs at the bottom of the grid rather than jumping to the top on a
 * null, and the sync time breaks the remaining ties. Same ordering as
 * `lib/marketingPhotos.ts`, so the strip and the full gallery agree about
 * what "newest" means.
 *
 * A missing table (migration not applied) and an RLS refusal both land on
 * `unavailable`; the caller decides whether that is worth a sentence.
 */
export async function fetchMediaAssets(
  usage: MediaUsage,
  options: FetchMediaOptions = {},
): Promise<MediaAssetsResult> {
  try {
    let query = supabase
      .from('media_assets')
      .select(SELECT_COLUMNS)
      .eq('company', COMPANY)
      .eq('usage', usage);

    if (!options.includeArchived) query = query.is('archived_at', null);
    if (options.tag) query = query.contains('tags', [options.tag]);
    if (options.jobId) query = query.eq('job_id', options.jobId);

    const { data, error } = await query
      .order('taken_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(Math.max(1, options.limit ?? DEFAULT_LIMIT));

    if (error || !data) return { status: 'unavailable' };
    return { status: 'ok', assets: (data as unknown as MediaRow[]).map(toAsset) };
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * Signed display URLs for a batch of assets, keyed by asset id.
 *
 * ONE request for the whole grid. Assets are grouped by bucket first because
 * `createSignedUrls` is per-bucket — today everything is in `job-photos`, but
 * the column exists and guessing wrong would silently drop half a gallery.
 * Whatever fails to sign is simply absent from the map; the grid draws a
 * placeholder tile for it rather than an error.
 */
export async function fetchMediaUrls(assets: MediaAsset[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  if (assets.length === 0) return urls;

  const byBucket = new Map<string, MediaAsset[]>();
  for (const asset of assets) {
    if (!asset.storagePath) continue;
    const bucket = asset.storageBucket || PHOTO_BUCKET;
    const list = byBucket.get(bucket);
    if (list) list.push(asset);
    else byBucket.set(bucket, [asset]);
  }

  for (const [bucket, list] of byBucket) {
    try {
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrls(
          list.map((a) => a.storagePath),
          SIGNED_URL_TTL,
        );
      if (error || !data) continue;
      data.forEach((entry, index) => {
        const signed = (entry as { signedUrl?: string | null }).signedUrl;
        const asset = list[index];
        if (signed && asset) urls.set(asset.id, signed);
      });
    } catch {
      // Keep whatever the other buckets managed to sign.
    }
  }
  return urls;
}

export type MediaMutationResult = { ok: true } | { ok: false; message: string };

function writeMessage(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (/row-level security|policy/i.test(raw)) {
    return 'Only owners and operators can change photo details.';
  }
  if (/relation .* does not exist|schema cache/i.test(raw)) {
    return 'The photo library needs the latest database migration.';
  }
  return raw;
}

export interface MediaAssetPatch {
  caption?: string | null;
  tags?: string[];
  jobId?: string | null;
  featured?: boolean;
}

/**
 * Edit one asset's metadata. Admin-only server-side (`ma_admin_update`); the
 * pencil is drawn for admins as a courtesy, RLS is the barrier.
 *
 * Only the keys actually present in `patch` are written, so setting a caption
 * cannot blank somebody else's tags. An empty caption string is stored as
 * NULL — "" and "no caption" are the same thing to a reader, and NULL is what
 * every query already tests for.
 */
export async function updateMediaAsset(
  id: string,
  patch: MediaAssetPatch,
): Promise<MediaMutationResult> {
  if (!id) return { ok: false, message: 'Unknown photo.' };
  const payload: Record<string, unknown> = {};
  if ('caption' in patch) {
    const trimmed = (patch.caption ?? '').trim();
    payload.caption = trimmed.length > 0 ? trimmed : null;
  }
  if ('tags' in patch && Array.isArray(patch.tags)) {
    payload.tags = normalizeTags(patch.tags);
  }
  if ('jobId' in patch) payload.job_id = patch.jobId ?? null;
  if ('featured' in patch) payload.featured = patch.featured === true;
  if (Object.keys(payload).length === 0) return { ok: true };

  try {
    const { error } = await supabase.from('media_assets').update(payload).eq('id', id);
    if (error) return { ok: false, message: writeMessage(error.message, 'Could not save that.') };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save that.' };
  }
}

/**
 * Hide an asset from every gallery.
 *
 * ARCHIVE, NEVER DELETE. The row is stamped and the object in `job-photos`
 * is left exactly where it is — the same promise the sync makes when a file
 * disappears from Dropbox. A photo somebody archived by accident is one
 * `archived_at = null` away from coming back; a deleted object is gone. It
 * also has to work this way: a re-sync would otherwise re-import the file and
 * the archive would undo itself every night.
 */
export async function archiveMediaAsset(id: string): Promise<MediaMutationResult> {
  if (!id) return { ok: false, message: 'Unknown photo.' };
  try {
    const { error } = await supabase
      .from('media_assets')
      .update({ archived_at: new Date().toISOString() })
      .eq('id', id);
    if (error) {
      return { ok: false, message: writeMessage(error.message, 'Could not archive that photo.') };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not archive that photo.',
    };
  }
}

/** Lower-cased, trimmed, de-duplicated, empties dropped. Order is preserved. */
export function normalizeTags(input: string[] | string): string[] {
  const raw = Array.isArray(input) ? input : input.split(',');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const tag = String(item ?? '').trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/**
 * A `timestamptz` as a short human date.
 *
 * `lib/dates.ts::formatShortDate` CANNOT be used for these. It parses a
 * date-only `YYYY-MM-DD` by splitting on '-', so a full ISO timestamp becomes
 * `Number('22T15:04:00Z')` → NaN → the string "Invalid Date", which is exactly
 * what the browser preview printed under the first photo before this existed.
 * Every date in this module — `taken_at`, `created_at`, `last_synced_at` — is
 * a timestamp, not a scheduling date.
 *
 * Returns null rather than a placeholder: a photo with no capture time should
 * show no line at all, not the word "Unscheduled".
 */
export function formatTimestamp(
  iso: string | null | undefined,
  options: { withTime?: boolean } = {},
): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  if (!options.withTime) return day;
  return `${day}, ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

/** Every distinct tag across a set of assets, alphabetically. */
export function collectTags(assets: MediaAsset[]): string[] {
  const seen = new Set<string>();
  for (const asset of assets) for (const tag of asset.tags) seen.add(tag);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Dropbox: status and manual sync
// ---------------------------------------------------------------------------

export interface DropboxFolderStatus {
  usage: MediaUsage;
  /** The Dropbox path being watched, e.g. `/marketing`. */
  pathLower: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  fileCount: number;
}

export type DropboxStatusResult =
  | { status: 'ok'; folders: DropboxFolderStatus[] }
  | { status: 'unavailable' };

/**
 * What the sync last did, per folder. Member-readable by design — the crew can
 * see when photos last came in — and it holds no credentials whatsoever
 * (`integration_secrets` has RLS on with zero policies and is unreachable
 * from any client key, which is the point of it).
 */
export async function fetchDropboxStatus(): Promise<DropboxStatusResult> {
  try {
    const { data, error } = await supabase
      .from('dropbox_folders')
      .select('usage, path_lower, last_synced_at, last_error, file_count')
      .eq('company', COMPANY)
      .order('usage', { ascending: true });
    if (error || !data) return { status: 'unavailable' };
    const folders = (data as Record<string, unknown>[]).map((row) => ({
      usage: (row.usage === 'eom' ? 'eom' : 'marketing') as MediaUsage,
      pathLower: String(row.path_lower ?? ''),
      lastSyncedAt: (row.last_synced_at as string | null) ?? null,
      lastError: (row.last_error as string | null) ?? null,
      fileCount: typeof row.file_count === 'number' ? row.file_count : 0,
    }));
    return { status: 'ok', folders };
  } catch {
    return { status: 'unavailable' };
  }
}

export interface DropboxSyncFolderResult {
  usage: string;
  scanned: number;
  imported: number;
  updated: number;
  skipped: number;
  archived: number;
  cursor?: string | null;
  error?: string | null;
}

export type DropboxSyncResult =
  | { ok: true; results: DropboxSyncFolderResult[] }
  | { ok: false; code: 'not_configured' | 'unauthorized' | 'failed'; message: string };

/**
 * The HTTP status hiding on a supabase-js FunctionsHttpError.
 *
 * supabase-js flattens every non-2xx into the single useless string "Edge
 * Function returned a non-2xx status code" and parks the real `Response` on
 * `error.context`. Without reading it, "Dropbox was never set up" (503) and
 * "Dropbox rejected the token" (502) look identical to the person pressing
 * Sync now. Same helper as `lib/cards.ts::functionStatus`.
 */
function functionStatus(error: unknown): number | null {
  const context = (error as { context?: unknown })?.context;
  if (!context || typeof context !== 'object') return null;
  const status = (context as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

/** Peek at a failed invoke()'s JSON body without consuming it. */
async function readFunctionPayload(error: unknown): Promise<Record<string, unknown> | null> {
  const context = (error as { context?: unknown })?.context;
  if (!context || typeof context !== 'object') return null;
  const response = context as Response;
  try {
    if (typeof response.clone === 'function') {
      return (await response.clone().json()) as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }
  return null;
}

/** The human-readable `error` string from a failed invoke, when there is one. */
async function readFunctionError(error: unknown): Promise<string | null> {
  const payload = await readFunctionPayload(error);
  const message = payload?.error;
  if (typeof message === 'string' && message.trim().length > 0) return message.trim();
  const context = (error as { context?: unknown })?.context;
  if (!context || typeof context !== 'object') return null;
  try {
    const response = context as Response;
    if (typeof response.text === 'function') {
      const text = await response.text();
      if (text.trim().length > 0) return text.trim().slice(0, 300);
    }
  } catch {
    // give up; the caller falls back to a generic message
  }
  return null;
}

/**
 * Run the Dropbox sync now (the admin "Sync now" button).
 *
 * `verify_jwt` is FALSE on the function — it accepts either the scheduler's
 * `x-sync-secret` or an admin's Bearer JWT and checks the JWT itself with the
 * service role, so supabase-js attaching the session is enough here and a
 * viewer pressing this gets a 401 from the server rather than a client-side
 * guard we could forget.
 *
 * 503 → `not_configured`: the one-time Dropbox setup has not been done. That
 * is the expected state today, so it is a distinct code rather than an error
 * message, and every caller shows the docs pointer instead of a failure.
 *
 * Never throws.
 */
export async function syncDropbox(
  usage: MediaUsage | 'all' = 'all',
  options: { full?: boolean; limit?: number } = {},
): Promise<DropboxSyncResult> {
  try {
    const { data, error } = await supabase.functions.invoke('dropbox-sync', {
      body: {
        usage,
        ...(options.full ? { full: true } : {}),
        ...(options.limit ? { limit: options.limit } : {}),
      },
    });

    if (error) {
      const status = functionStatus(error);
      const payload = await readFunctionPayload(error);
      if (status === 503 || payload?.code === 'not_configured') {
        return { ok: false, code: 'not_configured', message: DROPBOX_NOT_CONFIGURED };
      }
      if (status === 401 || status === 403) {
        return {
          ok: false,
          code: 'unauthorized',
          message: 'Only owners and operators can run the Dropbox sync.',
        };
      }
      const detail = await readFunctionError(error);
      return {
        ok: false,
        code: 'failed',
        message: detail ?? error.message ?? 'The Dropbox sync failed.',
      };
    }

    const result = data as
      | { ok?: boolean; code?: string; error?: string; results?: DropboxSyncFolderResult[] }
      | null;
    // A 200 body can still carry `code: not_configured` on some transports.
    if (result?.code === 'not_configured') {
      return { ok: false, code: 'not_configured', message: DROPBOX_NOT_CONFIGURED };
    }
    if (!result?.ok || !Array.isArray(result.results)) {
      return { ok: false, code: 'failed', message: result?.error ?? 'The Dropbox sync failed.' };
    }
    return { ok: true, results: result.results };
  } catch (e) {
    return {
      ok: false,
      code: 'failed',
      message: e instanceof Error ? e.message : 'The Dropbox sync failed.',
    };
  }
}

/**
 * "12 new · 3 updated · 40 unchanged" — what a person actually wants to read
 * after pressing Sync now. A second sync of the same folder says "nothing new",
 * which is the correct and reassuring answer rather than a row of zeroes.
 */
export function summarizeSync(results: DropboxSyncFolderResult[]): string {
  const total = results.reduce(
    (acc, r) => ({
      imported: acc.imported + (r.imported || 0),
      updated: acc.updated + (r.updated || 0),
      skipped: acc.skipped + (r.skipped || 0),
      archived: acc.archived + (r.archived || 0),
    }),
    { imported: 0, updated: 0, skipped: 0, archived: 0 },
  );
  const parts: string[] = [];
  if (total.imported) parts.push(`${total.imported} new`);
  if (total.updated) parts.push(`${total.updated} updated`);
  if (total.archived) parts.push(`${total.archived} archived`);
  if (parts.length === 0) {
    return total.skipped > 0 ? `Nothing new — ${total.skipped} already here.` : 'Nothing new.';
  }
  if (total.skipped) parts.push(`${total.skipped} unchanged`);
  return `${parts.join(' · ')}.`;
}

/** The first folder error the sync reported, if any. */
export function firstSyncError(results: DropboxSyncFolderResult[]): string | null {
  for (const result of results) {
    if (result.error) return result.error;
  }
  return null;
}
