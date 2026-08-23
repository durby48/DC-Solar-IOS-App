/**
 * The signed-in employee's own profile — right now, just their photo.
 *
 * WHY `staff_profiles` AND NOT `employees`. The roster table has RLS on with
 * SELECT policies and NO write policies at all, and that is the load-bearing
 * security invariant of this database (see the header of
 * `supabase/migrations/2026-08-22_comms.sql`). Giving people a profile picture
 * must not mean giving `employees` an UPDATE policy. `staff_profiles` already
 * exists for exactly this shape of data — self-insert, self-update, self-read,
 * plus an admin read — so the avatar is one more column on it.
 *
 * WHY THE PHOTO GOES IN `job-photos/avatars/`. That bucket is already private,
 * already member-readable and already member-writable, so an employee can save
 * their own picture without a new bucket or a new policy. It has SELECT,
 * INSERT and (admin) DELETE policies — and deliberately NO UPDATE policy — so:
 *
 *   • every upload uses a TIMESTAMPED name and `upsert: false`. Overwriting a
 *     path is an UPDATE to storage, which a non-admin member cannot do; a new
 *     name is an INSERT, which they can. `lib/customers.ts::uploadCustomerPhoto`
 *     names files the same way for the same reason, and it also means a
 *     replacement can never be masked by a cached signed URL.
 *   • removing a photo clears the COLUMN and only tries to delete the file.
 *     A viewer or operator cannot delete from that bucket, so the file may
 *     outlive the row. A stale private object nobody can find is a much
 *     smaller problem than a Remove button that fails for everyone but Devon.
 *
 * NOTHING HERE THROWS. Every function returns a result object. A profile photo
 * is decoration; it must never be able to take the Home screen down.
 */

import { compressForUpload } from '@/lib/images';
import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';
const PHOTO_BUCKET = 'job-photos';
/** Signed URLs live an hour. Home refetches on mount, so this is plenty. */
const SIGNED_URL_TTL = 3600;
/** 512px is four times the 48pt circle on a 3x screen — sharp, and tiny. */
const AVATAR_MAX_WIDTH = 512;

export interface MyProfile {
  email: string;
  /** Object path inside the private `job-photos` bucket, or null. */
  avatarPath: string | null;
  /** Signed display URL for `avatarPath`, or null. */
  avatarUrl: string | null;
}

export type ProfileResult =
  | { ok: true; profile: MyProfile }
  | { ok: false; message: string };

/** The session's email, lowercased to match the table's normalising trigger. */
async function myEmail(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const email = data.session?.user?.email;
    return email ? email.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * `devonsd311@gmail.com` → `devonsd311-gmail-com`.
 *
 * Storage keys are URL path segments: `@` and `.` survive a signed URL but
 * make the object awkward to handle in every tool that touches the bucket, so
 * flatten to the alphabet that never needs escaping. Collisions do not matter
 * — the timestamp is what makes the name unique, this part just makes a
 * human browsing the bucket able to tell whose picture it is.
 */
function emailSlug(email: string): string {
  return email
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Signed URL for an avatar path, or null. */
export async function getAvatarUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  try {
    const { data, error } = await supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUrl(path, SIGNED_URL_TTL);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

/**
 * My own `staff_profiles` row, with the avatar already signed.
 *
 * Returns null when signed out. Returns a profile with nulls — never an error
 * — when the row does not exist yet (nobody has set a photo), when RLS hides
 * it, or when `avatar_path` has not been added to the table yet: an older
 * database is a header that shows initials, not a broken screen.
 */
export async function fetchMyProfile(): Promise<MyProfile | null> {
  const email = await myEmail();
  if (!email) return null;

  try {
    const { data, error } = await supabase
      .from('staff_profiles')
      .select('email, avatar_path')
      .eq('company', COMPANY)
      .eq('email', email)
      .maybeSingle();

    if (error || !data) return { email, avatarPath: null, avatarUrl: null };

    const avatarPath = ((data as { avatar_path?: string | null }).avatar_path ?? null) || null;
    return { email, avatarPath, avatarUrl: await getAvatarUrl(avatarPath) };
  } catch {
    return { email, avatarPath: null, avatarUrl: null };
  }
}

/**
 * Write `avatar_path` onto my row WITHOUT touching anything else on it.
 *
 * UPDATE first, INSERT only if nothing was updated. A single `upsert()` would
 * be one round trip, but the row also carries `cell_phone` and
 * `voice_bridge_enabled` — the bridge-calling settings from Workstream G — and
 * this must not be the code that quietly resets somebody's cell number to the
 * column default. Update-then-insert can only ever write the one column on an
 * existing row.
 *
 * The `.select('email')` is what makes the update tell us whether it matched:
 * PostgREST returns the affected rows, and an empty array means "no row yet".
 */
async function writeAvatarPath(
  email: string,
  avatarPath: string | null,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('staff_profiles')
    .update({ avatar_path: avatarPath })
    .eq('company', COMPANY)
    .eq('email', email)
    .select('email');

  if (error) return friendlyColumnError(error.message);
  if (data && data.length > 0) return null;

  // No row for this person yet. The insert policy requires company membership
  // and an email matching the JWT, both of which hold here; the table's
  // trigger lowercases the address on the way in.
  const { error: insertError } = await supabase
    .from('staff_profiles')
    .insert({ company: COMPANY, email, avatar_path: avatarPath });
  if (insertError) return friendlyColumnError(insertError.message);
  return null;
}

/**
 * `staff_profiles.avatar_path` is added by a migration that may not have run
 * on this database yet. PostgREST answers a missing column with PGRST204 /
 * 42703 and a message about the schema cache, which means nothing to a person
 * holding a phone.
 */
function friendlyColumnError(message: string): string {
  if (/avatar_path/i.test(message) && /(column|schema cache)/i.test(message)) {
    return 'Profile photos are not set up on this account yet.';
  }
  return message;
}

/**
 * Compress, upload and record a new avatar. Returns the profile with the new
 * signed URL so the caller can show it immediately.
 */
export async function uploadMyAvatar(uri: string): Promise<ProfileResult> {
  const email = await myEmail();
  if (!email) return { ok: false, message: 'Sign in to change your photo.' };

  try {
    const compressed = await compressForUpload(uri, { maxWidth: AVATAR_MAX_WIDTH, quality: 0.8 });
    const response = await fetch(compressed.uri);
    const blob = await response.blob();

    // Timestamped, never upserted — see the module header. `job-photos` has no
    // UPDATE policy, so overwriting a path fails for everyone except through a
    // policy we deliberately do not want to add.
    const path = `avatars/${emailSlug(email)}-${Date.now()}.jpg`;
    const { error: uploadError } = await supabase.storage
      .from(PHOTO_BUCKET)
      .upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false });
    if (uploadError) return { ok: false, message: uploadError.message };

    const writeError = await writeAvatarPath(email, path);
    if (writeError) return { ok: false, message: writeError };

    return {
      ok: true,
      profile: { email, avatarPath: path, avatarUrl: await getAvatarUrl(path) },
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not save that photo.',
    };
  }
}

/**
 * Go back to initials. Clears the column, then makes ONE best-effort attempt
 * at the file — the bucket's DELETE policy is admin-only, so for most of the
 * crew that call is expected to fail and its failure is deliberately ignored.
 */
export async function clearMyAvatar(): Promise<ProfileResult> {
  const email = await myEmail();
  if (!email) return { ok: false, message: 'Sign in to change your photo.' };

  try {
    const existing = await fetchMyProfile();
    const writeError = await writeAvatarPath(email, null);
    if (writeError) return { ok: false, message: writeError };

    if (existing?.avatarPath) {
      try {
        await supabase.storage.from(PHOTO_BUCKET).remove([existing.avatarPath]);
      } catch {
        // Admin-only DELETE. The row is already cleared, which is what the
        // person asked for; an orphaned private object is not their problem.
      }
    }

    return { ok: true, profile: { email, avatarPath: null, avatarUrl: null } };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not remove that photo.',
    };
  }
}
