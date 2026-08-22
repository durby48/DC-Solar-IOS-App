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
    let payload: { usage?: string; full?: boolean; limit?: number } = {};
    try {
      const text = await req.text();
      if (text.trim()) payload = JSON.parse(text) as typeof payload;
    } catch {
      return fail(400, 'bad_request', 'Invalid JSON body.');
    }
    const usage = payload.usage ?? 'all';
    if (!['eom', 'marketing', 'all'].includes(usage)) {
      return fail(400, 'bad_request', "usage must be 'eom', 'marketing' or 'all'.");
    }
    const full = payload.full === true;
    const limit =
      Number.isFinite(Number(payload.limit)) && Number(payload.limit) > 0
        ? Math.min(Number(payload.limit), 2000)
        : DEFAULT_LIMIT;

    // --- credentials --------------------------------------------------------
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

    // --- folders ------------------------------------------------------------
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
