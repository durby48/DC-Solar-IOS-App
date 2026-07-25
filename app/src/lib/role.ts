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
 * React hook: current user's role info (null while loading / signed out).
 * Re-fetches on auth state changes.
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
