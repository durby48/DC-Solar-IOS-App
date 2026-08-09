# Monthly bank reconciliation

Proves the ledger matches the bank account, penny for penny.

> **This repository is public.** No statement, balance, amount, or person's name
> may be committed here. The scripts take a statement file as an argument and
> read it from outside the repo; `statements/` is gitignored as a backstop.
> Keep statements in `~/Desktop/DC Solar LLC/secrets/statements/`.

## What it does

Three checks, each answering a different question:

| Script | Question |
|---|---|
| `duplicates.mjs` | Has the same expense been entered twice? |
| `match.mjs` | Does every bank debit have a ledger entry, and vice versa? |
| `bridge.mjs` | Does profit + capital + what's owed equal the bank balance? |

Run them in that order. Duplicates first, because they corrupt the other two.

## Monthly workflow

1. Download the statement PDF from Chase.
2. Convert it to the JSON shape below (see `statement.example.json`), saving it
   outside this repo.
3. Run:

```bash
node scripts/reconcile/duplicates.mjs
node scripts/reconcile/match.mjs ~/Desktop/"DC Solar LLC"/secrets/statements/2026-08.json
node scripts/reconcile/bridge.mjs ~/Desktop/"DC Solar LLC"/secrets/statements/2026-08.json
```

4. Fix what they report, then re-run until `match` shows nothing missing on the
   bank side and `bridge` reports zero unexplained.

## Statement JSON

```json
{
  "period": "2026-08",
  "openingBalance": 34198.56,
  "closingBalance": 42867.06,
  "debits":  [{ "date": "08/07", "amount": 9868.04, "desc": "Check 8089" }],
  "credits": [{ "date": "08/04", "amount": 12110.00, "desc": "Cromwell ACH" }],
  "payrollRuns": [
    { "date": "2026-08-07", "gross": 6811.00, "businessTaxes": 723.74, "total": 7532.68 }
  ],
  "reimbursementChecks": [
    { "date": "2026-08-07", "amount": 9868.04, "desc": "Check 8089 — Isaiah" }
  ]
}
```

`payrollRuns` come from the Chase Payroll **Business payments** tab.
`reimbursementChecks` are cheques that pay back already-booked expenses — they
must never be entered as new expenses.

## Rules the hard way

Each of these cost real time to find:

- **Payroll lives in exactly one place.** Gross wages in `employee_hours`
  (per job); employer taxes and unlogged admin time as company overhead. Booking
  payroll in `finance_entries` double-counts it against the per-job P&L.
- **The bank feed already imports card transactions.** Always check for an
  existing row before inserting — same date and amount, and also whether the new
  amount equals the sum of two existing rows. `duplicates.mjs` checks both.
- **Reimbursement cheques are not expenses.** They settle expenses already in
  the ledger. Tag the items instead.
- **Capital is not revenue.** An owner contribution is `type='investment'`,
  `direction='in'`; money taken back out is the same type with `direction='out'`.
  Net them or the capital figure double-reports.
- **Match by amount, then verify by description.** Fuel and food repeat the same
  round numbers constantly, so a bare amount match pairs the wrong rows.
