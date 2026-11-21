/**
 * Read every row of a query, past the API's 1,000-row cap (2026-11-21).
 *
 * PostgREST answers at most `max_rows` (1,000 on this project) rows per request and says
 * nothing when it stops — a total built from a capped read is silently low. finance_entries
 * passed 560 rows in November; hours and the ledger feed company-wide totals (hours worked,
 * profit, company value), so those reads page through `range()` here instead.
 *
 * `build` must return a FRESH query each call (a builder can only be awaited once). Rows are
 * ordered by `id` so pages never overlap or skip.
 */
const PAGE = 1000;

type Page<T> = PromiseLike<{ data: T[] | null; error: unknown }>;
type Ranged<T> = { order: (col: string) => { range: (from: number, to: number) => Page<T> } };

export async function allRows<T>(build: () => Ranged<T>): Promise<{ data: T[] | null; error: unknown }> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().order('id').range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return { data: out, error: null };
  }
}
