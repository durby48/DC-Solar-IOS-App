/**
 * QuickBooks Online connection (2026-10-14).
 *
 * Everything goes through the `qbo-oauth` edge function — the tokens live in
 * `qbo_connections`, which no app role can read, so the app only ever learns
 * "connected to <company> on <plan>" and never holds a QuickBooks login.
 */

import { readFunctionError } from '@/lib/artwork';
import { supabase } from '@/lib/supabase';

export type QboStatus = {
  connected: boolean;
  /** Why it is not connected, when there was a connection that stopped working. */
  reason?: string | null;
  companyName?: string | null;
  /** e.g. "QuickBooks Online Plus". */
  offeringSku?: string | null;
  realmId?: string | null;
  environment?: string | null;
  connectedBy?: string | null;
  connectedAt?: string | null;
};

type Result<T> = { ok: true; value: T } | { ok: false; message: string };

async function call(action: 'start' | 'status' | 'disconnect'): Promise<Result<Record<string, unknown>>> {
  const { data, error } = await supabase.functions.invoke('qbo-oauth', { body: { action } });
  if (error) {
    return { ok: false, message: (await readFunctionError(error)) ?? 'Could not reach the QuickBooks service.' };
  }
  const body = data as { ok?: boolean; error?: string } & Record<string, unknown>;
  if (!body?.ok) return { ok: false, message: body?.error ?? 'QuickBooks request failed.' };
  return { ok: true, value: body };
}

export async function fetchQboStatus(): Promise<Result<QboStatus>> {
  const res = await call('status');
  if (!res.ok) return res;
  const v = res.value;
  return {
    ok: true,
    value: {
      connected: v.connected === true,
      reason: (v.reason as string | null | undefined) ?? null,
      companyName: (v.company_name as string | null | undefined) ?? null,
      offeringSku: (v.offering_sku as string | null | undefined) ?? null,
      realmId: (v.realm_id as string | null | undefined) ?? null,
      environment: (v.environment as string | null | undefined) ?? null,
      connectedBy: (v.connected_by as string | null | undefined) ?? null,
      connectedAt: (v.connected_at as string | null | undefined) ?? null,
    },
  };
}

/** The Intuit consent page to send the admin to. */
export async function startQboConnect(): Promise<Result<string>> {
  const res = await call('start');
  if (!res.ok) return res;
  const url = res.value.url;
  return typeof url === 'string' ? { ok: true, value: url } : { ok: false, message: 'No QuickBooks link came back.' };
}

export async function disconnectQbo(): Promise<Result<null>> {
  const res = await call('disconnect');
  return res.ok ? { ok: true, value: null } : res;
}

/** Job costing (Projects, per-job profit) needs Plus or Advanced. */
export function planSupportsJobCosting(sku: string | null | undefined): boolean {
  return /\b(plus|advanced)\b/i.test(sku ?? '');
}
