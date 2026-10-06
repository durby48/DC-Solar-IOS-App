/**
 * Developer "view as" — the current view, in a module with NO imports so
 * `lib/supabase.ts` can read it on every request without a cycle
 * (2026-10-08). The actions (start, leave, persist, reload) are in
 * `lib/devView.ts`; the database side is `2026-10-08_developer.sql`.
 *
 *   role    the SCREENS of another role; data and actions stay your own
 *   person  someone's screens AND data, look-only: every database request
 *           carries `x-view-as` + `Prefer: tx=rollback`, so it runs as them
 *           and is then undone
 */

export type ViewRole = 'owner' | 'operator' | 'viewer' | 'sales' | 'sales_manager';

/** `by` is the developer's own email — a saved view never outlives their sign-in. */
export type DevView =
  | { kind: 'role'; role: ViewRole; by: string; logId: string | null; startedAt: number }
  | {
      kind: 'person';
      by: string;
      email: string;
      name: string;
      role: ViewRole;
      uid: string | null;
      logId: string | null;
      startedAt: number;
    };

export interface DevNotice {
  id: number;
  ok: boolean;
  text: string;
}

let view: DevView | null = null;
let loaded = false;
let noticeSeq = 0;
let resolveLoaded: () => void = () => {};
const loadedPromise = new Promise<void>((resolve) => {
  resolveLoaded = resolve;
});

/**
 * Resolves once the saved view has been read at launch (lib/devView.ts).
 * Requests and "who am I" wait on it, so the first screen never loads as the
 * developer and then flips to the viewed person.
 */
export function whenDevViewLoaded(): Promise<void> {
  return loadedPromise;
}
const viewListeners = new Set<() => void>();
const noticeListeners = new Set<(n: DevNotice) => void>();

export function getDevView(): DevView | null {
  return view;
}

/** The person being looked through, or null. */
export function getViewAsPerson(): Extract<DevView, { kind: 'person' }> | null {
  return view?.kind === 'person' ? view : null;
}

export function setDevViewState(next: DevView | null): void {
  view = next;
  loaded = true;
  resolveLoaded();
  viewListeners.forEach((l) => l());
}

export function isDevViewLoaded(): boolean {
  return loaded;
}

export function subscribeDevView(listener: () => void): () => void {
  viewListeners.add(listener);
  return () => {
    viewListeners.delete(listener);
  };
}

/** A short "Ken could do this / can't" line for the banner. */
export function pushDevNotice(ok: boolean, text: string): void {
  const n = { id: ++noticeSeq, ok, text };
  noticeListeners.forEach((l) => l(n));
}

export function subscribeDevNotice(listener: (n: DevNotice) => void): () => void {
  noticeListeners.add(listener);
  return () => {
    noticeListeners.delete(listener);
  };
}

export const ROLE_LABELS: Record<ViewRole, string> = {
  owner: 'Owner',
  operator: 'Operator',
  viewer: 'Crew',
  sales: 'Sales',
  sales_manager: 'Sales manager',
};
