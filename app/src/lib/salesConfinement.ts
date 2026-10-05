import { router, usePathname } from 'expo-router';
import { useEffect } from 'react';

import { useRoleGate } from '@/lib/role';

/**
 * Keeps a `sales` login inside the CRM (2026-10-05).
 *
 * A sales rep's whole app is the CRM tab (`/workspace`). The tab bar hides the
 * other tabs for them, but a URL typed on the web, an old bookmark, a
 * notification tap or a stray link inside a shared screen can still land
 * anywhere — so any path outside the short list below is replaced with
 * `/workspace`.
 *
 * This is about not showing people screens that are not theirs, NOT about
 * security: the database already returns nothing outside their own records
 * (`2026-10-05_sales_role.sql`). Admins and crew are never redirected.
 */
const ALLOWED = ['/workspace', '/call', '/security', '/set-password'];

function allowed(pathname: string): boolean {
  return ALLOWED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function useSalesConfinement(): void {
  const pathname = usePathname();
  const gate = useRoleGate();
  const isSales = gate.phase === 'ready' && gate.role?.isSales === true;

  useEffect(() => {
    if (!isSales || allowed(pathname)) return;
    router.replace('/workspace' as never);
  }, [isSales, pathname]);
}
