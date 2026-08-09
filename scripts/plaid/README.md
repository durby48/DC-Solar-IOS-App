# Plaid → Chase

Pulls the balance and transactions straight from the bank, replacing the
download-a-PDF-and-retype-it step in `scripts/reconcile/`.

> **This repository is public.** Plaid keys and the access token live in
> `~/Desktop/DC Solar LLC/secrets/` and must never be copied here. The access
> token reads a real bank account.

## Setup, once

1. Get your keys from <https://dashboard.plaid.com/developers/keys>.
2. Create `~/Desktop/DC Solar LLC/secrets/plaid.txt`:

```
PLAID_CLIENT_ID=...
PLAID_SECRET=...
PLAID_ENV=sandbox
```

Use the **Sandbox** secret with `PLAID_ENV=sandbox`, or the **Production**
secret with `PLAID_ENV=production`. They are different values.

3. Link the account:

```bash
node scripts/plaid/link.mjs
```

That opens a page and waits. You sign in to Chase on Chase's own page — the
credentials go to Chase, not to this tool. Plaid returns a token, which is
saved to `secrets/plaid-access-token.txt`.

## Every month

```bash
node scripts/plaid/sync.mjs
```

Writes `secrets/statements/YYYY-MM.json` and updates the bank balance the
Cash Position panel reads. Then run the three reconcile scripts it prints.

## Chase specifics

Chase uses OAuth, so:

- **Sandbox will not accept a real Chase login.** It simulates one with
  `user_good` / `pass_good`. Useful for proving the pipeline works end to end,
  useless for real figures.
- **Real Chase data needs Production access**, which Plaid grants on request
  from the dashboard. Expect a short company questionnaire.
- Production also needs `http://localhost:8712/oauth` registered under
  Team Settings → API → Allowed redirect URIs, or the Chase handoff fails.

## What it cannot do

`payrollRuns` stays empty. Plaid sees one lump payroll debit and cannot split
gross wages from employer taxes — that comes from the Chase Payroll *Business
payments* tab and still gets entered by hand. It is two numbers a fortnight.

Likewise `reimbursementChecks`: only you know a cheque paid back expenses
already in the ledger rather than buying something new.
