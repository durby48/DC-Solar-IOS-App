import { supabase } from '@/lib/supabase';

/**
 * The annual service plan tiers (2026-10-06): Bronze / Silver / Gold, each a
 * yearly Stripe price, plus a rep's Custom price. The rows live in
 * `service_plans` (2026-10-06_service_plans.sql) — every employee reads them
 * so a rep can quote; admins edit them in CRM Settings → Service plans.
 *
 * Money is in CENTS everywhere, as Stripe has it.
 */

const COMPANY = 'dc-solar';

export type PlanTier = 'bronze' | 'silver' | 'gold';
export type PlanChoice = PlanTier | 'custom';

export const PLAN_LABEL: Record<PlanChoice, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  custom: 'Custom',
};

export interface ServicePlan {
  tier: PlanTier;
  label: string;
  amountCents: number;
  stripePriceId: string;
}

export async function fetchServicePlans(): Promise<ServicePlan[]> {
  try {
    const { data, error } = await supabase
      .from('service_plans')
      .select('tier, label, amount_cents, stripe_price_id')
      .eq('company', COMPANY)
      .order('sort');
    if (error || !data) return [];
    return (data as { tier: PlanTier; label: string; amount_cents: number; stripe_price_id: string }[]).map((r) => ({
      tier: r.tier,
      label: r.label,
      amountCents: r.amount_cents,
      stripePriceId: r.stripe_price_id,
    }));
  } catch {
    return [];
  }
}

/** Admin edit of one tier: its yearly amount and the Stripe price it charges. */
export async function saveServicePlan(
  tier: PlanTier,
  patch: { amountCents: number; stripePriceId: string },
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const { data, error } = await supabase
      .from('service_plans')
      .update({ amount_cents: patch.amountCents, stripe_price_id: patch.stripePriceId, updated_at: new Date().toISOString() })
      .eq('company', COMPANY)
      .eq('tier', tier)
      .select('tier');
    if (error || !data?.length) return { ok: false, message: error?.message ?? 'Not saved — admins only.' };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Not saved.' };
  }
}

/** 49900 → "$499", 65050 → "$650.50". */
export function formatCents(cents: number | null | undefined): string {
  if (cents == null) return '';
  const dollars = cents / 100;
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** "Silver · $499/yr", "Custom · $650/yr", or null when no plan was picked. */
export function planSummary(tier: string | null | undefined, cents: number | null | undefined): string | null {
  if (!tier) return null;
  const label = PLAN_LABEL[tier as PlanChoice] ?? tier;
  return cents ? `${label} · ${formatCents(cents)}/yr` : label;
}

/** "650", "$650", "650.50" → 65000 / 65050; anything else → null. */
export function parseDollars(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}
