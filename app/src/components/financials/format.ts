/**
 * Money formatting shared by the Financials screen and the four panels it is
 * built from. Lifted verbatim out of `app/financials.tsx` when that file was
 * split, so every figure on the screen still prints exactly as it did.
 */

/** Cents-accurate: the expense ledger, where a row is a real receipt. */
export function formatMoney(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Whole dollars: the headline tiles, where cents are noise. */
export function formatRounded(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

/**
 * A signed figure with a true minus sign (U+2212) rather than a hyphen —
 * hyphens read as dashes in a column of numbers.
 */
export function formatSigned(amount: number): string {
  return amount < 0 ? `\u2212${formatRounded(Math.abs(amount))}` : formatRounded(amount);
}
