/**
 * Two-factor authentication for STAFF (2026-08-06).
 *
 * Staff sign in with a password and a 6-digit TOTP code. Customers do not —
 * they sign in with Google/Outlook and have nothing worth a second factor.
 * Layering TOTP on top of an OAuth login is also a good way to strand someone.
 *
 * There is no separate "remember this device" toggle because Supabase already
 * behaves that way: verifying a code raises the SESSION to aal2 and it stays
 * there until sign-out. So it's once per device, not once per launch.
 *
 * If someone loses their authenticator, see `supabase/recovery/README.md` —
 * the service-role un-enrol was written and tested BEFORE this shipped.
 */

import { supabase } from '@/lib/supabase';

export interface MfaFactor {
  id: string;
  friendlyName: string | null;
  status: 'verified' | 'unverified';
}

export interface EnrollmentStart {
  factorId: string;
  /** Type this into an authenticator app by hand. */
  secret: string;
  /** otpauth:// URI — what the QR code encodes. */
  uri: string;
  /** SVG data URI of the QR code (renders on web). */
  qrCode: string;
}

export type MfaResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** Enrolled factors on the signed-in account. */
export async function listFactors(): Promise<MfaFactor[]> {
  try {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error || !data) return [];
    return (data.all ?? []).map((f) => ({
      id: f.id,
      friendlyName: f.friendly_name ?? null,
      status: f.status as 'verified' | 'unverified',
    }));
  } catch {
    return [];
  }
}

/**
 * Begin enrolment. Returns the secret + QR; nothing is active until
 * `confirmEnrollment` succeeds, so an abandoned attempt can't lock anyone out.
 */
export async function startEnrollment(): Promise<MfaResult<EnrollmentStart>> {
  try {
    // Clear any half-finished attempt first, or Supabase rejects the new one
    // as a duplicate friendly name and the user gets stuck on a stale QR.
    for (const factor of await listFactors()) {
      if (factor.status === 'unverified') {
        await supabase.auth.mfa.unenroll({ factorId: factor.id });
      }
    }
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: `DC Solar ${new Date().toISOString().slice(0, 10)}`,
    });
    if (error || !data) {
      return { ok: false, message: error?.message ?? 'Could not start setup.' };
    }
    return {
      ok: true,
      value: {
        factorId: data.id,
        secret: data.totp.secret,
        uri: data.totp.uri,
        qrCode: data.totp.qr_code,
      },
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not start setup.' };
  }
}

/** Finish enrolment by proving the authenticator works. */
export async function confirmEnrollment(
  factorId: string,
  code: string,
): Promise<MfaResult<true>> {
  try {
    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId,
      code: code.trim(),
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true, value: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'That code did not work.' };
  }
}

/** Turn 2FA off for the signed-in account. */
export async function removeFactor(factorId: string): Promise<MfaResult<true>> {
  try {
    const { error } = await supabase.auth.mfa.unenroll({ factorId });
    if (error) return { ok: false, message: error.message };
    return { ok: true, value: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not turn it off.' };
  }
}

/**
 * After a password sign-in: does this account still owe us a code?
 *
 * `nextLevel === 'aal2'` means a verified factor exists; if we're only at
 * aal1, the session isn't finished yet.
 */
export async function pendingChallenge(): Promise<{ required: boolean; factorId?: string }> {
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return { required: false };
    if (data.nextLevel !== 'aal2' || data.currentLevel === 'aal2') return { required: false };
    const verified = (await listFactors()).find((f) => f.status === 'verified');
    return verified ? { required: true, factorId: verified.id } : { required: false };
  } catch {
    return { required: false };
  }
}

/** Complete the login challenge, raising the session to aal2. */
export async function submitChallenge(
  factorId: string,
  code: string,
): Promise<MfaResult<true>> {
  try {
    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId,
      code: code.trim(),
    });
    if (error) return { ok: false, message: error.message };
    return { ok: true, value: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'That code did not work.' };
  }
}
