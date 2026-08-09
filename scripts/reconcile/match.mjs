#!/usr/bin/env node
/**
 * Match every bank debit against a ledger expense.
 *
 * The important direction is "bank debit with no ledger entry" — that is real
 * money that left the account and was never recorded. The reverse (ledger row
 * with no bank debit) is often legitimate: purchases someone paid out of pocket
 * and was reimbursed by cheque, or a processor fee netted out of a deposit.
 *
 * Matching is by amount within the statement period, then reported with
 * descriptions so a wrong pairing is visible. Fuel and food repeat the same
 * round numbers constantly, so treat an amount match as a hint, not proof.
 */

import { db, loadStatement, fetchExpenses, money, cents } from './lib.mjs';

const stmt = loadStatement(process.argv);
const client = db();

// Statement dates are MM/DD; widen to the period the ledger should cover.
const period = stmt.period ?? '';
const [year, month] = period.split('-');
const from = stmt.from ?? (year && month ? `${year}-${month}-01` : undefined);
const to = stmt.to ?? (year && month ? `${year}-${month}-31` : undefined);

const ledgerAll = await fetchExpenses(client, { from, to });

// Rows the statement explains as a lump sum are handled separately: a
// reimbursement cheque covers many ledger rows, and payroll is not in
// finance_entries at all.
const reimbursed = ledgerAll.filter((r) => /reimbursed via/i.test(r.desc));
const payrollOverhead = ledgerAll.filter((r) =>
  /employer payroll taxes|office\/admin hours/i.test(r.desc),
);
const skip = new Set([...reimbursed, ...payrollOverhead].map((r) => r.id));
const ledger = ledgerAll
  .filter((r) => !skip.has(r.id))
  .map((r) => ({ ...r, matched: false }));

const bank = stmt.debits
  .filter((d) => {
    const a = cents(d.amount);
    if (stmt.payrollRuns.some((p) => cents(p.total) === a)) return false;
    if (stmt.reimbursementChecks.some((c) => cents(c.amount) === a)) return false;
    return true;
  })
  .map((d) => ({ ...d, amount: cents(d.amount), matched: false }));

for (const b of bank) {
  const hit = ledger.find((l) => !l.matched && l.amount === b.amount);
  if (hit) {
    hit.matched = true;
    b.matched = true;
    b.pairedWith = hit;
  }
}

const sum = (a) => a.reduce((s, x) => s + x.amount, 0);
console.log(`Period ${period || '(unspecified)'}\n`);
console.log(`  bank debits (ordinary)   ${String(bank.length).padStart(3)}  ${money(sum(bank))}`);
console.log(`  ledger expenses          ${String(ledger.length).padStart(3)}  ${money(sum(ledger))}`);
console.log(`  reimbursed via cheque    ${String(reimbursed.length).padStart(3)}  ${money(sum(reimbursed))}`);
console.log(`  payroll overhead         ${String(payrollOverhead.length).padStart(3)}  ${money(sum(payrollOverhead))}\n`);

const missing = bank.filter((b) => !b.matched).sort((a, b) => b.amount - a.amount);
console.log(`BANK DEBIT, NOT IN LEDGER (${missing.length}) — ${money(sum(missing))}`);
if (!missing.length) console.log('  none — every debit is recorded.');
for (const b of missing) console.log(`  ${b.date}  ${money(b.amount).padStart(12)}  ${b.desc}`);

const ghosts = ledger.filter((l) => !l.matched).sort((a, b) => b.amount - a.amount);
console.log(`\nLEDGER ROW, NO BANK DEBIT (${ghosts.length}) — ${money(sum(ghosts))}`);
if (!ghosts.length) console.log('  none.');
for (const g of ghosts) {
  console.log(`  ${g.date}  ${money(g.amount).padStart(12)}  ${g.job.padEnd(11)} ${g.desc.slice(0, 54)}`);
}
if (ghosts.length) {
  console.log('\n  Expected here: out-of-pocket purchases awaiting reimbursement, and');
  console.log('  processor fees netted out of a deposit rather than debited.');
}

// Payroll cross-check: gross + business taxes must equal the debit.
if (stmt.payrollRuns.length) {
  console.log('\nPAYROLL RUNS');
  for (const p of stmt.payrollRuns) {
    const derived = cents(p.gross + p.businessTaxes);
    const flag = derived === cents(p.total) ? 'ok' : `MISMATCH (table ${money(derived)})`;
    console.log(`  ${p.date}  gross ${money(p.gross).padStart(11)} + taxes ${money(p.businessTaxes).padStart(9)} = ${money(p.total).padStart(11)}  ${flag}`);
  }
}

process.exit(missing.length ? 1 : 0);
