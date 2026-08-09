#!/usr/bin/env node
/**
 * Find expenses entered twice.
 *
 * Run this BEFORE match.mjs — duplicates corrupt every downstream figure.
 *
 * Two shapes, both of which happened for real:
 *
 *   1. Exact: same date, same amount, entered once by the bank feed and again
 *      by hand. The bank feed already imports card transactions, so any manual
 *      insert risks this.
 *   2. Split: one row equal to the sum of two others on the same day — a single
 *      "fuel" row that was really two separate charges already present. This
 *      one is invisible to an amount match against the bank, because the
 *      combined figure never appears on the statement.
 *
 * Reports only. Deleting is a judgement call — check which row has the better
 * job attribution before removing the other.
 */

import { db, fetchExpenses, money, cents, COMPANY } from './lib.mjs';

const client = db();
const rows = await fetchExpenses(client);
console.log(`Scanning ${rows.length} expense rows for ${COMPANY}\n`);

let findings = 0;

// --- 1. exact duplicates: same date + same amount -------------------------
const byKey = new Map();
for (const r of rows) {
  const key = `${r.date}|${r.amount}`;
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key).push(r);
}
const exact = [...byKey.values()].filter((g) => g.length > 1);
if (exact.length) {
  console.log(`EXACT DUPLICATES — same date and amount (${exact.length})`);
  for (const group of exact) {
    console.log(`  ${group[0].date}  ${money(group[0].amount)}`);
    for (const r of group) console.log(`      ${r.job.padEnd(11)} ${r.desc.slice(0, 62)}`);
    findings += 1;
  }
  console.log();
}

// --- 2. split duplicates: one row == two others, same day -----------------
const byDate = new Map();
for (const r of rows) {
  if (!byDate.has(r.date)) byDate.set(r.date, []);
  byDate.get(r.date).push(r);
}
const splits = [];
for (const [date, day] of byDate) {
  if (day.length < 3) continue;
  for (const candidate of day) {
    for (let i = 0; i < day.length; i++) {
      for (let j = i + 1; j < day.length; j++) {
        const a = day[i];
        const b = day[j];
        if (a.id === candidate.id || b.id === candidate.id) continue;
        if (cents(a.amount + b.amount) !== candidate.amount) continue;
        splits.push({ date, candidate, parts: [a, b] });
      }
    }
  }
}
if (splits.length) {
  console.log(`POSSIBLE SPLIT DUPLICATES — one row equals two others (${splits.length})`);
  for (const s of splits) {
    console.log(`  ${s.date}  ${money(s.candidate.amount)}  ${s.candidate.job.padEnd(11)} ${s.candidate.desc.slice(0, 50)}`);
    for (const p of s.parts) {
      console.log(`      = ${money(p.amount).padStart(10)}  ${p.job.padEnd(11)} ${p.desc.slice(0, 50)}`);
    }
    findings += 1;
  }
  console.log();
}

// --- 3. payroll must not be in finance_entries ----------------------------
const payrollRows = rows.filter(
  (r) =>
    /payroll/i.test(r.desc) &&
    !/employer payroll taxes|office\/admin hours|payroll fee/i.test(r.desc),
);
if (payrollRows.length) {
  console.log(`PAYROLL BOOKED AS AN EXPENSE (${payrollRows.length}) — double-counts employee_hours`);
  for (const r of payrollRows) {
    console.log(`  ${r.date}  ${money(r.amount)}  ${r.job.padEnd(11)} ${r.desc.slice(0, 56)}`);
  }
  findings += payrollRows.length;
  console.log();
}

console.log(findings === 0 ? 'Clean — no duplicates found.' : `${findings} thing(s) to look at.`);
process.exit(findings === 0 ? 0 : 1);
