import { router, usePathname } from 'expo-router';
import { useEffect } from 'react';

import { useRoleGate } from '@/lib/role';

/**
 * Keeps a `sales` login inside the sales app (2026-10-05; Home added
 * 2026-10-06, S1).
 *
 * A sales rep's app is the Sales Home (`/`), the CRM tab (`/workspace`), the
 * Calendar (`/schedule`), Keypad and Settings tabs.
 * The tab bar hides the other tabs for them, but a URL typed on the web, an
 * old bookmark, a notification tap or a stray link inside a shared screen can
 * still land anywhere — so any path outside the short list below is replaced
 * with `/workspace`.
 *
 * This is about not showing people screens that are not theirs, NOT about
 * security: the database already returns nothing outside their own records
 * (`2026-10-05_sales_role.sql`). Admins and crew are never redirected.
 */
// /join and /card-saved are public pages (an invite or reset link; Stripe's
// thank-you) that must work even with a rep already signed in on the device.
const ALLOWED = [
  '/workspace',
  '/schedule',
  '/keypad',
  '/settings',
  '/commission',
  '/plans',
  '/saved-texts',
  '/do-not-disturb',
  '/notifications',
  '/calling-check',
  '/lead-map',
  '/resources',
  '/recents',
  '/call',
  '/security',
  '/set-password',
  '/join',
  '/card-saved',
  '/brochure',
  '/dev-tools',
];

function allowed(pathname: string): boolean {
  // Home is `/` exactly — a prefix match on "/" would allow everything.
  if (pathname === '/') return true;
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
