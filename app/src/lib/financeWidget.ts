/**
 * "Company numbers" home-screen widget bridge (2026-11-21, Devon).
 *
 * Writes YTD revenue and company value — QuickBooks' own figures from the
 * `qbo-books` function (income Jan 1 → today, cash basis; equity on the
 * balance sheet) — into the App Group the WidgetKit target reads
 * (targets/widget/index.swift, FinanceWidget).
 *
 * The widget cannot reach QuickBooks itself (that would mean leaving a login
 * inside the widget), so the app refreshes it: on launch, whenever it comes
 * back to the foreground (at most every 15 minutes), and each time the
 * Financials tab loads. Money is company-private: only an admin's phone ever
 * gets numbers, and any other sign-in (or sign-out) wipes them.
 *
 * iOS only; a silent no-op everywhere else.
 */

import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';

import { todayISO } from '@/lib/dates';
import { fetchBooksOverview } from '@/lib/qboBooks';
import { useRoleGate } from '@/lib/role';

const APP_GROUP = 'group.com.dcsolarkc.fieldapp';
const KEY = 'financeState';
const MIN_INTERVAL_MS = 15 * 60_000;

export type FinanceWidgetState = {
  /** QuickBooks income, Jan 1 of `year` → today. */
  ytdRevenue: number;
  /** QuickBooks equity: what the company owns minus what it owes. */
  companyValue: number;
  /** Soft sale valuation: annualized owner earnings × multiple (0 when unknown). */
  saleEstimate: number;
  year: number;
  /** ms since epoch the numbers were read. */
  asOf: number;
};

function storage() {
  const { ExtensionStorage } = require('@bacons/apple-targets') as typeof import('@bacons/apple-targets');
  return { store: new ExtensionStorage(APP_GROUP), reload: () => ExtensionStorage.reloadWidget() };
}

export function writeFinanceWidget(state: FinanceWidgetState | null): void {
  if (Platform.OS !== 'ios') return;
  try {
    const { store, reload } = storage();
    if (state) store.set(KEY, { ...state, ytdRevenue: Math.round(state.ytdRevenue), companyValue: Math.round(state.companyValue), saleEstimate: Math.round(state.saleEstimate) });
    else store.remove(KEY);
    reload();
  } catch {
    // Widget data is best-effort — never let it break the app.
  }
}

let lastSync = 0;

/** Read YTD revenue + company value from QuickBooks and hand them to the widget. */
export async function syncFinanceWidget(force = false): Promise<void> {
  if (Platform.OS !== 'ios') return;
  if (!force && Date.now() - lastSync < MIN_INTERVAL_MS) return;
  lastSync = Date.now();
  const end = todayISO();
  const res = await fetchBooksOverview(`${end.slice(0, 4)}-01-01`, end);
  if (!res.ok) {
    lastSync = 0; // try again next time the app opens
    return;
  }
  writeFinanceWidget({
    ytdRevenue: res.value.headline.income,
    companyValue: res.value.headline.equity,
    saleEstimate: res.value.sale?.estimate ?? 0,
    year: Number(end.slice(0, 4)),
    asOf: Date.now(),
  });
}

/** Mounted once in the root layout: keeps the widget current for admins, empty for everyone else. */
export function useFinanceWidgetSync(): void {
  const { phase, role } = useRoleGate();
  const isAdmin = role?.isAdmin === true && !role.isSales;
  // 'ready' with no role = signed out; null while loading says nothing yet.
  const known = phase === 'ready';
  const wasAdmin = useRef(false);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    if (!isAdmin) {
      // Signed out, or someone without access to the books: no company numbers on this phone.
      if (known || wasAdmin.current) writeFinanceWidget(null);
      wasAdmin.current = false;
      return;
    }
    wasAdmin.current = true;
    void syncFinanceWidget(true);
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void syncFinanceWidget();
    });
    return () => sub.remove();
  }, [isAdmin, known]);
}
