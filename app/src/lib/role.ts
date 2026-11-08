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

/** True when the last getRole() reached an answer (cached), false after a failed read. */
let lastReadFailed = false;
function roleAnswered(): boolean {
  return !lastReadFailed;
}

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
      lastReadFailed = false;
      return null;
    }
    if (cache && cache.email === email) return cache.info;

    // A failed READ is not an answer (2026-11-08). supabase-js reports a
    // network failure as `error`, and caching that as "not staff" locked an
    // admin out of every admin screen until relaunch — a notification tap on
    // a cold start, before the radio was up, showed "Admin access needed".
    // Retry briefly; cache only a definite "no row".
    let row: Record<string, unknown> | null = null;
    let failed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await supabase
        .from('employees')
        .select('email, display_name, role, pay_rate, is_developer')
        .eq('email', email)
        .maybeSingle();
      if (!result.error) {
        row = (result.data as Record<string, unknown> | null) ?? null;
        failed = false;
        break;
      }
      failed = true;
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }

    lastReadFailed = failed;
    if (failed) return null; // unknown: not cached, the next call asks again
    if (!row) {
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
    lastReadFailed = true;
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
      if (!info && !roleAnswered()) {
        // The read FAILED (offline): stay 'loading' and ask again shortly,
        // rather than declaring "not staff" and blocking every gate.
        retry = setTimeout(() => void resolve(), 4000);
        return;
      }
      setRole(info);
      setPhase('ready');
    };
    let retry: ReturnType<typeof setTimeout> | null = null;
    void resolve();
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      if (cancelled) return;
      clearRoleCache();
      void resolve();
    });
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
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
    let retry: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      getRole().then((info) => {
        if (cancelled) return;
        setRole(info);
        // A failed read (offline): try again rather than staying role-less.
        if (!info && !roleAnswered()) retry = setTimeout(load, 4000);
      });
    };
    load();
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      clearRoleCache();
      if (retry) clearTimeout(retry);
      load();
    });
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      sub.subscription.unsubscribe();
    };
  }, []);

  return role;
}
