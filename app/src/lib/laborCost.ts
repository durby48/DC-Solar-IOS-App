/**
 * What an hour of labor actually costs the company.
 *
 * `employee_hours.rate` is the GROSS wage — what the employee earns. The
 * company pays more than that on every dollar of gross:
 *
 *   Social Security (employer half)   6.200%
 *   Medicare (employer half)          1.450%
 *   FUTA                              0.600%
 *   MO Unemployment Insurance         2.376%
 *   ────────────────────────────────────────
 *   employer burden                  10.626%
 *
 * Verified against all four 2026 Gusto pay receipts (paydays Jul 10, Jul 24,
 * Aug 10, Aug 24): employer taxes ÷ gross = 10.626% in every run, to the
 * penny. So a $33/h crew member costs ≈ $36.51/h, and $35/h costs ≈ $38.72/h.
 *
 * Every EXPENSE view of labor multiplies by this. Payroll views (the Hours
 * tab that feeds the Gusto submission, My Hours) stay at gross — that is the
 * number wages are actually paid from.
 *
 * Since 2026-08-23 the ledger's hand-booked "Employer payroll taxes" expense
 * rows are GONE (they double-counted against this multiplier) — do not add
 * them back per-run.
 *
 * Caveats, deliberately ignored for an estimate: FUTA caps at $7,000 of wages
 * per employee per year and MO UI at its own wage base, so late in the year
 * this slightly overstates the burden. Workers' comp is booked as its own
 * ledger expense (2026: $1,157/yr prepaid), not part of this rate.
 */
export const EMPLOYER_COST_MULTIPLIER = 1.10626;

/** Gross wages → fully-loaded labor cost (wages + employer payroll taxes). */
export function loadedLaborCost(grossWages: number): number {
  return grossWages * EMPLOYER_COST_MULTIPLIER;
}
