/**
 * Cash position — reconciling the bank balance to profit retained.
 *
 * The bank balance is not profit, and the difference is not noise. Capital the
 * owners put in is sitting in the account without ever having been earned;
 * money owed to someone for an out-of-pocket purchase is still in the account
 * but already spent; a card payment recorded today has not been deposited yet.
 *
 *   bank balance
 *     − capital in the business      never earned, just contributed
 *     − owed for out-of-pocket       already spent, not yet paid back
 *     − wages worked but unpaid      already earned by the crew
 *     + receipts awaiting deposit    already earned, not yet arrived
 *     = profit retained
 *
 * This is the same arithmetic as scripts/reconcile/bridge.mjs, run the other
 * way round: the script starts from profit and predicts the balance, this
 * starts from the balance and reports profit.
 */

import { loadedLaborCost } from '@/lib/laborCost';
import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

export interface CompanySettings {
  /** Last balance an admin recorded. Null until someone enters one. */
  bankBalance: number | null;
  /** The date that balance was true, so the UI can say how stale it is. */
  bankBalanceAsOf: string | null;
  /** Last day covered by a completed payroll run. */
  payrollThrough: string | null;
}

export interface CashPosition extends CompanySettings {
  /** Owner capital still in the business, net of anything withdrawn. */
  capital: number;
  /** Booked expenses somebody paid personally and has not been paid back for. */
  owed: number;
  /** Wages worked after the last payroll run. */
  unpaidWages: number;
  /** Payments recorded whose money has not landed yet, net of fees. */
  inTransit: number;
  /** bank − capital − owed − unpaidWages + inTransit. Null without a balance. */
  profitRetained: number | null;
}

export async function fetchCompanySettings(): Promise<CompanySettings | null> {
  const { data, error } = await supabase
    .from('company_settings')
    .select('bank_balance, bank_balance_as_of, payroll_through')
    .eq('company', COMPANY)
    .maybeSingle();
  if (error || !data) return null;
  return {
    bankBalance: data.bank_balance === null ? null : Number(data.bank_balance),
    bankBalanceAsOf: data.bank_balance_as_of ?? null,
    payrollThrough: data.payroll_through ?? null,
  };
}

/**
 * Wages for hours worked after the last completed payroll run.
 *
 * Returns 0 when `payrollThrough` is unset — without it there is no way to tell
 * paid hours from unpaid, and guessing would silently distort the cash
 * position. `laborMap` on the Financials screen cannot answer this: it is
 * keyed by job with no dates.
 */
export async function fetchUnpaidWages(
  payrollThrough: string | null,
): Promise<number> {
  if (!payrollThrough) return 0;
  const { data, error } = await supabase
    .from('employee_hours')
    .select('hours, rate')
    .eq('company', COMPANY)
    .gt('occurred_on', payrollThrough);
  if (error || !data) return 0;
  // Loaded, not gross: the payroll withdrawal Gusto makes is gross wages PLUS
  // the employer taxes, so this is the amount that will actually leave the
  // account (within pennies of every 2026 run).
  return loadedLaborCost(
    data.reduce((sum, row) => sum + Number(row.hours ?? 0) * Number(row.rate ?? 0), 0),
  );
}

/** Record a freshly reconciled balance. Admin-only per RLS. */
export async function saveBankBalance(
  balance: number,
  asOf: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await supabase
    .from('company_settings')
    .update({
      bank_balance: balance,
      bank_balance_as_of: asOf,
      updated_at: new Date().toISOString(),
    })
    .eq('company', COMPANY);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}
