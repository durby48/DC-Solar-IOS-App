/**
 * Employee of the Month data layer.
 *
 * The award is DATA, not code: one `employee_of_month` row per month, written
 * by an admin along with that month's photo (see
 * supabase/migrations/2026-08-18_employee_of_month.sql for why). Today's rule
 * — Garrett every month with a different photo — is therefore just a series of
 * rows, and changing it needs no release.
 *
 * Reads NEVER throw. The card sits on the Today screen in front of the whole
 * crew, so a missing table, an RLS denial or a dead connection must degrade to
 * "show nothing" (or the signed-out mock), not to a red screen.
 *
 * Photos live in the EXISTING private `job-photos` bucket under an `eom/`
 * prefix — the same trick customer avatars use, so there are no new storage
 * policies to get wrong. Display URLs are signed for an hour.
 */

import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';
const PHOTO_BUCKET = 'job-photos';
/** Seconds a display URL stays valid. */
const SIGNED_URL_TTL = 3600;

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
  /** True for the signed-out demo card (never hits the database). */
  isMock: boolean;
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
 * The demo card. Shown only when nobody is signed in, so the signed-out
 * preview still has something to look at. No photo — the component falls back
 * to initials, and the private bucket would refuse an anonymous read anyway.
 */
function mockCard(): EmployeeOfMonthCard {
  const month = currentMonthISO();
  return {
    month,
    label: formatMonthLabel(month),
    employeeName: 'Garrett Nimsgern',
    employeeEmail: 'gnimsgern.2022@gmail.com',
    photoUrl: null,
    caption: null,
    isFallback: false,
    isMock: true,
  };
}

/**
 * The card to show right now: this month's row, or — when nobody has filed one
 * yet — the most recent row that exists, still labelled with the CURRENT month
 * so the card never goes blank in front of the crew.
 *
 * Returns null (render nothing) when signed in but the table is missing, RLS
 * denies, or there are no rows at all.
 */
export async function fetchEmployeeOfMonth(): Promise<EmployeeOfMonthCard | null> {
  try {
    const { data: session } = await supabase.auth.getSession();
    if (!session.session?.user?.email) return mockCard();

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
      isMock: false,
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
 * Create or replace a month's award, optionally uploading a new photo first.
 *
 * The upload mirrors lib/customers.ts::uploadCustomerPhoto exactly: fetch the
 * picked URI into a blob (which is how the content type is discovered on both
 * web and native — expo-image-picker hands back a file:// URI on the phone and
 * a blob: URI in the browser, and `fetch` normalises both), then upload the
 * blob with its own type. The caller crops via the picker's `allowsEditing`;
 * there is no image-processing library in the bundle.
 *
 * The path is timestamped so replacing a month's photo can never collide with
 * a signed URL still cached on somebody's phone.
 */
export async function upsertEmployeeOfMonth(params: {
  month: string;
  employeeEmail: string;
  caption?: string | null;
  /** Local URI from expo-image-picker. Omit to keep the existing photo. */
  photo?: string | null;
}): Promise<EomMutationResult> {
  const month = normalizeMonth(params.month);
  if (!month) return { ok: false, message: 'Use a month in YYYY-MM form, e.g. 2026-08.' };
  const email = params.employeeEmail.trim().toLowerCase();
  if (!email) return { ok: false, message: 'Pick an employee first.' };

  try {
    let photoPath: string | null = null;
    if (params.photo) {
      const response = await fetch(params.photo);
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

/** Remove a month's award (and best-effort its photo file). */
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
    if (path) {
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
