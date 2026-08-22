/**
 * Employee of the Month data layer.
 *
 * The award is DATA, not code: one `employee_of_month` row per month, written
 * by an admin along with that month's photo (see
 * supabase/migrations/2026-08-18_employee_of_month.sql for why). Whatever the
 * standing rule is in a given month, it is a row somebody wrote, not a name
 * compiled into the app — changing it needs no release.
 *
 * Reads NEVER throw. The card sits on the Home screen in front of the whole
 * crew, so a missing table, an RLS denial, a dead connection or a signed-out
 * session must all degrade to "show nothing", not to a red screen. Until
 * 2026-08-22 the signed-out case returned a hard-coded named employee; it
 * returns null now, because inventing a winner is worse than showing nothing.
 *
 * Photos live in the EXISTING private `job-photos` bucket under an `eom/`
 * prefix — the same trick customer avatars use, so there are no new storage
 * policies to get wrong. Display URLs are signed for an hour.
 */

import { compressForUpload } from '@/lib/images';
import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';
const PHOTO_BUCKET = 'job-photos';
/** Seconds a display URL stays valid. */
const SIGNED_URL_TTL = 3600;

/**
 * Where the Dropbox sync puts the shared Employee-of-the-Month library.
 *
 * A file under this prefix is NOT owned by the month that points at it — the
 * same photo can be picked for two months, and it exists whether or not any
 * month uses it. See `isLibraryPath` and the guard in `deleteEmployeeOfMonth`.
 */
export const EOM_LIBRARY_PREFIX = 'eom/library/';

/** Row shape as stored. `month` is always the first day of the month. */
export interface EmployeeOfMonthRow {
  month: string;
  employee_email: string;
  employee_name: string | null;
  photo_path: string | null;
  caption: string | null;
}

/** What the card renders. */
export interface EmployeeOfMonthCard {
  /** First-of-month ISO date of the row actually shown. */
  month: string;
  /** Always the CURRENT month, e.g. "August 2026" — see `isFallback`. */
  label: string;
  employeeName: string;
  employeeEmail: string;
  /** Signed URL (1h) or null when no photo has been attached yet. */
  photoUrl: string | null;
  caption: string | null;
  /** True when no row exists for the current month and an older one is shown. */
  isFallback: boolean;
}

// ---------------------------------------------------------------------------
// Month helpers — everything is a first-of-month ISO date string.
// ---------------------------------------------------------------------------

/** First day of the current month as YYYY-MM-DD (local time). */
export function currentMonthISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-01`;
}

/**
 * Normalise "2026-08", "2026-8", "2026-08-19" → "2026-08-01". Returns null on
 * anything we can't read, so the admin screen can say so instead of writing a
 * row the check constraint will reject.
 */
export function normalizeMonth(input: string): string | null {
  const match = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(input.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || month < 1 || month > 12) return null;
  return `${year}-${`${month}`.padStart(2, '0')}-01`;
}

/** "August 2026" for a first-of-month ISO date. */
export function formatMonthLabel(monthISO: string): string {
  const [y, m] = monthISO.split('-').map(Number);
  if (!y || !m) return monthISO;
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}

/** Shift a first-of-month ISO date by `delta` months. */
export function shiftMonth(monthISO: string, delta: number): string {
  const [y, m] = monthISO.split('-').map(Number);
  const d = new Date(y ?? 1970, (m ?? 1) - 1 + delta, 1);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-01`;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Signed display URL for a stored photo. Null on any failure. */
export async function getEomPhotoUrl(storagePath: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

/**
 * The card to show right now: this month's row, or — when nobody has filed one
 * yet — the most recent row that exists, still labelled with the CURRENT month
 * so the card never goes blank in front of the crew.
 *
 * Returns null (render nothing) when nobody is signed in, when the table is
 * missing, when RLS denies, or when there are no rows at all.
 */
export async function fetchEmployeeOfMonth(): Promise<EmployeeOfMonthCard | null> {
  try {
    const { data: session } = await supabase.auth.getSession();
    if (!session.session?.user?.email) return null;

    const thisMonth = currentMonthISO();
    // One query, newest first: the current month sorts to the top when it
    // exists, otherwise the latest past month does. Future months are excluded
    // so scheduling next month's winner early doesn't jump the gun.
    const { data, error } = await supabase
      .from('employee_of_month')
      .select('month, employee_email, employee_name, photo_path, caption')
      .eq('company', COMPANY)
      .lte('month', thisMonth)
      .order('month', { ascending: false })
      .limit(1);

    if (error || !data || data.length === 0) return null;

    const row = data[0] as EmployeeOfMonthRow;
    const photoUrl = row.photo_path ? await getEomPhotoUrl(row.photo_path) : null;
    return {
      month: row.month,
      label: formatMonthLabel(thisMonth),
      employeeName: row.employee_name ?? row.employee_email,
      employeeEmail: row.employee_email,
      photoUrl,
      caption: row.caption ?? null,
      isFallback: row.month !== thisMonth,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export interface EmployeeOfMonthEntry extends EmployeeOfMonthRow {
  /** Signed URL (1h), resolved eagerly so the list can show thumbnails. */
  photoUrl: string | null;
}

export type EomListResult =
  | { status: 'ok'; entries: EmployeeOfMonthEntry[] }
  | { status: 'unavailable' };

/** Every month on record, newest first. Never throws. */
export async function listEmployeeOfMonth(): Promise<EomListResult> {
  try {
    const { data, error } = await supabase
      .from('employee_of_month')
      .select('month, employee_email, employee_name, photo_path, caption')
      .eq('company', COMPANY)
      .order('month', { ascending: false });
    if (error || !data) return { status: 'unavailable' };

    const entries = await Promise.all(
      (data as EmployeeOfMonthRow[]).map(async (row) => ({
        ...row,
        photoUrl: row.photo_path ? await getEomPhotoUrl(row.photo_path) : null,
      })),
    );
    return { status: 'ok', entries };
  } catch {
    return { status: 'unavailable' };
  }
}

export type EomMutationResult = { ok: true } | { ok: false; message: string };

function friendlyMessage(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  if (/row-level security|policy/i.test(raw)) {
    return 'Only owners and operators can change Employee of the Month.';
  }
  if (/relation .* does not exist|schema cache/i.test(raw)) {
    return 'Employee of the Month needs the latest database migration.';
  }
  return raw;
}

/**
 * Is this a file in the shared Dropbox library rather than one month's own
 * upload?
 *
 * Defensive on purpose: a leading slash, a stray upper-case folder name and a
 * bit of whitespace all still mean the same object, and the ONE thing this
 * predicate must never do is answer "no" for a library file (see
 * `deleteEmployeeOfMonth`).
 *
 * The cases it is expected to get right, all verified by hand:
 *   'eom/library/abc.jpg'   → true    'EOM/Library/abc.JPG'   → true
 *   '/eom/library/abc.jpg'  → true    '  eom/library/a.jpg '  → true
 *   'eom/2026-08-1755.jpg'  → false   'eom/library'           → false
 *   'customers/x.jpg'       → false   null / undefined / ''   → false
 * `'eom/library'` (the folder itself, with no trailing slash) is false on
 * purpose: it is not an object, so it can never be a `photo_path`, and the
 * prefix test is about files.
 */
export function isLibraryPath(path: string | null | undefined): boolean {
  if (typeof path !== 'string') return false;
  return path.trim().replace(/^\/+/, '').toLowerCase().startsWith(EOM_LIBRARY_PREFIX);
}

/**
 * Create or replace a month's award, optionally attaching a photo.
 *
 * TWO PHOTO SOURCES, AND ONLY ONE OF THEM COPIES BYTES:
 *
 *   `photoPath` — an object already in `job-photos`, picked from the Dropbox
 *                 library (`eom/library/<id>.<ext>`). The path is stored as-is
 *                 and NOTHING is copied: the file is already in the right
 *                 bucket, and duplicating it would mean two objects to keep in
 *                 step and a second copy nobody knows about. Two months are
 *                 allowed to point at the same library file.
 *   `photo`     — a local URI from `expo-image-picker`, uploaded here. It is
 *                 compressed first (`lib/images.ts` — 1920px/q0.75; a modern
 *                 phone JPEG is 4–8 MB and the card renders it at 64pt), then
 *                 fetched into a blob, which is how the content type is
 *                 discovered on both platforms: the picker hands back a
 *                 `file://` URI on the phone and a `blob:` URI in the browser
 *                 and `fetch` normalises both.
 *
 * `photoPath` wins if both are passed. Omit both to keep the existing photo.
 *
 * An uploaded path is timestamped so replacing a month's photo can never
 * collide with a signed URL still cached on somebody's phone.
 */
export async function upsertEmployeeOfMonth(params: {
  month: string;
  employeeEmail: string;
  caption?: string | null;
  /** Local URI from expo-image-picker. Omit to keep the existing photo. */
  photo?: string | null;
  /**
   * A storage path already in `job-photos` — normally an `eom/library/…` file
   * mirrored from Dropbox. Stored directly, with NO copy.
   */
  photoPath?: string | null;
}): Promise<EomMutationResult> {
  const month = normalizeMonth(params.month);
  if (!month) return { ok: false, message: 'Use a month in YYYY-MM form, e.g. 2026-08.' };
  const email = params.employeeEmail.trim().toLowerCase();
  if (!email) return { ok: false, message: 'Pick an employee first.' };

  try {
    let photoPath: string | null = params.photoPath?.trim() ? params.photoPath.trim() : null;
    if (!photoPath && params.photo) {
      const compressed = await compressForUpload(params.photo);
      const response = await fetch(compressed.uri);
      const blob = await response.blob();
      const ext = blob.type.includes('png') ? 'png' : 'jpg';
      const path = `eom/${month.slice(0, 7)}-${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from(PHOTO_BUCKET)
        .upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: true });
      if (upErr) return { ok: false, message: friendlyMessage(upErr.message, 'Could not upload that photo.') };
      photoPath = path;
    }

    const { data: userData } = await supabase.auth.getUser();
    const payload: Record<string, unknown> = {
      company: COMPANY,
      month,
      employee_email: email,
      caption: params.caption?.trim() ? params.caption.trim() : null,
      created_by: userData?.user?.email ?? null,
    };
    // Only overwrite photo_path when a new photo was actually picked, so
    // editing just the caption doesn't wipe the picture.
    if (photoPath) payload.photo_path = photoPath;

    const { error } = await supabase
      .from('employee_of_month')
      .upsert(payload, { onConflict: 'company,month' });
    if (error) {
      return { ok: false, message: friendlyMessage(error.message, 'Could not save that month.') };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not save that month.',
    };
  }
}

/**
 * Remove a month's award, and best-effort the photo file it uploaded.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NEVER REMOVE AN `eom/library/*` OBJECT. READ THIS BEFORE CHANGING IT.
 * ─────────────────────────────────────────────────────────────────────────
 * Since the Dropbox picker landed, `photo_path` is one of two completely
 * different things: a file this screen uploaded for this month alone
 * (`eom/2026-08-1755…​.jpg`), or a pointer at the SHARED library mirrored
 * from Dropbox (`eom/library/<id>.jpg`) that a second month may also be using
 * and that the sync considers its own. Deleting a month is a small,
 * reversible act; deleting a library file destroys the original Devon dropped
 * in Dropbox, and the next sync would simply re-download it — so the "clean
 * up" would also mean re-downloading the file every night forever.
 *
 * `isLibraryPath` is the guard. It is deliberately generous about leading
 * slashes and case: the only failure mode that matters is answering "no" for
 * a library file, so anything that even looks like one is left alone.
 */
export async function deleteEmployeeOfMonth(month: string): Promise<EomMutationResult> {
  const normalized = normalizeMonth(month);
  if (!normalized) return { ok: false, message: 'Unknown month.' };
  try {
    const { data, error } = await supabase
      .from('employee_of_month')
      .delete()
      .eq('company', COMPANY)
      .eq('month', normalized)
      .select('photo_path');
    if (error) {
      return { ok: false, message: friendlyMessage(error.message, 'Could not remove that month.') };
    }
    if (!data || data.length === 0) {
      return { ok: false, message: 'Could not remove that month.' };
    }
    const path = (data[0] as { photo_path: string | null }).photo_path;
    if (path && !isLibraryPath(path)) {
      // Best effort: an orphaned object is invisible, a failed delete is not
      // worth failing the whole action over.
      try {
        await supabase.storage.from(PHOTO_BUCKET).remove([path]);
      } catch {
        /* ignore */
      }
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not remove that month.',
    };
  }
}
