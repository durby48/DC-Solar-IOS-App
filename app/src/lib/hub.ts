/**
 * The app's navigation map, as data.
 *
 * 2026-09-12 OVERHAUL: five hubs. Home shows five hub tiles — CRM, Pipeline,
 * Operations, Human Resources, Systems Management — and each hub lists its
 * own entries (`app/hub/[key].tsx`, or a dedicated screen where one exists).
 * The Menu tab draws the same map as dense rows. The bottom tabs are Home ·
 * CRM · Pipeline · Operations · Menu.
 *
 * EVERYBODY SEES THE SAME LAYOUT. There is no `visibleItems` any more: a
 * crew member sees every tile and every row; the admin-only ones are drawn
 * locked and, on tap, explain that they need their administrator
 * (`lib/adminGate.ts`). The `gate` field decides which. RLS decides what any
 * screen actually loads — hiding or locking a tile was never the security.
 *
 * `href` is typed as expo-router's `Href`, so a route that doesn't exist is a
 * compile error rather than a dead tap (`app.json` sets
 * `experiments.typedRoutes`).
 */

import Ionicons from '@expo/vector-icons/Ionicons';
import type { Href } from 'expo-router';

import type { TileTone } from '@/components/ui';
import type { HubKey } from '@/constants/theme';

type IconName = keyof typeof Ionicons.glyphMap;

export type { HubKey };

/** Who an entry is for. `admin` = owner or operator; others see it locked. */
export type HubGate = 'all' | 'admin';

/**
 * Which live count rides on an entry, if any. The number itself is fetched by
 * the screen (Home and Menu both call `fetchUnreadCount`), because a count is
 * a query and this module is a map.
 */
export type HubBadge = 'unread';

export interface Hub {
  key: HubKey;
  title: string;
  /** One line under the title on the Home tile. */
  subtitle: string;
  icon: IconName;
  /** Where the Home tile goes. Hubs with one obvious screen go straight there. */
  href: Href;
  /** Whether the whole hub is an admin area (Systems Management). */
  gate: HubGate;
}

export interface HubItem {
  key: string;
  title: string;
  icon: IconName;
  href: Href;
  hub: HubKey;
  /** Icon / edge colour: an index into `accentCycle`, the brand olive, or a hub key. */
  tone: TileTone;
  gate: HubGate;
  badge?: HubBadge;
  /** One short line under the title inside the hub screen. */
  subtitle?: string;
}

/** The five hubs, in Home order. */
export const HUBS: readonly Hub[] = [
  {
    key: 'crm',
    title: 'CRM',
    subtitle: 'Customers, leads, email, phone',
    icon: 'briefcase',
    // The CRM tab: the workspace on the web, the hub list on the phone.
    href: '/workspace',
    gate: 'all',
  },
  {
    key: 'pipeline',
    title: 'Pipeline',
    subtitle: 'Every job, stage by stage',
    icon: 'layers',
    href: '/pipeline',
    gate: 'all',
  },
  {
    key: 'operations',
    title: 'Operations',
    subtitle: 'Calendar and schedule',
    icon: 'calendar',
    href: '/calendar',
    gate: 'all',
  },
  {
    key: 'hr',
    title: 'Human Resources',
    subtitle: 'Hours, paystubs, time off, cards',
    icon: 'people-circle',
    href: '/hub/hr' as never,
    gate: 'all',
  },
  {
    key: 'systems',
    title: 'Systems Management',
    subtitle: 'Financials, security, inventory',
    icon: 'settings',
    href: '/hub/systems' as never,
    gate: 'admin',
  },
];

export const HUB_ITEMS: readonly HubItem[] = [
  // ---- CRM ----
  { key: 'customers', title: 'Customers', icon: 'people', href: '/customers', hub: 'crm', tone: 'crm', gate: 'all', badge: 'unread', subtitle: 'Every customer record' },
  { key: 'contacts', title: 'Contacts', icon: 'person-circle', href: '/phone/contacts' as never, hub: 'crm', tone: 'crm', gate: 'all', subtitle: 'Company directory' },
  { key: 'leads', title: 'Leads', icon: 'person-add', href: '/leads' as never, hub: 'crm', tone: 3, gate: 'admin', subtitle: 'New inquiries and projections' },
  { key: 'sales', title: 'Sales', icon: 'trending-up', href: '/sales', hub: 'crm', tone: 5, gate: 'admin', subtitle: 'Pipeline money and marketing' },
  { key: 'email', title: 'Email', icon: 'mail', href: '/inbox', hub: 'crm', tone: 3, gate: 'admin', subtitle: 'The business mailbox' },
  // href cast until the dev server regenerates typed routes for /phone.
  { key: 'phone', title: 'Phone', icon: 'call', href: '/phone' as never, hub: 'crm', tone: 7, gate: 'admin', badge: 'unread', subtitle: 'Texts, calls, contacts' },
  { key: 'jobs-board', title: 'Jobs Board', icon: 'grid', href: '/pipeline', hub: 'crm', tone: 'pipeline', gate: 'all', subtitle: 'The pipeline, by customer' },

  // ---- Pipeline ----
  { key: 'pipeline', title: 'Pipeline', icon: 'layers', href: '/pipeline', hub: 'pipeline', tone: 'pipeline', gate: 'all' },

  // ---- Operations ----
  { key: 'calendar', title: 'Calendar', icon: 'calendar', href: '/calendar', hub: 'operations', tone: 'operations', gate: 'all', subtitle: 'Week and month views' },

  // ---- Human Resources ----
  { key: 'hours', title: 'Hours', icon: 'time', href: '/hours', hub: 'hr', tone: 'hr', gate: 'admin', subtitle: 'Payroll periods and logging' },
  { key: 'paystubs', title: 'Paystubs', icon: 'cash', href: '/more/paystubs', hub: 'hr', tone: 6, gate: 'all' },
  { key: 'time-off', title: 'Time Off', icon: 'airplane', href: '/more/time-off', hub: 'hr', tone: 2, gate: 'all' },
  { key: 'cards', title: 'Trading Cards', icon: 'albums', href: '/cards', hub: 'hr', tone: 3, gate: 'all', subtitle: 'One pack per ten hours' },
  { key: 'employees', title: 'Employees', icon: 'id-card', href: '/more/employees', hub: 'hr', tone: 4, gate: 'admin' },
  { key: 'eom', title: 'Employee of the Month', icon: 'trophy', href: '/more/employee-of-month', hub: 'hr', tone: 5, gate: 'admin' },

  // ---- Systems Management ----
  { key: 'financials', title: 'Financials', icon: 'wallet', href: '/financials', hub: 'systems', tone: 'hr', gate: 'admin', subtitle: 'P&L, ledger, cash position' },
  { key: 'receipts', title: 'Receipts', icon: 'receipt', href: '/more/receipts', hub: 'systems', tone: 4, gate: 'all', subtitle: 'Upload and approve' },
  { key: 'inventory', title: 'Inventory', icon: 'cube', href: '/more/inventory', hub: 'systems', tone: 1, gate: 'all' },
  { key: 'checklist', title: 'Vehicle Checklist', icon: 'clipboard', href: '/more/checklist', hub: 'systems', tone: 2, gate: 'all' },
  { key: 'security', title: 'Security & 2FA', icon: 'shield-checkmark', href: '/security', hub: 'systems', tone: 'systems', gate: 'all' },
  { key: 'monitoring', title: 'Monitoring Logins', icon: 'pulse', href: '/more/monitoring', hub: 'systems', tone: 'systems', gate: 'admin' },
  { key: 'marketing-photos', title: 'Marketing Photos', icon: 'images', href: '/marketing-photos', hub: 'systems', tone: 6, gate: 'admin' },
  { key: 'card-catalog', title: 'Card Catalog', icon: 'library', href: '/cards/catalog', hub: 'systems', tone: 3, gate: 'admin', subtitle: 'Sync jobs to cards' },
];

/** One hub by key. */
export function hubFor(key: HubKey): Hub {
  const hub = HUBS.find((h) => h.key === key);
  if (!hub) throw new Error(`Unknown hub: ${key}`);
  return hub;
}

/** The entries of one hub, in declaration order — for EVERY role. */
export function itemsIn(hub: HubKey): HubItem[] {
  return HUB_ITEMS.filter((item) => item.hub === hub);
}

/** The whole map as (hub, items) pairs, in Home order — the Menu tab's shape. */
export function hubSections(): { hub: Hub; items: HubItem[] }[] {
  return HUBS.map((hub) => ({ hub, items: itemsIn(hub.key) }));
}
