/**
 * Account kind, self-signup, and account deletion (2026-08-06).
 *
 * The rule: `employees` is granted EXCLUSIVELY by Devon or Isaiah, via the
 * Supabase dashboard. Anyone who signs up in the app is a CUSTOMER and gets
 * no access to anything — a trigger on `auth.users` classifies them, and
 * `employees` has RLS enabled with zero write policies so no client key can
 * ever add itself to staff.
 *
 * `kind` here is for ROUTING only. It decides which screen you land on, never
 * what data you can read — that's RLS's job, server-side.
 */

import { supabase } from '@/lib/supabase';

export type AccountKind = 'employee' | 'customer' | 'none';

export interface AccountInfo {
  kind: AccountKind;
  email: string | null;
  fullName: string | null;
}

/**
 * Which kind of account is signed in. Staff win over customer if a row
 * somehow exists in both, so a mis-set customer row can never lock an
 * employee out of the app.
 */
export async function getAccountInfo(): Promise<AccountInfo> {
  try {
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user;
    const email = user?.email ?? null;
    if (!email) return { kind: 'none', email: null, fullName: null };

    const { data: staff } = await supabase
      .from('employees')
      .select('display_name')
      .eq('email', email)
      .maybeSingle();
    if (staff) {
      return {
        kind: 'employee',
        email,
        fullName: (staff as { display_name: string | null }).display_name ?? null,
      };
    }

    const { data: customer } = await supabase
      .from('customer_accounts')
      .select('full_name')
      .eq('user_id', user!.id)
      .maybeSingle();
    return {
      kind: customer ? 'customer' : 'none',
      email,
      fullName: (customer as { full_name: string | null } | null)?.full_name ?? null,
    };
  } catch {
    return { kind: 'none', email: null, fullName: null };
  }
}

export type SignUpResult =
  | { ok: true; needsConfirmation: boolean }
  | { ok: false; message: string };

/**
 * Create a customer account. The `employees` table is untouched — signing up
 * cannot grant staff access.
 *
 * Password rules are enforced by Supabase (min 10, upper + lower + digits,
 * and rejected outright if the password appears in a known breach), so the
 * messages below just relay what the server says rather than duplicating the
 * policy in the client where it could drift.
 */
export async function signUpCustomer(params: {
  email: string;
  password: string;
  fullName: string;
}): Promise<SignUpResult> {
  try {
    const { data, error } = await supabase.auth.signUp({
      email: params.email.trim(),
      password: params.password,
      options: { data: { full_name: params.fullName.trim() } },
    });
    if (error) return { ok: false, message: error.message };
    // With email confirmation on, session is null until they click the link.
    return { ok: true, needsConfirmation: data.session === null };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not create the account.',
    };
  }
}

export type DeleteAccountResult = { ok: true } | { ok: false; message: string };

/**
 * Permanently delete the signed-in user's login (App Store 5.1.1(v)).
 *
 * Runs server-side in the `delete-account` edge function because removing an
 * auth user needs the service role. The account id comes from the verified
 * JWT there, not from anything this client sends.
 */
export async function deleteOwnAccount(): Promise<DeleteAccountResult> {
  try {
    const { data, error } = await supabase.functions.invoke('delete-account', {
      body: { confirm: 'DELETE' },
    });
    if (error) {
      // supabase-js hides the real body on non-2xx; dig it out.
      const context = (error as { context?: unknown }).context;
      if (context && typeof context === 'object') {
        try {
          const body = (await (context as Response).clone().json()) as { error?: string };
          if (typeof body?.error === 'string') return { ok: false, message: body.error };
        } catch {
          // fall through to the generic message
        }
      }
      return { ok: false, message: error.message ?? 'Could not delete the account.' };
    }
    if (!(data as { ok?: boolean } | null)?.ok) {
      return { ok: false, message: 'Could not delete the account.' };
    }
    await supabase.auth.signOut();
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not delete the account.',
    };
  }
}
