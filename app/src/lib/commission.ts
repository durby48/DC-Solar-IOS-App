import { supabase } from '@/lib/supabase';

/**
 * Sales commission (2026-10-06, S4). Rows are written only by stripe-webhook
 * (`record_sales_commission`): one per payment — first year or renewal — and
 * one per refund (negative), each already placed in its pay period. RLS shows
 * a rep their own rows and admins everyone's; only admins mark a period paid.
 * Money is in cents.
 */

const COMPANY = 'dc-solar';

export interface CommissionRow {
  id: string;
  repEmail: string;
  customerId: string | null;
  customerName: string | null;
  kind: 'first' | 'renewal' | 'refund';
  amountCents: number;
  commissionCents: number;
  rate: number;
  occurredOn: string;
  periodStart: string;
  periodEnd: string;
  paidAt: string | null;
}

export interface PayPeriod {
  start: string;
  end: string;
}

export const KIND_LABEL: Record<CommissionRow['kind'], string> = {
  first: 'First year',
  renewal: 'Renewal',
  refund: 'Refund',
};

export async function fetchCurrentPayPeriod(): Promise<PayPeriod | null> {
  try {
    const { data, error } = await supabase.rpc('current_pay_period');
    const row = (data as { period_start: string; period_end: string }[] | null)?.[0];
    if (error || !row) return null;
    return { start: row.period_start, end: row.period_end };
  } catch {
    return null;
  }
}

/** Every row the caller may read (a rep: theirs; an admin: all), newest first. */
export async function fetchCommissions(): Promise<CommissionRow[]> {
  try {
    const { data, error } = await supabase
      .from('sales_commissions')
      .select('id, rep_email, customer_id, kind, amount_cents, commission_cents, rate, occurred_on, period_start, period_end, paid_at, customers(name)')
      .eq('company', COMPANY)
      .order('occurred_on', { ascending: false });
    if (error || !data) return [];
    return (data as Record<string, unknown>[]).map((r) => {
      const c = r.customers as { name?: string } | { name?: string }[] | null;
      const customer = Array.isArray(c) ? c[0] : c;
      return {
        id: r.id as string,
        repEmail: r.rep_email as string,
        customerId: (r.customer_id as string | null) ?? null,
        customerName: customer?.name ?? null,
        kind: r.kind as CommissionRow['kind'],
        amountCents: r.amount_cents as number,
        commissionCents: r.commission_cents as number,
        rate: Number(r.rate),
        occurredOn: r.occurred_on as string,
        periodStart: r.period_start as string,
        periodEnd: r.period_end as string,
        paidAt: (r.paid_at as string | null) ?? null,
      };
    });
  } catch {
    return [];
  }
}

/** Admin: stamp one rep's unpaid rows in one pay period as paid. */
export async function markPeriodPaid(
  repEmail: string,
  periodStart: string,
  by: string | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const { data, error } = await supabase
      .from('sales_commissions')
      .update({ paid_at: new Date().toISOString(), paid_by: by })
      .eq('company', COMPANY)
      .eq('rep_email', repEmail)
      .eq('period_start', periodStart)
      .is('paid_at', null)
      .select('id');
    if (error) return { ok: false, message: error.message };
    if (!data?.length) return { ok: false, message: 'Nothing to mark — admins only, or already paid.' };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Not saved.' };
  }
}

/** Sum of commission in cents. */
export function totalCents(rows: CommissionRow[]): number {
  return rows.reduce((sum, r) => sum + r.commissionCents, 0);
}

/** "Sep 29 – Oct 12" */
export function periodLabel(start: string, end: string): string {
  const f = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${f(start)} – ${f(end)}`;
}
