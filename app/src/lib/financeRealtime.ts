/**
 * Live money — refetch the Financials screen when any money row changes.
 *
 * Same shape as `useCommsRealtime` in lib/comms.ts: one channel, resubscribed
 * on auth changes, torn down on unmount. Five tables ride on one channel
 * (finance_entries, payroll_runs, company_settings, company_assets,
 * company_liabilities — all added to the `supabase_realtime` publication by
 * migration 2026-09-12_company_assets.sql). RLS applies to the change feed,
 * so a non-admin subscribed here simply hears nothing.
 *
 * Debounced: the email scanner and a bulk edit can land several rows in a
 * burst, and the screen's `load()` is five queries — one refetch per burst.
 */

import { useEffect, useRef } from 'react';

import { supabase } from '@/lib/supabase';

const TABLES = [
  'finance_entries',
  'payroll_runs',
  'company_settings',
  'company_assets',
  'company_liabilities',
] as const;

const DEBOUNCE_MS = 700;

let channelSeq = 0;

export function useFinanceRealtime(onChange: () => void, enabled = true): void {
  const handler = useRef(onChange);
  handler.current = onChange;

  useEffect(() => {
    if (!enabled) return;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!cancelled) handler.current();
      }, DEBOUNCE_MS);
    };

    const subscribe = () => {
      if (cancelled) return;
      if (channel) {
        void supabase.removeChannel(channel);
        channel = null;
      }
      channelSeq += 1;
      try {
        let next = supabase.channel(`finance-live-${channelSeq}`);
        for (const table of TABLES) {
          next = next.on('postgres_changes', { event: '*', schema: 'public', table }, fire);
        }
        next.subscribe();
        channel = next;
      } catch {
        // No live updates on this device; focus + pull-to-refresh still cover it.
      }
    };

    subscribe();
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      subscribe();
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      sub.subscription.unsubscribe();
      if (channel) void supabase.removeChannel(channel);
    };
  }, [enabled]);
}
