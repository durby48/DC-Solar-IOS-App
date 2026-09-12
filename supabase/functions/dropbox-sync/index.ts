/**
 * dropbox-sync — mirror the EOM and Marketing Dropbox folders into the app.
 *
 * ONE WAY, ALWAYS. Nothing here writes to Dropbox and nothing here deletes a
 * storage object. A file that disappears from Dropbox gets `archived_at`
 * stamped on its `media_assets` row and the bytes stay where they are: losing
 * a marketing photo because somebody tidied a folder is not a failure mode
 * worth having.
 *
 * WHAT MAKES IT CHEAP TO RUN OFTEN
 *   • the Dropbox list cursor is stored per folder, so the second sync of the
 *     day lists only what changed (`full: true` forces a rescan);
 *   • same dropbox_id + same rev → skipped without downloading;
 *   • same id, NEW rev → re-downloaded over the SAME storage path, so every
 *     signed URL already handed out keeps working;
 *   • the same bytes under a new filename (Dropbox's content_hash) → skipped
 *     and counted, not stored twice, PROVIDED the row holding them is still
 *     live. If only ARCHIVED rows hold that hash the photo was deleted from
 *     Dropbox and put back, so the archived row is re-adopted and un-archived
 *     rather than the file being skipped into permanent limbo.
 *
 * `limit` BOUNDS PAGES FETCHED, NOT ENTRIES APPLIED. Every entry that was
 * fetched is applied before the cursor moves. Applying only the first `limit`
 * of them (what this used to do) stored a cursor positioned AFTER entries that
 * had never been looked at — they were skipped on every future run too.
 *
 * AUTH — two doors, because two callers:
 *   • `x-sync-secret: <DROPBOX_SYNC_SECRET>` for the scheduled run (pg_cron →
 *     pg_net → here). Cron has no session.
 *   • a Bearer JWT belonging to an owner/operator for the admin "Sync now"
 *     button. verify_jwt is FALSE on this function, so the JWT is checked
 *     here with the service role — the header is not authorisation by itself.
 * Anything else is 401.
 *
 * WHERE THE TOKENS LIVE. `integration_secrets` — RLS on, ZERO policies, so
 * only the service role can read it. The Dropbox access token expires every
 * four hours and this function stores the refreshed one, which is exactly why
 * the credentials cannot live in edge-function secrets: the Management API
 * secrets endpoint is not a runtime store.
 *
 * Storage layout inside the existing private `job-photos` bucket:
 *   eom/library/<dropboxId>.<ext>
 *   marketing/<YYYY>/<dropboxId>.<ext>
 * Never upload to those prefixes from a client — the bucket has no UPDATE
 * policy, so a stable path can only be rewritten by the service role.
 *
 * POST { usage?: 'eom'|'marketing'|'all', full?: boolean, limit?: number }
 *   → { ok: true, results: [{ usage, scanned, imported, updated, skipped, archived, cursor, error }] }
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 2026-09-12: JOB FOLDERS + PHOTO MIRRORING (the one exception to "one way")
 * ─────────────────────────────────────────────────────────────────────────
 * Devon: "any pictures uploaded into any project should be stored in a
 * Dropbox folder … when a project is made in the pipeline it should
 * automatically make a Dropbox folder too." So this function now also WRITES
 * to Dropbox — but only ever creates folders and ADDS files. It never deletes,
 * moves or overwrites anything there: Dropbox is the append-only archive.
 *
 * Triggers (migration 2026-09-12_dropbox_job_folders.sql) enqueue a row and
 * POST here through pg_net with the same x-sync-secret; a 15-minute pg_cron
 * job re-drives anything that is still queued or failed. The rows are the
 * queue, the HTTP call is only a nudge — a lost call costs fifteen minutes.
 *
 *   { action: 'ensure_job_folder', job_id }
 *       create `/DC Solar/Jobs/<job_number> - <customer>` (idempotent — an
 *       existing folder is adopted by id), record it in dropbox_job_folders.
 *   { action: 'mirror_photo', photo_id }
 *       download the job_photos object from Storage with the service role,
 *       upload it into the job's folder (files/upload, mode add, autorename),
 *       record it in dropbox_photo_mirrors. Ensures the folder first.
 *   { action: 'retry_mirrors', limit? }
 *       drain queued/failed folders and photos with < MAX_ATTEMPTS tries.
 *   { action: 'backfill_job_folders', limit?, reset_failed? }
 *   { action: 'backfill_photo_mirrors', limit?, reset_failed? }
 *       one-time: enqueue every existing job / photo that has no row yet
 *       (dropbox_enqueue_backlog RPC), then drain up to `limit`. Re-runnable.
 *
 * The Dropbox app needs `files.content.write` for any of this. Without it
 * Dropbox answers `missing_scope`; the row is marked failed with a message
 * that says exactly that, and nothing else in the app is affected.
 *
 * Never logged: photo bytes, tokens. Errors quote at most 300 chars of the
 * Dropbox reply, which never contains either.
 *
 * Setup: docs/DROPBOX_SETUP.md.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-sync-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const COMPANY = 'dc-solar';
const BUCKET = 'job-photos';
const PAGE_SIZE = 200;
const DEFAULT_LIMIT = 200;
/** Refresh the access token this far before it actually expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Root of the per-job folders, inside the Dropbox app folder. */
const JOBS_ROOT = '/DC Solar/Jobs';
/** A queued/failed row is retried by the cron until it has been tried this often. */
const MAX_ATTEMPTS = 5;
/** Rows drained per retry / backfill call. Edge functions have a wall clock. */
const DRAIN_LIMIT = 25;
const MAX_DRAIN_LIMIT = 100;

const IMAGE_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  webp: 'image/webp',
};

function ok(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, ...payload }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

function fail(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ ok: false, code, error }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function extensionOf(name: string): string | null {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : null;
}

/** "id:a4ayc_80_OEAAAAAAAAAYa" → "a4ayc_80_OEAAAAAAAAAYa"; also safe for a path. */
function assetKey(dropboxId: string): string {
  return dropboxId.replace(/^id:/, '').replace(/[^A-Za-z0-9_-]/g, '');
}

interface DropboxCreds {
  client_id: string;
  client_secret: string;
  access_token: string | null;
  refresh_token: string;
  expires_at: string | null;
}

interface FolderRow {
  usage: string;
  path_lower: string;
  cursor: string | null;
}

interface FileEntry {
  '.tag': string;
  id?: string;
  name?: string;
  path_lower?: string;
  path_display?: string;
  rev?: string;
  size?: number;
  content_hash?: string;
  client_modified?: string;
  server_modified?: string;
  media_info?: {
    '.tag'?: string;
    metadata?: {
      '.tag'?: string;
      dimensions?: { width?: number; height?: number };
      time_taken?: string;
    };
  };
}

/** The bits of a media_assets row this sync needs to decide what to do next. */
interface MediaAssetRef {
  id: string;
  dropbox_rev: string | null;
  storage_path: string;
  archived_at: string | null;
}

interface FolderResult {
  usage: string;
  scanned: number;
  imported: number;
  updated: number;
  skipped: number;
  archived: number;
  cursor: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Dropbox
// ---------------------------------------------------------------------------

/**
 * Return a usable access token, refreshing and STORING it when it is missing
 * or within five minutes of expiry. Storing it back is the whole reason the
 * credentials live in a table rather than in function secrets.
 */
async function accessToken(admin: SupabaseClient, creds: DropboxCreds): Promise<string> {
  const expiresAt = creds.expires_at ? Date.parse(creds.expires_at) : NaN;
  const stillGood =
    creds.access_token && Number.isFinite(expiresAt) && expiresAt - Date.now() > REFRESH_MARGIN_MS;
  if (stillGood) return creds.access_token!;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refresh_token,
  });
  const res = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${creds.client_id}:${creds.client_secret}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(
      `Dropbox refused the refresh token (${res.status}): ${detail}. ` +
        'Mint a new one — the steps are in docs/DROPBOX_SETUP.md.',
    );
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('Dropbox returned no access token.');

  const newExpiry = new Date(Date.now() + (json.expires_in ?? 14400) * 1000).toISOString();
  await admin
    .from('integration_secrets')
    .update({
      access_token: json.access_token,
      expires_at: newExpiry,
      updated_at: new Date().toISOString(),
    })
    .eq('company', COMPANY)
    .eq('provider', 'dropbox');

  return json.access_token;
}

async function dropboxRpc(
  token: string,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Dropbox ${endpoint} failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// One folder
// ---------------------------------------------------------------------------

async function syncFolder(
  admin: SupabaseClient,
  token: string,
  folder: FolderRow,
  opts: { full: boolean; limit: number },
): Promise<FolderResult> {
  const result: FolderResult = {
    usage: folder.usage,
    scanned: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    archived: 0,
    cursor: folder.cursor,
    error: null,
  };

  try {
    // --- list ---------------------------------------------------------------
    const entries: FileEntry[] = [];
    let cursor: string | null = opts.full ? null : folder.cursor;
    let hasMore = true;

    while (hasMore && entries.length < opts.limit) {
      const page: Record<string, unknown> = cursor
        ? await dropboxRpc(token, 'files/list_folder/continue', { cursor })
        : await dropboxRpc(token, 'files/list_folder', {
            path: folder.path_lower,
            recursive: true,
            include_media_info: true,
            include_deleted: true,
            limit: PAGE_SIZE,
          });
      const pageEntries = (page.entries as FileEntry[] | undefined) ?? [];
      entries.push(...pageEntries);
      cursor = (page.cursor as string | undefined) ?? cursor;
      hasMore = page.has_more === true;
    }
    result.cursor = cursor;

    // --- apply --------------------------------------------------------------
    // EVERY entry that was fetched gets applied. `opts.limit` bounds how many
    // pages the loop above asks Dropbox for, and nothing else: it used to cap
    // this loop as well, so a page could push `entries` past the limit and the
    // tail went unapplied — while `result.cursor` was already the cursor from
    // AFTER that page. Storing it meant those entries were never seen again on
    // any later run. A page is at most PAGE_SIZE entries, so the real ceiling
    // is limit + PAGE_SIZE and that is fine; skipping photos forever is not.
    for (const entry of entries) {
      // A file removed from Dropbox is archived, never deleted. Deleted
      // entries carry no id, so they are matched on the path.
      if (entry['.tag'] === 'deleted') {
        const path = entry.path_lower;
        if (!path) continue;
        const { data: hit } = await admin
          .from('media_assets')
          .update({ archived_at: new Date().toISOString() })
          .eq('company', COMPANY)
          .eq('dropbox_path', path)
          .is('archived_at', null)
          .select('id');
        result.archived += (hit as unknown[] | null)?.length ?? 0;
        continue;
      }

      if (entry['.tag'] !== 'file' || !entry.id || !entry.name) continue;

      const ext = extensionOf(entry.name);
      const contentType = ext ? IMAGE_EXT[ext] : undefined;
      if (!ext || !contentType) continue; // not a photo — Dropbox holds other things too
      result.scanned += 1;

      const { data: existingRow } = await admin
        .from('media_assets')
        .select('id, dropbox_rev, storage_path, archived_at')
        .eq('company', COMPANY)
        .eq('dropbox_id', entry.id)
        .maybeSingle();
      let existing = existingRow as MediaAssetRef | null;

      // Nothing changed — the common case on every run after the first.
      if (existing && existing.dropbox_rev === entry.rev) {
        if (existing.archived_at) {
          // Same file, same revision, but the row is archived: it was removed
          // from Dropbox and put back (or restored from the Dropbox trash).
          // Bring it back without re-downloading — the storage object never
          // went anywhere and every signed URL already issued still resolves.
          const { error } = await admin
            .from('media_assets')
            .update({
              archived_at: null,
              file_name: entry.name,
              dropbox_path: entry.path_lower ?? entry.path_display ?? null,
            })
            .eq('id', existing.id);
          if (error) throw new Error(`Could not restore ${entry.name}: ${error.message}`);
          result.updated += 1;
        } else {
          result.skipped += 1;
        }
        continue;
      }

      // The same bytes under a different name — or the same photo deleted and
      // re-added, which Dropbox gives a brand new id and rev.
      if (!existing && entry.content_hash) {
        const { data: dupeRows } = await admin
          .from('media_assets')
          .select('id, dropbox_id, dropbox_rev, storage_path, archived_at')
          .eq('company', COMPANY)
          .eq('content_hash', entry.content_hash)
          // Live rows first (archived_at is null), so `live` below is found
          // even when several archived copies share the hash.
          .order('archived_at', { ascending: true, nullsFirst: true })
          .limit(5);
        const dupes = (dupeRows as (MediaAssetRef & { dropbox_id: string | null })[] | null) ?? [];
        const live = dupes.find((d) => !d.archived_at);
        const archived = dupes.find((d) => d.archived_at);

        if (live && live.dropbox_id !== entry.id) {
          // A LIVING row already holds these bytes. Genuinely a duplicate.
          console.log(
            `dropbox-sync: ${entry.path_lower} duplicates media_asset ${live.id} by content hash — skipped`,
          );
          result.skipped += 1;
          continue;
        }

        if (!live && archived) {
          // Only ARCHIVED rows hold these bytes, so this is a photo that came
          // back. Skipping it (what this used to do) left it archived forever —
          // deleted from the library with no way back short of a manual edit.
          // Re-adopt the row instead: it keeps its id, its storage path and
          // therefore every signed URL in circulation, and the code below
          // re-downloads to that same path and clears archived_at.
          console.log(
            `dropbox-sync: ${entry.path_lower} matches ARCHIVED media_asset ${archived.id} by content hash — un-archiving`,
          );
          existing = archived;
        }
      }

      const takenAt =
        entry.media_info?.metadata?.time_taken ??
        entry.client_modified ??
        entry.server_modified ??
        null;

      // A new revision keeps its original storage path so every signed URL
      // already in circulation keeps resolving.
      const year = takenAt ? new Date(takenAt).getUTCFullYear() : new Date().getUTCFullYear();
      const storagePath =
        existing?.storage_path ??
        (folder.usage === 'eom'
          ? `eom/library/${assetKey(entry.id)}.${ext}`
          : `marketing/${Number.isFinite(year) ? year : new Date().getUTCFullYear()}/${assetKey(entry.id)}.${ext}`);

      // --- download + store -------------------------------------------------
      const link = (await dropboxRpc(token, 'files/get_temporary_link', {
        path: entry.id,
      })) as { link?: string };
      if (!link.link) {
        result.skipped += 1;
        continue;
      }
      const fileRes = await fetch(link.link);
      if (!fileRes.ok) {
        result.skipped += 1;
        continue;
      }
      const bytes = new Uint8Array(await fileRes.arrayBuffer());

      const { error: upErr } = await admin.storage
        .from(BUCKET)
        .upload(storagePath, bytes, { contentType, upsert: true });
      if (upErr) throw new Error(`Could not store ${entry.name}: ${upErr.message}`);

      const row = {
        company: COMPANY,
        source: 'dropbox',
        usage: folder.usage,
        storage_bucket: BUCKET,
        storage_path: storagePath,
        file_name: entry.name,
        content_type: contentType,
        size_bytes: entry.size ?? bytes.byteLength,
        width: entry.media_info?.metadata?.dimensions?.width ?? null,
        height: entry.media_info?.metadata?.dimensions?.height ?? null,
        taken_at: takenAt,
        dropbox_id: entry.id,
        dropbox_rev: entry.rev ?? null,
        dropbox_path: entry.path_lower ?? entry.path_display ?? null,
        content_hash: entry.content_hash ?? null,
        // A file that came back after being removed from Dropbox is live again.
        archived_at: null,
      };

      if (existing) {
        const { error } = await admin.from('media_assets').update(row).eq('id', existing.id);
        if (error) throw new Error(`Could not update ${entry.name}: ${error.message}`);
        result.updated += 1;
      } else {
        const { error } = await admin.from('media_assets').insert(row);
        if (error) throw new Error(`Could not record ${entry.name}: ${error.message}`);
        result.imported += 1;
      }
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : 'Sync failed.';
  }

  // --- stamp the folder either way -----------------------------------------
  const { count } = await admin
    .from('media_assets')
    .select('id', { count: 'exact', head: true })
    .eq('company', COMPANY)
    .eq('usage', folder.usage)
    .is('archived_at', null);

  await admin
    .from('dropbox_folders')
    .update({
      // A failed run must not advance the cursor, or the files it never read
      // would be skipped forever.
      cursor: result.error ? folder.cursor : result.cursor,
      last_synced_at: new Date().toISOString(),
      last_error: result.error,
      file_count: count ?? 0,
    })
    .eq('company', COMPANY)
    .eq('usage', folder.usage);

  return result;
}

// ---------------------------------------------------------------------------
// Job folders + photo mirroring (2026-09-12) — the only code that WRITES to
// Dropbox. Creates folders, adds files. Never deletes, moves or overwrites.
// ---------------------------------------------------------------------------

type Action =
  | 'sync'
  | 'ensure_job_folder'
  | 'mirror_photo'
  | 'retry_mirrors'
  | 'backfill_job_folders'
  | 'backfill_photo_mirrors';

const ACTIONS: Action[] = [
  'sync',
  'ensure_job_folder',
  'mirror_photo',
  'retry_mirrors',
  'backfill_job_folders',
  'backfill_photo_mirrors',
];

interface JobFolderRow {
  job_id: string;
  company: string;
  path_display: string | null;
  path_lower: string | null;
  dropbox_folder_id: string | null;
  status: 'queued' | 'ready' | 'failed' | 'skipped';
  attempts: number;
  last_error: string | null;
}

interface MirrorRow {
  id: string;
  photo_id: string | null;
  job_id: string;
  company: string;
  storage_bucket: string;
  storage_path: string;
  status: 'queued' | 'mirrored' | 'failed' | 'skipped';
  attempts: number;
  last_error: string | null;
}

interface DropboxReply {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  text: string;
}

/** Outcome of one folder or photo attempt. `permanent` = do not retry. */
interface StepResult {
  ok: boolean;
  error: string | null;
  permanent?: boolean;
  path?: string | null;
}

/**
 * Like dropboxRpc, but hands back non-2xx replies instead of throwing, so the
 * caller can tell "folder already exists" (409 path/conflict/folder — fine)
 * from "no write scope" (401 missing_scope — needs Devon).
 */
async function dropboxCall(
  token: string,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<DropboxReply> {
  const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  return { ok: res.ok, status: res.status, body: json, text };
}

/**
 * A readable error for a failed Dropbox call. The one everybody will hit
 * first is `missing_scope`: the app was set up read-only on purpose in
 * August, and writing needs `files.content.write` plus a freshly minted
 * refresh token.
 */
function dropboxErrorMessage(endpoint: string, reply: DropboxReply): string {
  if (reply.text.includes('missing_scope')) {
    return (
      'Dropbox refused: the app lacks the files.content.write scope. Tick it in the ' +
      'Dropbox app console, then mint a NEW refresh token and store it (docs/DROPBOX_SETUP.md, ' +
      'steps 2, 4 and 5). Nothing can be written to Dropbox until then.'
    );
  }
  if (reply.text.includes('insufficient_space')) {
    return 'Dropbox refused: the Dropbox account is out of space.';
  }
  return `Dropbox ${endpoint} failed (${reply.status}): ${reply.text.slice(0, 300)}`;
}

/** Whether an error will NOT fix itself in fifteen minutes. */
function isPermanentDropboxError(reply: DropboxReply): boolean {
  return (
    reply.text.includes('missing_scope') ||
    reply.text.includes('disallowed_name') ||
    reply.text.includes('malformed_path')
  );
}

/**
 * The `Dropbox-API-Arg` header must be ASCII. Customer names are not always
 * ("José"), so every non-ASCII character is \u-escaped — the JSON parser on
 * the other end reads it identically.
 */
function dropboxApiArg(obj: Record<string, unknown>): string {
  return JSON.stringify(obj).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * One path segment Dropbox will accept and a person can read: slashes become
 * dashes (they would be treated as nesting), control characters go, runs of
 * whitespace collapse, trailing dots/spaces go (Dropbox rejects them), and it
 * is capped well under Dropbox's 255-byte limit.
 */
function sanitizeSegment(input: string | null | undefined): string {
  return String(input ?? '')
    .replace(/[\\/]/g, '-')
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120);
}

/** "DC-26037 - Cromwell Environmental"; falls back to the job name, then the id. */
function jobFolderName(
  job: { id: string; job_number: string | null; name: string | null },
  customerName: string | null,
): string {
  const number = sanitizeSegment(job.job_number);
  const who = sanitizeSegment(customerName) || sanitizeSegment(job.name);
  const parts = [number, who].filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join(' - ') : `Job ${job.id.slice(0, 8)}`;
}

/**
 * A readable file name for Dropbox: the app stores `<jobId>/<epochMs>-<name>.jpg`;
 * Dropbox gets `<YYYY-MM-DD> <name>.jpg` (the day the photo was added). Two
 * photos with the same name on the same day are fine — `autorename` appends
 * " (1)".
 */
function dropboxFileName(storagePath: string, createdAt: string | null): string {
  const base = (storagePath.split('/').pop() ?? 'photo.jpg').replace(/^\d{10,}-/, '');
  const clean = sanitizeSegment(base) || 'photo.jpg';
  const date = createdAt ? new Date(createdAt) : new Date();
  const stamp = Number.isNaN(date.getTime()) ? '' : `${date.toISOString().slice(0, 10)} `;
  return `${stamp}${clean}`;
}

async function markFolder(
  admin: SupabaseClient,
  jobId: string,
  patch: Partial<JobFolderRow>,
  bumpAttempts: boolean,
): Promise<void> {
  const { data } = await admin
    .from('dropbox_job_folders')
    .select('attempts')
    .eq('job_id', jobId)
    .maybeSingle();
  const attempts =
    ((data as { attempts?: number } | null)?.attempts ?? 0) + (bumpAttempts ? 1 : 0);
  await admin
    .from('dropbox_job_folders')
    .update({ ...patch, attempts, updated_at: new Date().toISOString() })
    .eq('job_id', jobId);
}

async function markMirror(
  admin: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
  bumpAttempts: boolean,
): Promise<void> {
  const { data } = await admin
    .from('dropbox_photo_mirrors')
    .select('attempts')
    .eq('id', id)
    .maybeSingle();
  const attempts =
    ((data as { attempts?: number } | null)?.attempts ?? 0) + (bumpAttempts ? 1 : 0);
  await admin
    .from('dropbox_photo_mirrors')
    .update({ ...patch, attempts, updated_at: new Date().toISOString() })
    .eq('id', id);
}

/**
 * Make sure `/DC Solar/Jobs/<number> - <customer>` exists for this job and
 * dropbox_job_folders knows about it. Idempotent three ways: a row already
 * 'ready' is returned without a Dropbox call; a folder that already exists
 * (409 path/conflict/folder) is adopted by looking up its id; and the row
 * itself is upserted, so calling this for a job the trigger never saw (the
 * backfill) works the same.
 */
async function ensureJobFolder(
  admin: SupabaseClient,
  token: string,
  jobId: string,
): Promise<StepResult> {
  const { data: jobRow } = await admin
    .from('jobs')
    .select('id, company, name, job_number, is_internal, customer_id')
    .eq('id', jobId)
    .maybeSingle();
  const job = jobRow as
    | {
        id: string;
        company: string;
        name: string | null;
        job_number: string | null;
        is_internal: boolean | null;
        customer_id: string | null;
      }
    | null;
  if (!job) return { ok: false, error: 'Job not found.', permanent: true };

  // Make sure the bookkeeping row exists (the trigger normally did this).
  await admin
    .from('dropbox_job_folders')
    .upsert(
      { job_id: job.id, company: job.company ?? COMPANY },
      { onConflict: 'job_id', ignoreDuplicates: true },
    );

  if (job.is_internal) {
    const error = 'Internal job — no Dropbox folder.';
    await markFolder(admin, job.id, { status: 'skipped', last_error: error }, false);
    return { ok: false, error, permanent: true };
  }

  const { data: existingRow } = await admin
    .from('dropbox_job_folders')
    .select('job_id, company, path_display, path_lower, dropbox_folder_id, status, attempts, last_error')
    .eq('job_id', job.id)
    .maybeSingle();
  const existing = existingRow as JobFolderRow | null;

  let customerName: string | null = null;
  if (job.customer_id) {
    const { data: customer } = await admin
      .from('customers')
      .select('name')
      .eq('id', job.customer_id)
      .maybeSingle();
    customerName = (customer as { name?: string | null } | null)?.name ?? null;
  }

  const path = `${JOBS_ROOT}/${jobFolderName(job, customerName)}`;

  // RENAME ON CHANGE (2026-09-12). "Ensure" means "the folder exists AT THE
  // EXPECTED PATH": when the folder already exists but the job was
  // renumbered, renamed, or moved to another customer, the folder is MOVED
  // (files/move_v2 — contents come along) rather than a second one created.
  // The update trigger on jobs/customers re-queues the row and nudges this
  // action; the retry cron covers a failed move the same as a failed create.
  if (existing?.dropbox_folder_id && existing.path_lower) {
    if (existing.path_lower === path.toLowerCase()) {
      if (existing.status !== 'ready') {
        await markFolder(admin, job.id, { status: 'ready', last_error: null }, false);
      }
      return { ok: true, error: null, path: existing.path_display ?? path };
    }
    const moved = await dropboxCall(token, 'files/move_v2', {
      from_path: existing.path_lower,
      to_path: path,
      autorename: false,
      allow_ownership_transfer: false,
    });
    if (moved.ok) {
      const meta = (moved.body.metadata as Record<string, unknown> | undefined) ?? {};
      await markFolder(
        admin,
        job.id,
        {
          status: 'ready',
          dropbox_folder_id: typeof meta.id === 'string' ? meta.id : existing.dropbox_folder_id,
          path_lower: typeof meta.path_lower === 'string' ? meta.path_lower : path.toLowerCase(),
          path_display: typeof meta.path_display === 'string' ? meta.path_display : path,
          last_error: null,
        },
        false,
      );
      return { ok: true, error: null, path: typeof meta.path_display === 'string' ? meta.path_display : path };
    }
    if (!moved.text.includes('from_lookup/not_found')) {
      // A folder already sits at the new name, or Dropbox refused: leave the
      // old folder where it is and say why. Nothing is duplicated or lost.
      const error = dropboxErrorMessage('files/move_v2', moved);
      await markFolder(admin, job.id, { status: 'failed', last_error: error }, true);
      return { ok: false, error, permanent: isPermanentDropboxError(moved) };
    }
    // The old folder is gone from Dropbox (deleted by hand): fall through and
    // create a fresh one at the expected path.
  }

  try {
    let metadata: Record<string, unknown> | null = null;
    const created = await dropboxCall(token, 'files/create_folder_v2', {
      path,
      autorename: false,
    });
    if (created.ok) {
      metadata = (created.body.metadata as Record<string, unknown> | undefined) ?? null;
    } else if (created.text.includes('path/conflict/folder')) {
      // Already there (a previous attempt that never got recorded, or Devon
      // made it by hand). Adopt it rather than autorenaming a second copy.
      const meta = await dropboxCall(token, 'files/get_metadata', { path });
      if (!meta.ok) {
        const error = dropboxErrorMessage('files/get_metadata', meta);
        await markFolder(admin, job.id, { status: 'failed', last_error: error }, true);
        return { ok: false, error, permanent: isPermanentDropboxError(meta) };
      }
      metadata = meta.body;
    } else {
      const error = dropboxErrorMessage('files/create_folder_v2', created);
      await markFolder(admin, job.id, { status: 'failed', last_error: error }, true);
      return { ok: false, error, permanent: isPermanentDropboxError(created) };
    }

    const meta = metadata ?? {};
    const folderId = typeof meta.id === 'string' ? meta.id : null;
    const pathLower = typeof meta.path_lower === 'string' ? meta.path_lower : path.toLowerCase();
    const pathDisplay = typeof meta.path_display === 'string' ? meta.path_display : path;
    if (!folderId) {
      const error = 'Dropbox created the folder but returned no id.';
      await markFolder(admin, job.id, { status: 'failed', last_error: error }, true);
      return { ok: false, error };
    }

    await markFolder(
      admin,
      job.id,
      {
        status: 'ready',
        dropbox_folder_id: folderId,
        path_lower: pathLower,
        path_display: pathDisplay,
        last_error: null,
      },
      false,
    );
    return { ok: true, error: null, path: pathDisplay };
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Could not create the Dropbox folder.';
    await markFolder(admin, job.id, { status: 'failed', last_error: error }, true);
    return { ok: false, error };
  }
}

/**
 * Copy one job photo into its job's Dropbox folder. Ensures the folder first.
 * `mode: add` + `autorename: true` — this NEVER overwrites a Dropbox file; the
 * worst case for a double-run is "IMG_7718 (1).jpg", never a lost photo.
 */
async function mirrorPhoto(
  admin: SupabaseClient,
  token: string,
  target: { photoId?: string; row?: MirrorRow },
): Promise<StepResult> {
  const MIRROR_COLUMNS =
    'id, photo_id, job_id, company, storage_bucket, storage_path, status, attempts, last_error';
  let row = target.row ?? null;

  if (!row && target.photoId) {
    const { data: found } = await admin
      .from('dropbox_photo_mirrors')
      .select(MIRROR_COLUMNS)
      .eq('photo_id', target.photoId)
      .maybeSingle();
    row = found as MirrorRow | null;

    if (!row) {
      // The trigger normally enqueued this; a direct call for an older photo
      // (or a trigger that raced) creates the row here.
      const { data: photoRow } = await admin
        .from('job_photos')
        .select('id, job_id, company, storage_path')
        .eq('id', target.photoId)
        .maybeSingle();
      const photo = photoRow as
        | { id: string; job_id: string; company: string | null; storage_path: string }
        | null;
      if (!photo) return { ok: false, error: 'Photo not found.', permanent: true };
      const { data: inserted, error: insErr } = await admin
        .from('dropbox_photo_mirrors')
        .insert({
          photo_id: photo.id,
          job_id: photo.job_id,
          company: photo.company ?? COMPANY,
          storage_bucket: BUCKET,
          storage_path: photo.storage_path,
        })
        .select(MIRROR_COLUMNS)
        .single();
      if (insErr || !inserted) {
        return { ok: false, error: insErr?.message ?? 'Could not enqueue the photo.' };
      }
      row = inserted as MirrorRow;
    }
  }
  if (!row) return { ok: false, error: 'Nothing to mirror.', permanent: true };
  if (row.status === 'mirrored') return { ok: true, error: null };
  if (row.status === 'skipped') return { ok: false, error: row.last_error, permanent: true };

  // --- folder first -------------------------------------------------------
  const folder = await ensureJobFolder(admin, token, row.job_id);
  if (!folder.ok) {
    if (folder.permanent && /internal job/i.test(folder.error ?? '')) {
      await markMirror(admin, row.id, { status: 'skipped', last_error: folder.error }, false);
    } else {
      await markMirror(admin, row.id, { status: 'failed', last_error: folder.error }, true);
    }
    return { ok: false, error: folder.error, permanent: folder.permanent };
  }
  const { data: folderRow } = await admin
    .from('dropbox_job_folders')
    .select('path_display, path_lower')
    .eq('job_id', row.job_id)
    .maybeSingle();
  const folderPaths = folderRow as { path_display?: string | null; path_lower?: string | null } | null;
  const folderPath = folderPaths?.path_display ?? folderPaths?.path_lower ?? null;
  if (!folderPath) {
    const error = 'The job folder row has no path.';
    await markMirror(admin, row.id, { status: 'failed', last_error: error }, true);
    return { ok: false, error };
  }

  // --- download from Storage (service role; the bucket is private) --------
  const { data: blob, error: dlErr } = await admin.storage
    .from(row.storage_bucket || BUCKET)
    .download(row.storage_path);
  if (dlErr || !blob) {
    // An object that is gone (deleted before the mirror ran) will never
    // succeed; stop retrying it.
    const missing = /not found|does not exist|404/i.test(dlErr?.message ?? '');
    const error = `Could not read ${row.storage_path} from storage: ${dlErr?.message ?? 'no data'}`;
    await markMirror(
      admin,
      row.id,
      { status: missing ? 'skipped' : 'failed', last_error: error },
      !missing,
    );
    return { ok: false, error, permanent: missing };
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());

  // --- upload to Dropbox ---------------------------------------------------
  let createdAt: string | null = null;
  if (row.photo_id) {
    const { data: photoMeta } = await admin
      .from('job_photos')
      .select('created_at')
      .eq('id', row.photo_id)
      .maybeSingle();
    createdAt = (photoMeta as { created_at?: string } | null)?.created_at ?? null;
  }
  const targetPath = `${folderPath}/${dropboxFileName(row.storage_path, createdAt)}`;

  try {
    const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'Dropbox-API-Arg': dropboxApiArg({
          path: targetPath,
          mode: 'add',
          autorename: true,
          mute: true,
          strict_conflict: false,
        }),
      },
      body: bytes,
    });
    const text = await res.text();
    if (!res.ok) {
      const reply: DropboxReply = { ok: false, status: res.status, body: {}, text };
      const error = dropboxErrorMessage('files/upload', reply);
      await markMirror(admin, row.id, { status: 'failed', last_error: error }, true);
      return { ok: false, error, permanent: isPermanentDropboxError(reply) };
    }
    let meta: Record<string, unknown> = {};
    try {
      meta = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      meta = {};
    }
    const pathDisplay = typeof meta.path_display === 'string' ? meta.path_display : targetPath;
    await markMirror(
      admin,
      row.id,
      {
        status: 'mirrored',
        last_error: null,
        dropbox_id: typeof meta.id === 'string' ? meta.id : null,
        dropbox_path_lower:
          typeof meta.path_lower === 'string' ? meta.path_lower : targetPath.toLowerCase(),
        dropbox_path_display: pathDisplay,
        dropbox_rev: typeof meta.rev === 'string' ? meta.rev : null,
        content_hash: typeof meta.content_hash === 'string' ? meta.content_hash : null,
        size_bytes: typeof meta.size === 'number' ? meta.size : bytes.byteLength,
        mirrored_at: new Date().toISOString(),
      },
      false,
    );
    return { ok: true, error: null, path: pathDisplay };
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Upload to Dropbox failed.';
    await markMirror(admin, row.id, { status: 'failed', last_error: error }, true);
    return { ok: false, error };
  }
}

interface DrainResult {
  folders: { tried: number; ready: number; failed: number };
  photos: { tried: number; mirrored: number; failed: number };
  errors: string[];
}

/**
 * Work through whatever is queued or failed (< MAX_ATTEMPTS), oldest first,
 * folders before photos so a photo's folder is usually ready by the time the
 * photo comes up. Bounded: an edge function has a wall clock and Dropbox has
 * rate limits; the cron comes back in fifteen minutes for the rest.
 */
async function drain(admin: SupabaseClient, token: string, limit: number): Promise<DrainResult> {
  const result: DrainResult = {
    folders: { tried: 0, ready: 0, failed: 0 },
    photos: { tried: 0, mirrored: 0, failed: 0 },
    errors: [],
  };
  // One scope error means every other row will fail the same way; stop
  // burning attempts on them.
  const SCOPE = 'files.content.write';

  const { data: folderRows } = await admin
    .from('dropbox_job_folders')
    .select('job_id')
    .in('status', ['queued', 'failed'])
    .lt('attempts', MAX_ATTEMPTS)
    .order('updated_at', { ascending: true })
    .limit(limit);
  for (const f of (folderRows as { job_id: string }[] | null) ?? []) {
    result.folders.tried += 1;
    const r = await ensureJobFolder(admin, token, f.job_id);
    if (r.ok) {
      result.folders.ready += 1;
    } else {
      result.folders.failed += 1;
      if (r.error && result.errors.length < 5) result.errors.push(r.error);
      if (r.error?.includes(SCOPE)) return result;
    }
  }

  const { data: mirrorRows } = await admin
    .from('dropbox_photo_mirrors')
    .select('id, photo_id, job_id, company, storage_bucket, storage_path, status, attempts, last_error')
    .in('status', ['queued', 'failed'])
    .lt('attempts', MAX_ATTEMPTS)
    .order('updated_at', { ascending: true })
    .limit(limit);
  for (const row of (mirrorRows as MirrorRow[] | null) ?? []) {
    result.photos.tried += 1;
    const r = await mirrorPhoto(admin, token, { row });
    if (r.ok) {
      result.photos.mirrored += 1;
    } else {
      result.photos.failed += 1;
      if (r.error && result.errors.length < 5) result.errors.push(r.error);
      if (r.error?.includes(SCOPE)) return result;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'POST only');

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      return fail(500, 'server_error', 'The function is missing its Supabase environment.');
    }
    const admin = createClient(supabaseUrl, serviceKey);

    // --- auth: shared secret (cron) or an admin JWT (Sync now) --------------
    const syncSecret = Deno.env.get('DROPBOX_SYNC_SECRET');
    const givenSecret = req.headers.get('x-sync-secret') ?? '';
    let authorized = Boolean(syncSecret) && constantTimeEqual(givenSecret, syncSecret!);

    if (!authorized) {
      const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (jwt) {
        const { data: userData } = await admin.auth.getUser(jwt);
        const email = userData?.user?.email?.toLowerCase();
        if (email) {
          const { data: employee } = await admin
            .from('employees')
            .select('role')
            .eq('email', email)
            .maybeSingle();
          const role = (employee as { role?: string } | null)?.role;
          authorized = role === 'owner' || role === 'operator';
        }
      }
    }
    if (!authorized) {
      return fail(401, 'unauthorized', 'Send the sync secret or sign in as an owner or operator.');
    }

    // --- input --------------------------------------------------------------
    let payload: {
      action?: string;
      usage?: string;
      full?: boolean;
      limit?: number;
      job_id?: string;
      photo_id?: string;
      reset_failed?: boolean;
    } = {};
    try {
      const text = await req.text();
      if (text.trim()) payload = JSON.parse(text) as typeof payload;
    } catch {
      return fail(400, 'bad_request', 'Invalid JSON body.');
    }

    // No `action` = the original nightly sync, so the cron, the "Sync now"
    // button and every existing caller keep working unchanged.
    const action = (payload.action ?? 'sync') as Action;
    if (!ACTIONS.includes(action)) {
      return fail(400, 'bad_request', `action must be one of ${ACTIONS.join(', ')}.`);
    }

    const usage = payload.usage ?? 'all';
    if (action === 'sync' && !['eom', 'marketing', 'all'].includes(usage)) {
      return fail(400, 'bad_request', "usage must be 'eom', 'marketing' or 'all'.");
    }
    const full = payload.full === true;
    const limit =
      Number.isFinite(Number(payload.limit)) && Number(payload.limit) > 0
        ? Math.min(Number(payload.limit), 2000)
        : DEFAULT_LIMIT;
    const drainLimit =
      Number.isFinite(Number(payload.limit)) && Number(payload.limit) > 0
        ? Math.min(Number(payload.limit), MAX_DRAIN_LIMIT)
        : DRAIN_LIMIT;

    const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (action === 'ensure_job_folder' && !uuidLike.test(String(payload.job_id ?? ''))) {
      return fail(400, 'bad_request', 'ensure_job_folder needs a job_id (uuid).');
    }
    if (action === 'mirror_photo' && !uuidLike.test(String(payload.photo_id ?? ''))) {
      return fail(400, 'bad_request', 'mirror_photo needs a photo_id (uuid).');
    }

    // --- credentials --------------------------------------------------------
    // Every action needs Dropbox. When it is not connected the trigger-driven
    // rows simply stay 'queued' (nothing below has touched them yet) and the
    // retry cron picks them up once the credentials exist.
    const { data: credsRow } = await admin
      .from('integration_secrets')
      .select('client_id, client_secret, access_token, refresh_token, expires_at')
      .eq('company', COMPANY)
      .eq('provider', 'dropbox')
      .maybeSingle();
    const creds = credsRow as DropboxCreds | null;
    if (!creds?.client_id || !creds?.client_secret || !creds?.refresh_token) {
      return fail(
        503,
        'not_configured',
        'Dropbox is not connected yet: public.integration_secrets has no dropbox row with ' +
          'a client id, client secret and refresh token. The one-time setup is in ' +
          'docs/DROPBOX_SETUP.md.',
      );
    }

    let token: string;
    try {
      token = await accessToken(admin, creds);
    } catch (e) {
      return fail(502, 'dropbox_error', e instanceof Error ? e.message : 'Dropbox auth failed.');
    }

    // --- job folders + photo mirroring ---------------------------------------
    if (action === 'ensure_job_folder') {
      const r = await ensureJobFolder(admin, token, String(payload.job_id));
      if (!r.ok) return fail(r.permanent ? 422 : 502, 'dropbox_error', r.error ?? 'Failed.');
      return ok({ action, job_id: payload.job_id, path: r.path ?? null });
    }

    if (action === 'mirror_photo') {
      const r = await mirrorPhoto(admin, token, { photoId: String(payload.photo_id) });
      if (!r.ok) return fail(r.permanent ? 422 : 502, 'dropbox_error', r.error ?? 'Failed.');
      return ok({ action, photo_id: payload.photo_id, path: r.path ?? null });
    }

    if (action === 'retry_mirrors') {
      const drained = await drain(admin, token, drainLimit);
      return ok({ action, ...drained });
    }

    if (action === 'backfill_job_folders' || action === 'backfill_photo_mirrors') {
      // Enqueue rows for everything that predates the triggers (bounded), then
      // drain. `reset_failed: true` re-queues rows that failed — what you want
      // right after fixing the Dropbox scope.
      const { data: enqueued, error: enqErr } = await admin.rpc('dropbox_enqueue_backlog', {
        p_jobs: action === 'backfill_job_folders' ? Math.max(drainLimit, 200) : 0,
        p_photos: action === 'backfill_photo_mirrors' ? Math.max(drainLimit, 200) : 0,
        p_reset_failed: payload.reset_failed === true,
      });
      if (enqErr) {
        return fail(
          500,
          'server_error',
          `Could not enqueue the backlog (is migration 2026-09-12_dropbox_job_folders.sql applied?): ${enqErr.message}`,
        );
      }
      const drained = await drain(admin, token, drainLimit);
      const { count: pendingFolders } = await admin
        .from('dropbox_job_folders')
        .select('job_id', { count: 'exact', head: true })
        .in('status', ['queued', 'failed'])
        .lt('attempts', MAX_ATTEMPTS);
      const { count: pendingPhotos } = await admin
        .from('dropbox_photo_mirrors')
        .select('id', { count: 'exact', head: true })
        .in('status', ['queued', 'failed'])
        .lt('attempts', MAX_ATTEMPTS);
      return ok({
        action,
        enqueued: enqueued ?? null,
        ...drained,
        pending: { folders: pendingFolders ?? 0, photos: pendingPhotos ?? 0 },
        hint:
          (pendingFolders ?? 0) + (pendingPhotos ?? 0) > 0
            ? 'Call again (or wait for the 15-minute cron) until pending is 0.'
            : 'Nothing pending.',
      });
    }

    // --- folders (the original nightly sync) --------------------------------
    let query = admin
      .from('dropbox_folders')
      .select('usage, path_lower, cursor')
      .eq('company', COMPANY);
    if (usage !== 'all') query = query.eq('usage', usage);
    const { data: folderRows } = await query;
    const folders = (folderRows as FolderRow[] | null) ?? [];
    if (folders.length === 0) {
      return fail(
        503,
        'not_configured',
        'No Dropbox folders are configured. public.dropbox_folders should hold the /EOM and ' +
          '/Marketing rows — see docs/DROPBOX_SETUP.md.',
      );
    }

    const results: FolderResult[] = [];
    for (const folder of folders) {
      results.push(await syncFolder(admin, token, folder, { full, limit }));
    }

    return ok({ results });
  } catch (e) {
    return fail(500, 'server_error', e instanceof Error ? e.message : 'Sync failed.');
  }
});
