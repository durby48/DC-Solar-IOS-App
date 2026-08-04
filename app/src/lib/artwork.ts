/**
 * Per-job property artwork (2026-08-04 overhaul).
 *
 * Every job gets one cartoon illustration of its ACTUAL property: Street View
 * fetches the house from `jobs.address`, the `property-art` edge function
 * cartoonifies it with Gemini, and the result is cached in the private
 * `property-art` bucket. Cards fall back to the drawn illustration in
 * components/PropertyArt.tsx whenever a job has no artwork yet.
 *
 * Never throws — every screen that uses artwork must degrade to the fallback
 * rather than break the pipeline.
 */

import { supabase } from '@/lib/supabase';

const ART_BUCKET = 'property-art';
/** Signed URLs live an hour; the pipeline refetches on focus anyway. */
const SIGNED_URL_TTL = 3600;

export type ArtworkStatus = 'pending' | 'ready' | 'failed';

export interface JobArtwork {
  jobId: string;
  status: ArtworkStatus;
  source: 'streetview' | 'photo';
  artPath: string | null;
  sourceRef: string | null;
  error: string | null;
}

/**
 * Artwork rows for every job, keyed by job id. Empty map when the table is
 * missing (migration not applied) or unreadable — callers then draw the
 * fallback illustration, which is the same thing they'd do for a job with no
 * artwork.
 */
export async function fetchJobArtwork(): Promise<Map<string, JobArtwork>> {
  const map = new Map<string, JobArtwork>();
  try {
    const { data, error } = await supabase
      .from('job_artwork')
      .select('job_id, status, source, art_path, source_ref, error');
    if (error || !data) return map;
    for (const row of data as Record<string, unknown>[]) {
      const jobId = row.job_id as string;
      map.set(jobId, {
        jobId,
        status: (row.status as ArtworkStatus) ?? 'pending',
        source: (row.source as 'streetview' | 'photo') ?? 'streetview',
        artPath: (row.art_path as string | null) ?? null,
        sourceRef: (row.source_ref as string | null) ?? null,
        error: (row.error as string | null) ?? null,
      });
    }
  } catch {
    // fall through to the empty map
  }
  return map;
}

/**
 * Signed display URLs for every job that has ready artwork, keyed by job id.
 * One batched request for the whole pipeline rather than one per card.
 */
export async function fetchArtworkUrls(
  artwork?: Map<string, JobArtwork>,
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  try {
    const rows = artwork ?? (await fetchJobArtwork());
    const ready = [...rows.values()].filter(
      (a): a is JobArtwork & { artPath: string } =>
        a.status === 'ready' && typeof a.artPath === 'string' && a.artPath.length > 0,
    );
    if (ready.length === 0) return urls;

    const { data, error } = await supabase.storage
      .from(ART_BUCKET)
      .createSignedUrls(ready.map((a) => a.artPath), SIGNED_URL_TTL);
    if (error || !data) return urls;

    data.forEach((entry, index) => {
      const signed = (entry as { signedUrl?: string | null }).signedUrl;
      const job = ready[index];
      if (signed && job) urls.set(job.jobId, signed);
    });
  } catch {
    // fall through to whatever we managed to sign
  }
  return urls;
}

export type GenerateResult =
  | { ok: true; cached: boolean }
  | { ok: false; message: string };

/**
 * Pull the real message out of a failed functions.invoke().
 *
 * supabase-js collapses every non-2xx response into the useless string
 * "Edge Function returned a non-2xx status code" and hides the actual body on
 * `error.context` (a Response). Without this, a missing API key, a Street View
 * coverage miss and a Gemini rejection all look identical to the user.
 */
async function readFunctionError(error: unknown): Promise<string | null> {
  const context = (error as { context?: unknown })?.context;
  if (!context || typeof context !== 'object') return null;
  const response = context as Response;
  try {
    if (typeof response.clone === 'function') {
      const body = (await response.clone().json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error.length > 0) return body.error;
    }
  } catch {
    // not JSON — fall through to text
  }
  try {
    if (typeof response.text === 'function') {
      const text = await response.text();
      if (text.trim().length > 0) return text.trim().slice(0, 300);
    }
  } catch {
    // give up; caller falls back to the generic message
  }
  return null;
}

/**
 * Ask the edge function to build (or rebuild) one job's artwork. Admin-only
 * server-side. `photoPath` overrides Street View with a photo already in
 * storage; `force` regenerates even when ready artwork exists.
 */
export async function generateArtwork(
  jobId: string,
  options: { photoPath?: string; force?: boolean } = {},
): Promise<GenerateResult> {
  try {
    const { data, error } = await supabase.functions.invoke('property-art', {
      body: { jobId, ...options },
    });
    if (error) {
      const detail = await readFunctionError(error);
      return { ok: false, message: detail ?? error.message ?? 'Artwork generation failed.' };
    }
    const result = data as { ok?: boolean; cached?: boolean; error?: string } | null;
    if (!result?.ok) {
      return { ok: false, message: result?.error ?? 'Artwork generation failed.' };
    }
    return { ok: true, cached: Boolean(result.cached) };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Artwork generation failed.',
    };
  }
}

/** Signed URL for a single job's artwork, or null. */
export async function fetchArtworkUrl(jobId: string): Promise<string | null> {
  const rows = await fetchJobArtwork();
  const row = rows.get(jobId);
  if (!row || row.status !== 'ready' || !row.artPath) return null;
  try {
    const { data, error } = await supabase.storage
      .from(ART_BUCKET)
      .createSignedUrl(row.artPath, SIGNED_URL_TTL);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}
