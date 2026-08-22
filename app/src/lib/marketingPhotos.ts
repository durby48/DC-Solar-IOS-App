/**
 * Installation photos for the Marketing panel.
 *
 * This is the READ HALF of the Dropbox photo library (Workstream H,
 * supabase/migrations/2026-08-22_media_dropbox.sql). A scheduled function
 * mirrors a Dropbox folder into the private `job-photos` bucket under
 * `marketing/<YYYY>/<id>.<ext>` and writes one `media_assets` row per file;
 * this module turns those rows into signed URLs a thumbnail strip can render.
 *
 * WHY IT EXISTS SEPARATELY FROM `lib/marketing.ts`. Reach numbers come from
 * platform APIs nobody has connected yet; photos come from a bucket that
 * already works. Keeping them apart is what lets the panel show real
 * installation photos while every platform card still says "Not connected" —
 * which is the honest state of this feature today.
 *
 * THREE ANSWERS, AND `not-configured` IS THE QUIET ONE:
 *   ok             — rows exist and at least one signed URL came back.
 *   not-configured — the table is missing (migration not applied), RLS
 *                    refuses, or there is genuinely nothing in the folder yet.
 *                    The strip renders NOTHING for this. A crew member who has
 *                    never heard of the Dropbox sync should not be told about
 *                    an empty folder.
 *   unavailable    — the request itself failed. The caller may say so.
 *
 * ONE SIGNING REQUEST. `createSignedUrls` takes the whole batch, the way
 * `lib/artwork.ts::fetchArtworkUrls` signs the pipeline's property art. Two
 * dozen thumbnails must never mean two dozen round trips on a phone parked in
 * a driveway.
 *
 * Never throws.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';
const PHOTO_BUCKET = 'job-photos';
/** Signed URLs live an hour; the panel refetches on pull-to-refresh anyway. */
const SIGNED_URL_TTL = 3600;

export interface MarketingPhoto {
  id: string;
  /** Signed display URL (1h). */
  url: string;
  caption: string | null;
  /** EXIF capture time when Dropbox reported one, else the modified time. */
  takenAt: string | null;
  /** The job this photo was tagged to, when one is known. */
  jobNumber: string | null;
}

export type MarketingPhotosResult =
  | { status: 'ok'; photos: MarketingPhoto[] }
  | { status: 'not-configured' }
  | { status: 'unavailable' };

interface AssetRow {
  id: string;
  storage_path: string;
  caption: string | null;
  taken_at: string | null;
  jobs?: { job_number: string | null } | { job_number: string | null }[] | null;
}

/**
 * The newest marketing photos, newest first.
 *
 * Ordered `taken_at desc nulls last, created_at desc`: a Dropbox file with no
 * EXIF date should fall to the bottom of the strip rather than jump to the top
 * on a null, and the sync time breaks the remaining ties.
 */
export async function fetchMarketingPhotos(limit = 24): Promise<MarketingPhotosResult> {
  try {
    const query = (columns: string) =>
      supabase
        .from('media_assets')
        .select(columns)
        .eq('company', COMPANY)
        .eq('usage', 'marketing')
        .is('archived_at', null)
        .order('taken_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(limit);

    // The job number is a nice-to-have on a caption, so a failed embed (jobs
    // RLS, or the FK not resolving) must not cost us the photos. Retry flat.
    let { data, error } = await query('id, storage_path, caption, taken_at, jobs(job_number)');
    if (error) ({ data, error } = await query('id, storage_path, caption, taken_at'));

    // A missing table or an RLS refusal both mean "this isn't set up here",
    // which is the same thing to the person holding the phone as an empty
    // folder. Neither is worth an error message about marketing photos.
    if (error) return { status: 'not-configured' };

    const rows = (data ?? []) as unknown as AssetRow[];
    if (rows.length === 0) return { status: 'not-configured' };

    const { data: signed, error: signError } = await supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUrls(
        rows.map((r) => r.storage_path),
        SIGNED_URL_TTL,
      );
    if (signError || !signed) return { status: 'unavailable' };

    const photos: MarketingPhoto[] = [];
    signed.forEach((entry, index) => {
      const url = (entry as { signedUrl?: string | null }).signedUrl;
      const row = rows[index];
      if (!url || !row) return;
      const job = Array.isArray(row.jobs) ? (row.jobs[0] ?? null) : (row.jobs ?? null);
      photos.push({
        id: row.id,
        url,
        caption: row.caption,
        takenAt: row.taken_at,
        jobNumber: job?.job_number ?? null,
      });
    });

    // Rows existed but nothing could be signed — the bucket is the problem,
    // not the configuration.
    if (photos.length === 0) return { status: 'unavailable' };
    return { status: 'ok', photos };
  } catch {
    return { status: 'unavailable' };
  }
}
