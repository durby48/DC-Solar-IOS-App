import { supabase } from '@/lib/supabase';

/**
 * Marketing pictures (2026-10-12): Gemini-drawn art for the call script and
 * the Solar Shield plans, made by the `marketing-art` edge function. Rows in
 * `marketing_art` point at the current file in the PUBLIC 'marketing-art'
 * bucket — readable signed out, because the brochure shows the tier art to
 * customers. URLs go through Supabase's image resizer (WebP, sized to the
 * slot), so a 600 KB drawing arrives as ~40 KB on a phone.
 */

export type ArtKey = 'script-hero' | 'shield-program' | 'shield-bronze' | 'shield-silver' | 'shield-gold';

const BUCKET = 'marketing-art';
let cache: { at: number; paths: Partial<Record<ArtKey, string>> } | null = null;

async function artPaths(): Promise<Partial<Record<ArtKey, string>>> {
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache.paths;
  try {
    const { data, error } = await supabase.from('marketing_art').select('key, path');
    if (error || !data) return cache?.paths ?? {};
    const paths: Partial<Record<ArtKey, string>> = {};
    for (const r of data as { key: ArtKey; path: string }[]) paths[r.key] = r.path;
    cache = { at: Date.now(), paths };
    return paths;
  } catch {
    return cache?.paths ?? {};
  }
}

/** Resized public URLs for the asked-for pictures; a missing picture is simply absent. */
export async function fetchArtUrls(keys: ArtKey[], width: number): Promise<Partial<Record<ArtKey, string>>> {
  const paths = await artPaths();
  const out: Partial<Record<ArtKey, string>> = {};
  for (const key of keys) {
    const path = paths[key];
    if (!path) continue;
    out[key] = supabase.storage.from(BUCKET).getPublicUrl(path, { transform: { width, quality: 75 } }).data.publicUrl;
  }
  return out;
}

export const TIER_ART: Record<'bronze' | 'silver' | 'gold', ArtKey> = {
  bronze: 'shield-bronze',
  silver: 'shield-silver',
  gold: 'shield-gold',
};
