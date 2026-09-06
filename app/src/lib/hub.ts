/**
 * The app's navigation map, as data.
 *
 * Home and Menu are two renderings of the same list — Home draws it as a grid
 * of `Tile`s grouped under section headers, Menu draws it as dense `ListRow`
 * groups — so the list itself has to live somewhere neither of them owns.
 * Before this, `(tabs)/more.tsx` hand-maintained an `ITEMS` array with a typed
 * href union and NO role gating at all: every crew member saw Employees and
 * Employee of the Month, and every new screen meant editing that union by
 * hand. One list, one gate, both screens.
 *
 * The gate here is presentation only. It decides what a person is OFFERED,
 * never what they can read — every destination screen still checks
 * `role.isAdmin` itself, and RLS decides what the queries return. Hiding a
 * tile is a courtesy, not a security boundary.
 *
 * `href` is typed as expo-router's `Href`, so a route that doesn't exist is a
 * compile error rather than a dead tap (`app.json` sets
 * `experiments.typedRoutes`).
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import type { Href } from 'expo-router';

import type { TileTone } from '@/components/ui';

type IconName = keyof typeof Ionicons.glyphMap;

export type HubGroupKey = 'work' | 'money' | 'admin' | 'customers' | 'employee' | 'account';

/** Who an entry is offered to. `admin` = owner or operator. */
export type HubGate = 'all' | 'admin';

/**
 * Which live count rides on an entry, if any. The number itself is fetched by
 * the screen (Home and Menu both call `fetchUnreadCount`), because a count is
 * a query and this module is a map.
 */
export type HubBadge = 'unread';

export interface HubGroup {
  key: HubGroupKey;
  /** The uppercase eyebrow above the group. */
  title: string;
  /** One line of context under it, or omitted for a self-evident group. */
  subtitle?: string;
  gate: HubGate;
}

export interface HubItem {
  key: string;
  title: string;
  icon: IconName;
  href: Href;
  group: HubGroupKey;
  /** Tile colour: an index into `accentCycle`, or the brand olive. */
  tone: TileTone;
  gate: HubGate;
  badge?: HubBadge;
}

/**
 * The five sections, in the order Home and Menu render them.
 *
 * Money is admin-gated as a GROUP: a viewer has no Financials and no Sales, so
 * showing them an empty "Money" header would just be a locked door with a
 * label on it.
 */
export const HUB_GROUPS: readonly HubGroup[] = [
  { key: 'work', title: 'Work', gate: 'all' },
  { key: 'money', title: 'Money', gate: 'admin' },
  { key: 'customers', title: 'Customers', gate: 'all' },
  { key: 'employee', title: 'Employee', gate: 'all' },
  { key: 'admin', title: 'Admin', gate: 'admin' },
  { key: 'account', title: 'Account', gate: 'all' },
];

export const HUB_ITEMS: readonly HubItem[] = [
  // ---- Work ----
  { key: 'calendar', title: 'Calendar', icon: 'calendar', href: '/calendar', group: 'work', tone: 'olive', gate: 'all' },
  { key: 'pipeline', title: 'Pipeline', icon: 'layers', href: '/pipeline', group: 'work', tone: 0, gate: 'all' },
  { key: 'email', title: 'Email', icon: 'mail', href: '/inbox', group: 'work', tone: 2, gate: 'admin' },
  { key: 'receipts', title: 'Receipts', icon: 'receipt', href: '/more/receipts', group: 'work', tone: 4, gate: 'all' },
  { key: 'inventory', title: 'Inventory', icon: 'cube', href: '/more/inventory', group: 'work', tone: 1, gate: 'all' },
  { key: 'checklist', title: 'Vehicle Checklist', icon: 'clipboard', href: '/more/checklist', group: 'work', tone: 2, gate: 'all' },

  // ---- Money (admin) ----
  { key: 'financials', title: 'Financials', icon: 'wallet', href: '/financials', group: 'money', tone: 'olive', gate: 'admin' },
  { key: 'sales', title: 'Sales', icon: 'trending-up', href: '/sales', group: 'money', tone: 5, gate: 'admin' },
  // href cast until the dev server regenerates typed routes for /leads.
  { key: 'leads', title: 'Leads', icon: 'person-add', href: '/leads' as never, group: 'money', tone: 3, gate: 'admin' },

  // ---- Admin ----
  { key: 'monitoring', title: 'Monitoring Logins', icon: 'pulse', href: '/more/monitoring', group: 'admin', tone: 3, gate: 'admin' },
  { key: 'marketing-photos', title: 'Marketing Photos', icon: 'images', href: '/marketing-photos', group: 'admin', tone: 6, gate: 'admin' },

  // ---- Customers ----
  { key: 'customers', title: 'Customers', icon: 'people', href: '/customers', group: 'customers', tone: 0, gate: 'all', badge: 'unread' },
  // Phone replaced the Messages tile on 2026-09-06: the inbox is now a tab
  // inside it (Contacts · Keypad · Recents · Messages), and two tiles into
  // the same inbox would be clutter. Keeps Messages' tone so the Home grid's
  // colour rhythm does not shift. Admin-gated by Devon's decision; RLS is
  // what actually stops a crew member, this only stops the tile appearing.
  // href cast until the dev server regenerates typed routes for /phone.
  { key: 'phone', title: 'Phone', icon: 'call', href: '/phone' as never, group: 'customers', tone: 7, gate: 'admin', badge: 'unread' },

  // ---- Employee ----
  { key: 'hours', title: 'Hours', icon: 'time', href: '/hours', group: 'employee', tone: 1, gate: 'admin' },
  // Moved out of Customers: the deck is a personal collection now — one pack
  // per ten hours worked — so it belongs next to Hours and Paystubs, not
  // alongside the customer list it never had anything to do with.
  { key: 'cards', title: 'Trading Cards', icon: 'albums', href: '/cards', group: 'employee', tone: 3, gate: 'all' },
  { key: 'time-off', title: 'Time Off', icon: 'airplane', href: '/more/time-off', group: 'employee', tone: 2, gate: 'all' },
  { key: 'paystubs', title: 'Paystubs', icon: 'cash', href: '/more/paystubs', group: 'employee', tone: 6, gate: 'all' },
  { key: 'employees', title: 'Employees', icon: 'id-card', href: '/more/employees', group: 'employee', tone: 4, gate: 'admin' },
  { key: 'eom', title: 'Employee of the Month', icon: 'trophy', href: '/more/employee-of-month', group: 'employee', tone: 5, gate: 'admin' },

  // ---- Account ----
  { key: 'security', title: 'Security & 2FA', icon: 'shield-checkmark', href: '/security', group: 'account', tone: 'olive', gate: 'all' },
];

function allowed(gate: HubGate, isAdmin: boolean): boolean {
  return gate === 'all' || isAdmin;
}

/** The entries in one group this person is offered, in declaration order. */
export function visibleItems(isAdmin: boolean, group: HubGroupKey): HubItem[] {
  return HUB_ITEMS.filter((item) => item.group === group && allowed(item.gate, isAdmin));
}

/**
 * The groups worth drawing a header for: gated in, and non-empty once their
 * own items are filtered. A group whose every entry is admin-only disappears
 * for a viewer rather than leaving a bare heading.
 */
export function visibleGroups(isAdmin: boolean): HubGroup[] {
  return HUB_GROUPS.filter(
    (group) => allowed(group.gate, isAdmin) && visibleItems(isAdmin, group.key).length > 0,
  );
}
