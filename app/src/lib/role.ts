/**
 * Current-user role helper. Reads the signed-in user's `employees` row
 * (matched by session email) and caches it for the session. Degrades to
 * `null` when signed out or when the row can't be read (RLS/network).
 */

import { useEffect, useState } from 'react';

import '@/lib/devView';
import { getDevView } from '@/lib/devViewState';
import { clearStaffNames, loadStaffNames } from '@/lib/staffNames';
import { supabase } from '@/lib/supabase';

/**
 * `sales` (2026-10-05): sales reps who see ONLY the CRM, and in it only the
 * prospects/leads/customers that are theirs. Never an admin. The database
 * enforces the narrowing (supabase/migrations/2026-10-05_sales_role.sql);
 * `isSales` only shapes the screens.
 */
export type EmployeeRole = 'owner' | 'operator' | 'viewer' | 'sales' | 'sales_manager';

export interface RoleInfo {
  email: string;
  displayName: string | null;
  role: EmployeeRole;
  /** owner/operator = admin */
  isAdmin: boolean;
  /** role === 'sales' or 'sales_manager' — the sales app layout. */
  isSales: boolean;
  /**
   * role === 'sales_manager' (2026-10-07): a rep who also runs the team —
   * sees and assigns every lead, can take one over. Admin-only money stays out.
   */
  isSalesManager: boolean;
  /**
   * The Developer tag (2026-10-08, employees.is_developer): full power on top
   * of the role, and Developer Tools. While a developer switches the screens
   * to another role (Developer Tools → View as a role), `role` and the flags
   * above follow the chosen role and `realRole` keeps their own.
   */
  isDeveloper: boolean;
  realRole: EmployeeRole;
  payRate: number | null;
}

let cache: { email: string; info: RoleInfo | null } | null = null;

/** Drop the cached role (e.g. after sign-out). */
export function clearRoleCache() {
  cache = null;
  clearStaffNames();
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
      .select('email, display_name, role, pay_rate, is_developer')
      .eq('email', email)
      .maybeSingle();

    if (error || !row) {
      cache = { email, info: null };
      return null;
    }

    const realRole = row.role as EmployeeRole;
    const isDeveloper = Boolean((row as { is_developer?: boolean | null }).is_developer);
    // Developer Tools → View as a role: the screens of that role, own data.
    // (View as a person needs nothing here: the session already IS them.)
    const view = getDevView();
    const role = isDeveloper && view?.kind === 'role' ? view.role : realRole;
    const info: RoleInfo = {
      email,
      displayName: (row.display_name as string | null) ?? null,
      role,
      isAdmin: role === 'owner' || role === 'operator',
      isSales: role === 'sales' || role === 'sales_manager',
      isSalesManager: role === 'sales_manager',
      isDeveloper,
      realRole,
      payRate: row.pay_rate != null ? Number(row.pay_rate) : null,
    };
    cache = { email, info };
    // Names for "who did it" labels in the CRM (lib/staffNames.ts).
    void loadStaffNames();
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
