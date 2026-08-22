/**
 * Current-user role helper. Reads the signed-in user's `employees` row
 * (matched by session email) and caches it for the session. Degrades to
 * `null` when signed out or when the row can't be read (RLS/network).
 */

import { useEffect, useState } from 'react';

import { supabase } from '@/lib/supabase';

export type EmployeeRole = 'owner' | 'operator' | 'viewer';

export interface RoleInfo {
  email: string;
  displayName: string | null;
  role: EmployeeRole;
  /** owner/operator = admin */
  isAdmin: boolean;
  payRate: number | null;
}

let cache: { email: string; info: RoleInfo | null } | null = null;

/** Drop the cached role (e.g. after sign-out). */
export function clearRoleCache() {
  cache = null;
}

/**
 * Fetch (with cache) the current user's role info. Returns null when signed
 * out, when the employees row is missing, or on any error.
 */
export async function getRole(): Promise<RoleInfo | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const email = data.session?.user?.email ?? null;
    if (!email) {
      cache = null;
      return null;
    }
    if (cache && cache.email === email) return cache.info;

    const { data: row, error } = await supabase
      .from('employees')
      .select('email, display_name, role, pay_rate')
      .eq('email', email)
      .maybeSingle();

    if (error || !row) {
      cache = { email, info: null };
      return null;
    }

    const role = row.role as EmployeeRole;
    const info: RoleInfo = {
      email,
      displayName: (row.display_name as string | null) ?? null,
      role,
      isAdmin: role === 'owner' || role === 'operator',
      payRate: row.pay_rate != null ? Number(row.pay_rate) : null,
    };
    cache = { email, info };
    return info;
  } catch {
    return null;
  }
}

/**
 * The role WITH an explicit loading phase.
 *
 * `useRole()` returns `null` for two completely different situations — "still
 * loading" and "signed out / not staff" — so a screen that gates on
 * `role?.isAdmin` renders the viewer layout first and then pops the admin
 * parts in a moment later. On a list that is a flicker; on the Home hub it is
 * the whole page rearranging itself under your thumb.
 *
 * This separates them: `phase` is `'loading'` until we actually know, and
 * `'ready'` afterwards — including when the answer is "nobody is signed in",
 * which is a real answer and not a loading state.
 *
 * The session is read FIRST, so being signed out costs no query at all; the
 * `employees` lookup only runs when there is somebody to look up.
 */
export function useRoleGate(): { phase: 'loading' | 'ready'; role: RoleInfo | null } {
  const [phase, setPhase] = useState<'loading' | 'ready'>('loading');
  const [role, setRole] = useState<RoleInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    const resolve = async () => {
      const { data } = await supabase.auth.getSession();
      const email = data.session?.user?.email ?? null;
      if (cancelled) return;
      if (!email) {
        setRole(null);
        setPhase('ready');
        return;
      }
      const info = await getRole();
      if (cancelled) return;
      setRole(info);
      setPhase('ready');
    };
    void resolve();
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      if (cancelled) return;
      clearRoleCache();
      void resolve();
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { phase, role };
}

/**
 * React hook: current user's role info (null while loading / signed out).
 * Re-fetches on auth state changes.
 *
 * Prefer `useRoleGate()` when the layout differs by role — see the note there
 * about why `null` is ambiguous.
 */
export function useRole(): RoleInfo | null {
  const [role, setRole] = useState<RoleInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    getRole().then((info) => {
      if (!cancelled) setRole(info);
    });
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      clearRoleCache();
      getRole().then((info) => {
        if (!cancelled) setRole(info);
      });
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return role;
}
