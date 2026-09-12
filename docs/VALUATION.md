# Company valuation — how the Financials stock chart is computed

The Financials screen opens with a stock-style chart (`components/financials/StockChart.tsx`)
of three daily series since **2026-07-01** — Revenue, Profit and Company Value — built by
`lib/valuation.ts::buildValuationSeries` from rows the screen already fetched. Nothing is
stored: every point is recomputed from `finance_entries`, `payroll_runs`, `jobs`,
`company_settings`, `company_assets` and `company_liabilities` on every load, and the screen
refetches the moment any of those tables changes (`lib/financeRealtime.ts`, realtime
publication added by `supabase/migrations/2026-09-12_company_assets.sql`).

This document is the formulas in words. Amounts never appear here; the app shows them.

## One point per day

Every calendar day from `SERIES_START` (2026-07-01) through today (local device date) gets one
point in each series. All three are **cumulative**: the value on a day is "everything up to and
including that day". A row dated before 2026-07-01 counts in the first point; a row dated in the
future is ignored until its day arrives.

## Revenue

Sum of every `finance_entries` row with `type = 'payment'` and `occurred_on ≤ day`.

- `investment` rows (owner capital) are never revenue.
- `estimate`, `contract` and `invoice` rows are documents, not money received.
- A payment filed on the Company container still counts. The app flags it as a misfiling
  (a deposit the email scanner could not match to a job) but includes it in "Paid in", so the
  chart does too — the money is real, only its job is wrong.
- There is no void/archive status on finance rows; all rows are summed, matching the ledgers.

## Profit

`Revenue − Expenses − Labor`, all cumulative to the day.

- **Expenses** = Σ `type = 'expense'` rows with `occurred_on ≤ day` (bank or out-of-pocket
  alike — an expense is a cost whichever account paid it).
- **Labor** = Σ `payroll_runs.total_withdrawn` for runs with `payday ≤ day` (what actually
  left the bank, taxes included) **plus** the accrued estimate for hours worked after the
  newest paid period end: gross wages (manual `employee_hours` × rate, plus completed clock
  entries × roster rate) × the employer burden multiplier from `lib/laborCost.ts`
  (10.626 % — Social Security, Medicare, FUTA, MO UI, verified against the Gusto receipts).
  On a given historical day the "newest paid period" is the newest run whose payday had
  already arrived, so the accrual grows between paydays and collapses on each payday, the
  same way the bank sees it.

This is the same arithmetic as the Financials "Net" tile; the tile is simply the last point.

## Company value

A standard small-business **book value (net worth)** approach — what the company owns minus
what it owes, with the two things a service business is really made of (cash and signed
work) counted explicitly:

```
Value(day) = Cash + Receivables + Contracted backlog value + Fixed assets − Liabilities
```

### Cash

The Cash Position panel's figure, walked to every day. The anchor is the last bank balance an
admin recorded in `company_settings` (`bank_balance`, `bank_balance_as_of`, `updated_at`).

- Rows recorded **after** the anchor was saved (`created_at` later than it) are applied from
  the day they occurred — the same rule the panel uses to auto-adjust the balance.
- Rows the anchor **already reflects** are undone for days before they occurred, so the line
  before the anchor is the balance with those movements taken back out.
- Only rows that move the bank move cash: payments (in), expenses with `paid_from_bank`
  (out), owner capital (in or out by `direction`), and payroll runs (out on payday; keyed on
  the anchor's as-of date because runs are not finance rows).
- With no balance anchored yet, cash is the running net of every bank flow ever recorded
  (an assumed zero opening balance); the chart says so under the Value line.

### Receivables

Per job in **Pending Payment** or **Complete**: Σ invoice rows − Σ payment rows to the day,
floored at zero, summed. Jobs still in a contracted stage are excluded here — their invoice
rows are contract values, not bills, and they are counted once, below.

### Contracted backlog value

Jobs in the contracted stages (`CONTRACTED_STAGES` in `lib/pipeline.ts`: Pending Removal,
Reinstall, Install, Permit): Σ their invoice-type rows to the day × the company's realised
average margin, floored at zero. The margin is the Pipeline's "Avg Profit" — the mean of
(paid − expenses − labor) / paid over Complete jobs with payments — so the backlog is worth
what history says a signed job actually earns, not its face value. With no completed jobs
yet, the backlog is worth zero.

### Fixed assets (book value)

Every `company_assets` row: straight-line depreciation to the day.

```
book(day) = max(cost − (cost − salvage) × min(1, days owned / (useful life × 365.25)), salvage)
```

Zero before the purchase date and from the disposal date on. Defaults: useful life 5 years
for tools/equipment/other, 7 for vehicles (`DEFAULT_LIFE_YEARS` in `lib/valuation.ts`);
salvage 0. The owner enters these in the "Company assets & liabilities" section at the
bottom of Financials.

### Liabilities

Every `company_liabilities` row at its recorded `balance`, subtracted at face value on every
day of the series. The balance is a snapshot the owner keeps current (there is no
amortisation schedule — `monthly_payment` is informational); update the balance and the line
moves.

## What is NOT included, on purpose

- **Goodwill / brand / customer list** — no market multiple is applied. This is book value,
  not a sale price; a buyer might pay more (or less).
- **Owner labor** — unpaid owner time is not a cost here, and is not capitalised either.
- **Inventory** — bulk materials are expensed when bought; unused stock is not added back.
- **Estimates and unsigned contracts** — the funnel earns nothing until it is signed.
- **Taxes owed, accrued interest, deposits held for customers** — not modelled.
- **Stage history** — receivables and backlog use each job's stage **as of today** for every
  day of the series (`job_stage_history` exists, but the chart does not replay it).

## Changing the assumptions

| Assumption | Where |
|---|---|
| Series start date | `SERIES_START` in `lib/valuation.ts` |
| Employer payroll burden | `EMPLOYER_COST_MULTIPLIER` in `lib/laborCost.ts` |
| Default useful lives | `DEFAULT_LIFE_YEARS` in `lib/valuation.ts` |
| Which stages are "contracted" | `CONTRACTED_STAGES` in `lib/pipeline.ts` |
| Backlog margin | the Pipeline's Avg Profit (`fetchCompanyTotals`) — change the formula there |
| Which rows move the bank | `bankFlow()` in `lib/valuation.ts` (mirrors the Cash Position panel) |
| Liability treatment | `liabilityBalance()` in `lib/valuation.ts` |
| Points drawn / ranges | `MAX_POINTS`, `RANGE_DAYS` in `components/financials/StockChart.tsx` |

## Security

`company_assets` and `company_liabilities` are admin-only on select/insert/update/delete via
`is_company_admin(company)`; the realtime change feed honours the same RLS. Prove it by
impersonation (rolled back) — the probe is in the migration's trailing comment.
