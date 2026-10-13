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
  /** What the plan includes, one item per line (Plans & prices); null = not written yet. */
  includes: string | null;
  /**
   * Commercial price (2026-10-12): Bronze $999 up to 100 panels, Silver $1,499
   * up to 250, Gold $1,999 any size. maxPanels null = no limit.
   */
  commercial: { amountCents: number; maxPanels: number | null; stripePriceId: string | null } | null;
}

export async function fetchServicePlans(): Promise<ServicePlan[]> {
  try {
    const { data, error } = await supabase
      .from('service_plans')
      .select('tier, label, amount_cents, stripe_price_id, includes, commercial_amount_cents, commercial_max_panels, commercial_stripe_price_id')
      .eq('company', COMPANY)
      .order('sort');
    if (error || !data) return [];
    return (
      data as {
        tier: PlanTier;
        label: string;
        amount_cents: number;
        stripe_price_id: string;
        includes: string | null;
        commercial_amount_cents: number | null;
        commercial_max_panels: number | null;
        commercial_stripe_price_id: string | null;
      }[]
    ).map((r) => ({
      tier: r.tier,
      label: r.label,
      amountCents: r.amount_cents,
      stripePriceId: r.stripe_price_id,
      includes: r.includes,
      commercial:
        r.commercial_amount_cents != null
          ? { amountCents: r.commercial_amount_cents, maxPanels: r.commercial_max_panels, stripePriceId: r.commercial_stripe_price_id }
          : null,
    }));
  } catch {
    return [];
  }
}

/** Admin edit of one tier: its yearly amount and the Stripe price it charges. */
export async function saveServicePlan(
  tier: PlanTier,
  patch: {
    amountCents: number;
    stripePriceId: string;
    includes: string | null;
    commercial?: { amountCents: number; maxPanels: number | null; stripePriceId: string | null };
  },
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const { data, error } = await supabase
      .from('service_plans')
      .update({
        amount_cents: patch.amountCents,
        stripe_price_id: patch.stripePriceId,
        includes: patch.includes,
        ...(patch.commercial
          ? {
              commercial_amount_cents: patch.commercial.amountCents,
              commercial_max_panels: patch.commercial.maxPanels,
              commercial_stripe_price_id: patch.commercial.stripePriceId,
            }
          : {}),
        updated_at: new Date().toISOString(),
      })
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

/** "up to 100 panels" / "any size" — what a commercial tier covers. */
export function commercialCovers(plan: Pick<ServicePlan, 'commercial'>): string {
  const max = plan.commercial?.maxPanels;
  return max ? `up to ${max} panels` : 'any size';
}

/** Can this tier be sold commercially for a system this size? Unknown size = not yet. */
export function commercialFits(plan: Pick<ServicePlan, 'commercial'>, panels: number | null | undefined): boolean {
  if (!plan.commercial || !panels) return false;
  return plan.commercial.maxPanels == null || panels <= plan.commercial.maxPanels;
}

/**
 * The commercial tiers that fit, spoken: "Silver at $1,499 a year or Gold at
 * $1,999 a year" (the call script's {{shield_fit}}); null when the panel count
 * is unknown.
 */
export function commercialFitLine(
  plans: Pick<ServicePlan, 'label' | 'commercial'>[],
  panels: number | null | undefined,
): string | null {
  if (!panels) return null;
  const fit = plans.filter((p) => commercialFits(p, panels));
  if (!fit.length) return null;
  const parts = fit.map((p) => `${p.label} at ${formatCents(p.commercial!.amountCents)} a year`);
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}
