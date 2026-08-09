#!/usr/bin/env node
/**
 * Bridge the ledger to the bank balance.
 *
 * Profit and cash are different questions, and the gap between them should be
 * explainable line by line rather than shrugged at. Anything left over is a
 * genuine unknown — chase it.
 *
 *   profit
 *     + capital contributed        money in that is not income
 *     − capital returned           money out that is not a cost
 *     + labor accrued, unpaid      cost booked, wages not yet run
 *     + owed for out-of-pocket     cost booked, nobody reimbursed yet
 *     ± cash-only movement         revenue or draws that bypassed the bank
 *     = bank balance
 */

import { db, loadStatement, fetchTotals, fetchExpenses, money, cents } from './lib.mjs';

const stmt = loadStatement(process.argv);
if (typeof stmt.closingBalance !== 'number') {
  console.error('\nStatement needs a numeric "closingBalance".\n');
  process.exit(1);
}

const client = db();
const t = await fetchTotals(client);

// Wages already worked but not yet through a payroll run.
const lastPayroll = stmt.payrollThrough ?? stmt.lastPayrollPeriodEnd ?? null;
const laborAll = t.hours.reduce((s, h) => s + Number(h.hours) * Number(h.rate), 0);
const laborUnpaid = lastPayroll
  ? t.hours
      .filter((h) => h.occurred_on > lastPayroll)
      .reduce((s, h) => s + Number(h.hours) * Number(h.rate), 0)
  : 0;

// Booked, paid by a person, and the money is still in the account — either
// nobody has been paid back yet, or the reimbursement is in flight and has not
// cleared. Both keep cash in the bank that the ledger has already expensed;
// only a CLEARED reimbursement removes it.
const expenses = await fetchExpenses(client);
const owed = expenses
  .filter((r) => /NOT yet reimbursed|not yet cleared/i.test(r.desc))
  .reduce((s, r) => s + r.amount, 0);

const profit = t.payments - t.expenses - laborAll;
const cashOnly = Number(stmt.cashOnlyAdjustment ?? 0);
const opening = Number(stmt.preLedgerCash ?? 0);

const implied = cents(
  profit + t.capitalIn - t.capitalOut + laborUnpaid + owed + cashOnly + opening,
);
const actual = cents(stmt.closingBalance);
const gap = cents(actual - implied);

const line = (label, value) =>
  console.log(`  ${label.padEnd(38)}${money(value).padStart(13)}`);

console.log('\nPROFIT');
line('payments collected', t.payments);
line('expenses booked', -t.expenses);
line('labor (all, incl. unpaid)', -laborAll);
line('TRUE PROFIT', profit);

console.log('\nPROFIT → CASH');
line('true profit', profit);
line('+ capital contributed', t.capitalIn);
if (t.capitalOut) line('− capital returned to owners', -t.capitalOut);
if (laborUnpaid) line('+ labor accrued, not yet paid', laborUnpaid);
if (owed) line('+ owed for out-of-pocket purchases', owed);
if (cashOnly) line('± cash that bypassed the bank', cashOnly);
if (opening) line('+ cash predating the ledger', opening);
console.log(`  ${'-'.repeat(51)}`);
line('LEDGER-IMPLIED BALANCE', implied);
line('ACTUAL BANK BALANCE', actual);
line('UNEXPLAINED', gap);

if (Math.abs(gap) < 0.005) {
  console.log('\nReconciled — every penny accounted for.\n');
  process.exit(0);
}
console.log(
  '\nNot reconciled. Usual suspects, in the order worth checking:\n' +
    '  1. duplicates.mjs — a double entry moves this by its full amount\n' +
    '  2. match.mjs — a bank debit never recorded\n' +
    '  3. out-of-pocket purchases missing the "NOT yet reimbursed" tag\n' +
    '  4. cash revenue or an owner draw that never touched the account\n',
);
process.exit(1);
