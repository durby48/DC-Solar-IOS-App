// App → QuickBooks one-time import (2026-10-14). Books start 2026-06-26.
//
//   node scripts/qbo/import.mjs            → PRACTICE RUN: builds every QuickBooks
//                                            transaction from the app and checks it;
//                                            writes nothing; prints a report and saves
//                                            the plan to scripts/qbo/out/plan.json
//   node scripts/qbo/import.mjs --apply    → (later) creates them
//
// Shape of the books (agreed with Devon 2026-10-14):
//   * customers → QBO customers; each job → a project (sub-customer) under its customer
//   * money that touched Chase is grouped by `extracted.bank_ref` → ONE QuickBooks
//     transaction per bank line, so the bank feed only has to "Match":
//       money out → Purchase (Check when the bank line is a check), one line per app row
//       money in  → each customer payment recorded against its job's invoice into
//                   Undeposited Funds, then one Deposit per bank line that links them
//                   (plus fee / owner-investment lines)
//   * expenses Isaiah paid himself and has not been repaid → Journal entry to
//     "Due to Isaiah Nettleton"
//   * each Gusto run → Journal entry on payday: wages split to jobs by the hours
//     worked in the pay period (Job labor), the rest to Office & overhead wages,
//     employer taxes = withdrawn − gross, credit Chase
//   * invoices are created for jobs that are billed (a payment exists, or the job is
//     Pending Payment / Complete)
//   * every row's account is `extracted.book_account` (app lib/books.ts BOOK_ACCOUNTS)

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { query, sql } from './qbo.mjs';

const START = '2026-06-26';
const STATEMENT_CHECK = { date: '2026-09-30', balance: 11633.35, opening: 2029.0 };
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out');

// app book_account → QuickBooks account (FullyQualifiedName). Mirror of lib/books.ts.
const BOOK_QBO = {
  job_materials: 'Job materials', job_fuel: 'Job fuel & travel', subcontractors: 'Subcontractors',
  job_equipment_rental: 'Job equipment rental', permits: 'Permits & fees', commissions: 'Commissions & fees',
  fuel: 'Vehicle expenses:Fuel', vehicle_repairs: 'Vehicle expenses:Vehicle repairs & maintenance',
  registration: 'Vehicle expenses:Registration & title', tools: 'Tools & small equipment', supplies: 'Supplies',
  insurance: 'Insurance', software_phone: 'Software & phone', bank_fees: 'Bank & card fees', meals: 'Meals',
  advertising: 'Advertising & marketing', office: 'Office expenses', legal_professional: 'Legal & professional services',
  contract_labor: 'Contract labor', equipment_rental: 'Equipment rental', taxes_licenses: 'Taxes & licenses (non-payroll)',
  rent: 'Building & land rent', utilities: 'Utilities', travel: 'Travel', other: 'Other operating expenses',
  vehicle_purchase: 'Vehicles', equipment_purchase: 'General equipment', owner_draw: 'Owner draws',
  uncategorized: 'Uncategorized Expense',
};
const ACCT = {
  bank: 'BUS COMPLETE CHK (7086)', cash: 'Cash', undeposited: 'Undeposited funds',
  ownerInv: 'Owner investments', ownerDraw: 'Owner draws', dueIsaiah: 'Due to Isaiah Nettleton',
  jobLabor: 'Job labor', officeWages: 'Payroll expenses:Office & overhead wages',
  payrollTaxes: 'Payroll expenses:Payroll taxes (employer)',
};
const INCOME_ITEMS = {
  rr: { name: 'Removal & reinstall', account: 'Removal & reinstall (R&R)' },
  install: { name: 'Installation', account: 'Installation' },
  critter: { name: 'Critter guard & add-ons', account: 'Critter guard & add-ons' },
  service: { name: 'Service plan or visit', account: 'Service plans & visits' },
};

const money = (n) => Math.round(Number(n) * 100) / 100;
const fmt = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ext = (r) => (typeof r.extracted === 'string' ? JSON.parse(r.extracted) : r.extracted) ?? {};

// --------------------------------------------------------------------------- load
const [customers, jobs, entries, runs, empHours, clocks, employees] = await Promise.all([
  sql(`select id, name, email, phone, address from public.customers where company = 'dc-solar'`),
  sql(`select id, job_number, name, customer_id, stage, job_type, is_internal, address from public.jobs where company = 'dc-solar'`),
  sql(`select * from public.finance_entries where company = 'dc-solar' and status <> 'void'`),
  sql(`select * from public.payroll_runs where company = 'dc-solar' order by payday`),
  sql(`select employee, email, job_id, occurred_on, hours, rate from public.employee_hours where company = 'dc-solar'`),
  sql(`select employee, job_id, clock_in, clock_out from public.time_entries where company = 'dc-solar' and clock_out is not null`),
  sql(`select email, display_name, pay_rate, is_test from public.employees where company = 'dc-solar'`),
]);
const qboAccounts = await query('select * from Account');
const accountByName = new Map(qboAccounts.map((a) => [a.FullyQualifiedName, a]));
const jobById = new Map(jobs.map((j) => [j.id, j]));
const custById = new Map(customers.map((c) => [c.id, c]));
const warnings = [];
const warn = (m) => warnings.push(m);

for (const name of [...Object.values(BOOK_QBO), ...Object.values(ACCT), ...Object.values(INCOME_ITEMS).map((i) => i.account)]) {
  if (!accountByName.has(name)) warn(`QuickBooks account missing: "${name}"`);
}

const inBooks = (r) => r.occurred_on >= START;
const isOnJob = (jobId) => !!jobId && jobById.get(jobId) && !jobById.get(jobId).is_internal;
const projectName = (j) => `${j.job_number ?? ''} ${j.name ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, 100);
const incomeKind = (j) => {
  const t = `${j.job_type ?? ''} ${j.name ?? ''}`.toLowerCase();
  if (/critter/.test(t)) return 'critter';
  if (/clean|inspection|service/.test(t)) return 'service';
  if (/r&r|reinstall|removal/.test(t)) return 'rr';
  return 'install';
};

// --------------------------------------------------------------------------- customers + projects
const usedJobIds = new Set(entries.filter((e) => inBooks(e) && isOnJob(e.job_id)).map((e) => e.job_id));
for (const h of empHours) if (h.occurred_on >= '2026-06-18' && isOnJob(h.job_id)) usedJobIds.add(h.job_id);
const projects = [...usedJobIds].map((id) => jobById.get(id)).sort((a, b) => (a.job_number ?? '').localeCompare(b.job_number ?? ''));
const neededCustomers = new Set(projects.map((j) => j.customer_id).filter(Boolean));
for (const e of entries) if (inBooks(e) && e.customer_id && !e.job_id) neededCustomers.add(e.customer_id);
for (const j of projects) if (!j.customer_id) warn(`Job ${j.job_number} has no customer — its project needs a parent customer`);

// --------------------------------------------------------------------------- invoices
const invoiceByJob = new Map();
for (const e of entries) {
  if (e.type !== 'invoice' || /-Contract$/i.test(e.document_number ?? '')) continue;
  const cur = invoiceByJob.get(e.job_id);
  if (!cur || e.occurred_on > cur.occurred_on || (e.occurred_on === cur.occurred_on && e.created_at > cur.created_at)) invoiceByJob.set(e.job_id, e);
}
const paymentsByJob = new Map();
for (const e of entries) if (e.type === 'payment' && inBooks(e) && e.job_id) paymentsByJob.set(e.job_id, [...(paymentsByJob.get(e.job_id) ?? []), e]);

const invoices = [];
const salesReceiptJobs = new Set();
const unbilled = [];
for (const j of projects) {
  const inv = invoiceByJob.get(j.id);
  const pays = paymentsByJob.get(j.id) ?? [];
  const billed = pays.length > 0 || ['Pending Payment', 'Complete'].includes(j.stage);
  if (!inv) {
    if (pays.length) salesReceiptJobs.add(j.id);
    continue;
  }
  if (!billed) {
    unbilled.push({ job: j.job_number, stage: j.stage, amount: money(inv.amount) });
    continue;
  }
  const firstPay = pays.map((p) => p.occurred_on).sort()[0];
  const date = [inv.occurred_on, firstPay].filter(Boolean).sort()[0];
  const kind = incomeKind(j);
  const items = Array.isArray(inv.line_items) ? inv.line_items : [];
  let lines = items.map((li) => ({ description: li.name, qty: Number(li.qty) || 1, rate: Number(li.rate) || 0, amount: money((Number(li.qty) || 1) * (Number(li.rate) || 0)) }));
  if (!lines.length || Math.abs(lines.reduce((s, l) => s + l.amount, 0) - Number(inv.amount)) > 0.005) {
    lines = [{ description: j.name, qty: 1, rate: money(inv.amount), amount: money(inv.amount) }];
  }
  invoices.push({ appId: inv.id, jobId: j.id, job: j.job_number, docNumber: j.job_number, date: date < START ? START : date, item: kind, lines, total: money(inv.amount) });
  const paid = money(pays.reduce((s, p) => s + Number(p.amount), 0));
  if (Math.abs(paid - money(inv.amount)) > 0.005 && paid > 0) warn(`${j.job_number}: invoice ${fmt(money(inv.amount))} but ${fmt(paid)} received`);
}
const invoiceForJob = new Map(invoices.map((i) => [i.jobId, i]));

// --------------------------------------------------------------------------- bank groups
const bankRows = entries.filter((e) => inBooks(e) && e.paid_from_bank && ['expense', 'payment', 'investment'].includes(e.type));
const groups = new Map();
for (const e of bankRows) {
  const ref = ext(e).bank_ref ?? `row:${e.id}`;
  groups.set(ref, [...(groups.get(ref) ?? []), e]);
}
const bankDateOf = (ref, rows) => (/^\d{4}-\d{2}-\d{2}\|/.test(ref) ? ref.slice(0, 10) : rows.map((r) => r.occurred_on).sort()[0]);
const signed = (e) => (e.direction === 'in' ? 1 : -1) * money(e.amount);

const purchases = [];
const receivePayments = [];
const salesReceipts = [];
const deposits = [];
for (const [ref, rows] of groups) {
  const date = bankDateOf(ref, rows);
  const net = money(rows.reduce((s, r) => s + signed(r), 0));
  const hasIn = rows.some((r) => r.direction === 'in');
  const lineFor = (r) => {
    const x = ext(r);
    const key = r.type === 'investment' ? (r.direction === 'in' ? 'owner_investment' : 'owner_draw') : (x.book_account ?? 'uncategorized');
    if (r.type === 'expense' && !x.book_account) warn(`expense ${r.id} (${r.occurred_on} ${fmt(money(r.amount))}) has no book_account`);
    return {
      appId: r.id,
      account: key === 'owner_investment' ? ACCT.ownerInv : BOOK_QBO[key] ?? 'Uncategorized Expense',
      project: isOnJob(r.job_id) ? jobById.get(r.job_id).job_number : null,
      description: (x.bank_desc ? `${x.bank_desc} — ` : '') + (r.description ?? r.counterparty ?? ''),
      amount: money(r.amount),
      direction: r.direction,
    };
  };
  if (!hasIn) {
    const check = ref.match(/CHECK (\d+)/i)?.[1];
    purchases.push({ ref, date, paymentType: check ? 'Check' : 'Cash', docNumber: check ?? null, total: -net, lines: rows.map(lineFor) });
    continue;
  }
  // money in: payments go through Undeposited Funds, everything else is a deposit line
  const linked = [];
  const other = [];
  for (const r of rows) {
    if (r.type === 'payment') {
      const inv = r.job_id ? invoiceForJob.get(r.job_id) : null;
      if (inv) {
        const rp = { appId: r.id, date: r.occurred_on < START ? START : r.occurred_on, job: inv.job, invoiceApp: inv.appId, amount: money(r.amount) };
        receivePayments.push(rp);
        linked.push({ kind: 'payment', appId: r.id, amount: rp.amount });
      } else {
        const who = r.job_id ? jobById.get(r.job_id)?.job_number : custById.get(r.customer_id)?.name;
        const item = r.job_id ? incomeKind(jobById.get(r.job_id)) : 'service';
        salesReceipts.push({ appId: r.id, date: r.occurred_on, who, jobId: r.job_id, customerId: r.customer_id, item, amount: money(r.amount), description: r.description });
        linked.push({ kind: 'salesReceipt', appId: r.id, amount: money(r.amount) });
        if (r.job_id && !salesReceiptJobs.has(r.job_id)) warn(`payment ${r.id} on ${who}: job has an invoice that is not being created — sales receipt used`);
      }
    } else {
      other.push(lineFor(r));
    }
  }
  const total = money(linked.reduce((s, l) => s + l.amount, 0) + other.reduce((s, l) => s + (l.direction === 'in' ? l.amount : -l.amount), 0));
  if (Math.abs(total - net) > 0.005) warn(`deposit ${ref}: lines ${fmt(total)} ≠ group ${fmt(net)}`);
  deposits.push({ ref, date, total, linked, other });
}

// Bank-only pairs with no app rows: four 7/09 payroll direct deposits bounced back and
// were re-paid by Venmo on 7/13 (same amounts). Wages net to zero.
const BOUNCED = [332.46, 304.75, 249.34, 213.33];
for (const a of BOUNCED) {
  deposits.push({ ref: `bank-only:2026-07-09 payroll return ${a}`, date: '2026-07-09', total: a, linked: [],
    other: [{ account: ACCT.officeWages, amount: a, direction: 'in', description: 'Returned payroll direct deposit (Gusto 7/10 run)' }] });
  purchases.push({ ref: `bank-only:2026-07-13 venmo ${a}`, date: '2026-07-13', paymentType: 'Cash', docNumber: null, total: a,
    lines: [{ account: ACCT.officeWages, amount: a, project: null, description: 'Venmo re-payment of a returned payroll direct deposit' }] });
}

// --------------------------------------------------------------------------- not from the bank
const journals = [];
const cashMoves = [];
for (const e of entries.filter((r) => inBooks(r) && !r.paid_from_bank)) {
  const x = ext(e);
  if (e.type === 'expense' && /isaiah|inettleton/i.test(`${e.description} ${e.counterparty}`)) {
    journals.push({ kind: 'isaiah', appId: e.id, date: e.occurred_on, lines: [
      { posting: 'Debit', account: BOOK_QBO[x.book_account ?? 'uncategorized'], amount: money(e.amount), project: isOnJob(e.job_id) ? jobById.get(e.job_id).job_number : null, description: e.description },
      { posting: 'Credit', account: ACCT.dueIsaiah, amount: money(e.amount), description: 'Owed to Isaiah (paid out of pocket)' },
    ] });
  } else if (e.type === 'payment') {
    const inv = invoiceForJob.get(e.job_id);
    receivePayments.push({ appId: e.id, date: e.occurred_on, job: inv?.job ?? jobById.get(e.job_id)?.job_number, invoiceApp: inv?.appId, amount: money(e.amount), depositTo: ACCT.cash });
    if (!inv) warn(`cash payment ${e.id} has no invoice to apply to`);
  } else if (e.type === 'investment' && e.direction === 'out') {
    cashMoves.push({ appId: e.id, date: e.occurred_on, from: ACCT.cash, account: ACCT.ownerDraw, amount: money(e.amount), description: e.description });
  } else {
    warn(`not-from-bank ${e.type} ${e.id} (${e.occurred_on} ${fmt(money(e.amount))}) has no rule: ${e.description}`);
  }
}

// --------------------------------------------------------------------------- payroll
const rateOf = new Map(employees.map((e) => [e.email?.toLowerCase(), Number(e.pay_rate) || 0]));
const nameToEmail = new Map(employees.map((e) => [e.display_name?.toLowerCase(), e.email?.toLowerCase()]));
const localDay = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const labor = []; // {email, jobId, day, hours, cost}
for (const h of empHours) {
  const email = (h.email ?? h.employee ?? '').toLowerCase();
  labor.push({ email, jobId: h.job_id, day: h.occurred_on, hours: Number(h.hours) || 0, cost: (Number(h.hours) || 0) * (Number(h.rate) || rateOf.get(email) || 0) });
}
for (const c of clocks) {
  const email = (c.employee ?? '').toLowerCase();
  const hours = Math.max(0, (new Date(c.clock_out) - new Date(c.clock_in)) / 3_600_000);
  labor.push({ email, jobId: c.job_id, day: localDay(c.clock_in), hours, cost: hours * (rateOf.get(email) || 0) });
}
const jobLaborTotals = new Map();
for (const run of runs) {
  if (run.payday < START) continue;
  const gross = money(run.gross_wages);
  const withdrawn = money(run.total_withdrawn);
  const only = run.kind === 'off_cycle' ? nameToEmail.get((run.notes ?? '').match(/for ([A-Z][a-z]+ [A-Z][a-z]+)/)?.[1]?.toLowerCase()) : null;
  const inPeriod = labor.filter((l) => l.day >= run.period_start && l.day <= run.period_end && (!only || l.email === only));
  const totalCost = inPeriod.reduce((s, l) => s + l.cost, 0);
  const byJob = new Map();
  for (const l of inPeriod) if (isOnJob(l.jobId)) byJob.set(l.jobId, (byJob.get(l.jobId) ?? 0) + l.cost);
  const lines = [];
  let allocated = 0;
  if (totalCost > 0) {
    for (const [jobId, cost] of [...byJob.entries()].sort()) {
      const amt = money((gross * cost) / totalCost);
      if (amt <= 0) continue;
      allocated = money(allocated + amt);
      lines.push({ posting: 'Debit', account: ACCT.jobLabor, project: jobById.get(jobId).job_number, amount: amt });
      jobLaborTotals.set(jobId, money((jobLaborTotals.get(jobId) ?? 0) + amt));
    }
  } else {
    warn(`payroll ${run.payday}: no hours found in ${run.period_start}–${run.period_end}; all wages to overhead`);
  }
  if (gross - allocated > 0.004) lines.push({ posting: 'Debit', account: ACCT.officeWages, amount: money(gross - allocated), description: 'Hours not on a job (shop, office, travel)' });
  if (withdrawn - gross > 0.004) lines.push({ posting: 'Debit', account: ACCT.payrollTaxes, amount: money(withdrawn - gross) });
  // Rounding: the job split is rounded per line; true the debits up to the credit on the largest one.
  const drift = money(withdrawn - lines.reduce((s, l) => s + l.amount, 0));
  if (drift !== 0 && lines.length) lines.reduce((a, b) => (b.amount > a.amount ? b : a)).amount = money(lines.reduce((a, b) => (b.amount > a.amount ? b : a)).amount + drift);
  lines.push({ posting: 'Credit', account: ACCT.bank, amount: withdrawn });
  journals.push({ kind: 'payroll', appId: run.id, date: run.payday, receipt: run.receipt_id, gross, withdrawn, lines });
}

// --------------------------------------------------------------------------- checks
const bankEffect = (date) =>
  purchases.filter((p) => p.date <= date).reduce((s, p) => s - p.total, 0) +
  deposits.filter((d) => d.date <= date).reduce((s, d) => s + d.total, 0) +
  journals.filter((j) => j.kind === 'payroll' && j.date <= date).reduce((s, j) => s - j.withdrawn, 0);
const projected = money(STATEMENT_CHECK.opening + bankEffect(STATEMENT_CHECK.date));

for (const j of journals) {
  const dr = money(j.lines.filter((l) => l.posting === 'Debit').reduce((s, l) => s + l.amount, 0));
  const cr = money(j.lines.filter((l) => l.posting === 'Credit').reduce((s, l) => s + l.amount, 0));
  if (Math.abs(dr - cr) > 0.005) warn(`journal ${j.kind} ${j.date} unbalanced: ${dr} vs ${cr}`);
}

// --------------------------------------------------------------------------- per-job report
const perJob = new Map();
const jobRow = (jobId) => {
  if (!perJob.has(jobId)) perJob.set(jobId, { job: jobById.get(jobId).job_number, name: jobById.get(jobId).name, invoiced: 0, received: 0, materials: 0, otherCosts: 0, labor: 0 });
  return perJob.get(jobId);
};
for (const i of invoices) jobRow(i.jobId).invoiced = i.total;
for (const e of entries.filter((r) => inBooks(r) && isOnJob(r.job_id))) {
  if (e.type === 'payment') jobRow(e.job_id).received += money(e.amount);
  if (e.type === 'expense') {
    const key = ext(e).book_account;
    if (key === 'job_materials') jobRow(e.job_id).materials += money(e.amount);
    else jobRow(e.job_id).otherCosts += money(e.amount);
  }
}
for (const [jobId, amt] of jobLaborTotals) jobRow(jobId).labor += amt;
const overhead = new Map();
for (const e of entries.filter((r) => inBooks(r) && r.type === 'expense' && !isOnJob(r.job_id))) {
  const key = ext(e).book_account ?? 'uncategorized';
  overhead.set(key, money((overhead.get(key) ?? 0) + money(e.amount)));
}

// --------------------------------------------------------------------------- output
const plan = { projects: projects.map((j) => ({ job: j.job_number, project: projectName(j), customer: custById.get(j.customer_id)?.name ?? null, income: incomeKind(j) })),
  customers: [...neededCustomers].map((id) => custById.get(id)?.name), invoices, receivePayments, salesReceipts, deposits, purchases, journals, cashMoves, unbilled, warnings };
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'plan.json'), JSON.stringify(plan, null, 1));

console.log('PRACTICE RUN — nothing was written to QuickBooks.\n');
console.log(`Customers ${plan.customers.length} · projects ${projects.length} · invoices ${invoices.length} (${fmt(invoices.reduce((s, i) => s + i.total, 0))})`);
console.log(`Customer payments ${receivePayments.length} · sales receipts ${salesReceipts.length} · bank deposits ${deposits.length}`);
console.log(`Bank purchases/checks ${purchases.length} (${purchases.reduce((s, p) => s + p.lines.length, 0)} lines) · journal entries ${journals.length} (payroll ${journals.filter((j) => j.kind === 'payroll').length}, owed to Isaiah ${journals.filter((j) => j.kind === 'isaiah').length}) · cash moves ${cashMoves.length}`);
console.log(`\nBank check: opening ${fmt(STATEMENT_CHECK.opening)} + everything through ${STATEMENT_CHECK.date} = ${fmt(projected)}  vs statement ${fmt(STATEMENT_CHECK.balance)}  → ${Math.abs(projected - STATEMENT_CHECK.balance) < 0.005 ? 'MATCH' : `OFF BY ${fmt(money(projected - STATEMENT_CHECK.balance))}`}`);
console.log(`Projected Chase balance today (no October statement yet): ${fmt(money(STATEMENT_CHECK.opening + bankEffect('2099-12-31')))}`);

console.log('\nPer job (books start 6/26):');
console.log('  job        invoiced    received   materials  other costs     labor      profit*');
let tot = { invoiced: 0, received: 0, materials: 0, otherCosts: 0, labor: 0 };
for (const r of [...perJob.values()].sort((a, b) => a.job.localeCompare(b.job))) {
  const profit = r.invoiced - r.materials - r.otherCosts - r.labor;
  for (const k of Object.keys(tot)) tot[k] += r[k];
  console.log(`  ${r.job.padEnd(9)} ${fmt(r.invoiced).padStart(11)} ${fmt(r.received).padStart(11)} ${fmt(r.materials).padStart(11)} ${fmt(r.otherCosts).padStart(11)} ${fmt(r.labor).padStart(10)} ${fmt(profit).padStart(11)}`);
}
console.log(`  ${'TOTAL'.padEnd(9)} ${fmt(tot.invoiced).padStart(11)} ${fmt(tot.received).padStart(11)} ${fmt(tot.materials).padStart(11)} ${fmt(tot.otherCosts).padStart(11)} ${fmt(tot.labor).padStart(10)} ${fmt(tot.invoiced - tot.materials - tot.otherCosts - tot.labor).padStart(11)}`);
console.log('  * invoiced − job costs; only billed jobs have an invoice amount.');

console.log('\nOverhead (no job), by account:');
for (const [k, v] of [...overhead.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${(BOOK_QBO[k] ?? k).padEnd(48)} ${fmt(v).padStart(11)}`);
console.log(`  ${'TOTAL'.padEnd(48)} ${fmt([...overhead.values()].reduce((a, b) => a + b, 0)).padStart(11)}`);
const officeW = journals.filter((j) => j.kind === 'payroll').flatMap((j) => j.lines).filter((l) => l.account === ACCT.officeWages).reduce((s, l) => s + l.amount, 0);
const taxes = journals.filter((j) => j.kind === 'payroll').flatMap((j) => j.lines).filter((l) => l.account === ACCT.payrollTaxes).reduce((s, l) => s + l.amount, 0);
console.log(`  + payroll: office & overhead wages ${fmt(money(officeW))}, employer payroll taxes ${fmt(money(taxes))}`);

if (unbilled.length) {
  console.log('\nNot invoiced in QuickBooks yet (work not billed — app invoice is a draft on an unfinished job):');
  for (const u of unbilled) console.log(`  ${u.job.padEnd(9)} ${u.stage.padEnd(18)} ${fmt(u.amount)}`);
}
console.log(`\nWarnings (${warnings.length}):`);
for (const w of warnings) console.log('  - ' + w);
console.log(`\nFull plan: ${join(OUT, 'plan.json')}`);

// =========================================================================== APPLY
if (process.argv.includes('--apply')) {
  if (warnings.length) {
    console.error('\nRefusing to apply with warnings. Fix them first.');
    process.exit(1);
  }
  const { qbo } = await import('./qbo.mjs');
  const lit = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
  const links = new Map(
    (await sql(`select app_kind, app_key, qbo_id from public.qbo_links where company = 'dc-solar'`)).map((l) => [`${l.app_kind}|${l.app_key}`, l.qbo_id]),
  );
  const linked = (kind, key) => links.get(`${kind}|${key}`);
  let created = 0;
  /** Create once: skip when already linked, else POST and record the link. */
  async function ensure(kind, key, entity, body, appIds = []) {
    const have = linked(kind, key);
    if (have) return have;
    const res = await qbo('POST', entity.toLowerCase(), body);
    const obj = res[entity];
    await sql(`insert into public.qbo_links (app_kind, app_key, qbo_type, qbo_id, sync_token, app_ids)
      values (${lit(kind)}, ${lit(key)}, ${lit(entity)}, ${lit(obj.Id)}, ${lit(obj.SyncToken)},
              array[${appIds.filter(Boolean).map((id) => `${lit(id)}::uuid`).join(',')}]::uuid[])
      on conflict (company, app_kind, app_key) do nothing`);
    links.set(`${kind}|${key}`, obj.Id);
    created += 1;
    if (created % 25 === 0) console.log(`  … ${created} created`);
    return obj.Id;
  }
  const acct = (name) => {
    const a = accountByName.get(name);
    if (!a) throw new Error(`QuickBooks account missing: ${name}`);
    return { value: a.Id, name: a.Name };
  };
  const jobByNumber = new Map(jobs.map((j) => [j.job_number, j]));
  const note = (ids) => `DC Solar app import 2026-10-14 · ${ids.filter(Boolean).join(', ')}`.slice(0, 4000);

  console.log('\nAPPLYING to QuickBooks …');

  // Items (one service per income account)
  const itemId = {};
  for (const [kind, it] of Object.entries(INCOME_ITEMS)) {
    const existing = (await query(`select * from Item where Name = '${it.name.replace(/'/g, "\\'")}'`))[0];
    itemId[kind] = existing?.Id ?? (await ensure('item', kind, 'Item', { Name: it.name, Type: 'Service', IncomeAccountRef: acct(it.account) }));
  }

  // Customers (DisplayName must be unique across customers, vendors and employees)
  const custQbo = new Map();
  for (const id of neededCustomers) {
    const c = custById.get(id);
    const body = { DisplayName: c.name.slice(0, 100), CompanyName: c.name.slice(0, 100) };
    if (c.email && /@/.test(c.email)) body.PrimaryEmailAddr = { Address: c.email };
    if (c.phone) body.PrimaryPhone = { FreeFormNumber: c.phone };
    if (c.address) body.BillAddr = { Line1: c.address.slice(0, 500) };
    let qid;
    try {
      qid = await ensure('customer', id, 'Customer', body, [id]);
    } catch (e) {
      if (!/Duplicate Name/i.test(e.message)) throw e;
      qid = await ensure('customer', id, 'Customer', { ...body, DisplayName: `${c.name} (customer)`.slice(0, 100) }, [id]);
    }
    custQbo.set(id, qid);
  }

  // Projects: a sub-customer marked IsProject (falls back to a plain sub-customer)
  const projQbo = new Map();
  let projectMode = null;
  for (const j of projects) {
    const parent = custQbo.get(j.customer_id);
    const base = { DisplayName: projectName(j), Job: true, BillWithParent: false, ParentRef: { value: parent } };
    if (j.address) base.ShipAddr = { Line1: j.address.slice(0, 500) };
    let qid;
    if (projectMode !== 'subcustomer') {
      try {
        qid = await ensure('project', j.id, 'Customer', { ...base, IsProject: true }, [j.id]);
        projectMode = 'project';
      } catch (e) {
        if (projectMode === 'project') throw e;
        console.log(`  projects: IsProject refused (${e.message.slice(0, 120)}) — using sub-customers`);
        projectMode = 'subcustomer';
      }
    }
    if (!qid) qid = await ensure('project', j.id, 'Customer', base, [j.id]);
    projQbo.set(j.id, qid);
  }
  const projectRef = (jobNumber) => (jobNumber ? { value: projQbo.get(jobByNumber.get(jobNumber).id) } : undefined);

  // Invoices
  const invQbo = new Map();
  const invRemaining = new Map();
  for (const inv of invoices) {
    const qid = await ensure('invoice', inv.appId, 'Invoice', {
      CustomerRef: { value: projQbo.get(inv.jobId) },
      TxnDate: inv.date,
      DocNumber: inv.docNumber,
      PrivateNote: note([inv.appId]),
      Line: inv.lines.map((l) => ({
        DetailType: 'SalesItemLineDetail', Amount: l.amount, Description: l.description?.slice(0, 4000),
        SalesItemLineDetail: { ItemRef: { value: itemId[inv.item] }, Qty: l.qty, UnitPrice: l.rate },
      })),
    }, [inv.appId]);
    invQbo.set(inv.appId, qid);
    invRemaining.set(inv.appId, inv.total);
  }

  // Customer payments → Undeposited Funds (or Cash for the cash one)
  const payQbo = new Map();
  for (const p of receivePayments.sort((a, b) => a.date.localeCompare(b.date))) {
    const inv = invoices.find((i) => i.appId === p.invoiceApp);
    const apply = money(Math.min(p.amount, invRemaining.get(p.invoiceApp) ?? 0));
    invRemaining.set(p.invoiceApp, money((invRemaining.get(p.invoiceApp) ?? 0) - apply));
    const qid = await ensure('payment', p.appId, 'Payment', {
      CustomerRef: { value: projQbo.get(inv.jobId) },
      TotalAmt: p.amount,
      TxnDate: p.date,
      DepositToAccountRef: acct(p.depositTo ?? ACCT.undeposited),
      PrivateNote: note([p.appId]),
      Line: apply > 0 ? [{ Amount: apply, LinkedTxn: [{ TxnId: invQbo.get(p.invoiceApp), TxnType: 'Invoice' }] }] : [],
    }, [p.appId]);
    payQbo.set(p.appId, qid);
  }

  // Sales receipts (money with no invoice — the extended warranty)
  const srQbo = new Map();
  for (const s of salesReceipts) {
    const customer = s.jobId ? projQbo.get(s.jobId) : custQbo.get(s.customerId);
    const qid = await ensure('sales_receipt', s.appId, 'SalesReceipt', {
      CustomerRef: { value: customer },
      TxnDate: s.date,
      DepositToAccountRef: acct(ACCT.undeposited),
      PrivateNote: note([s.appId]),
      Line: [{ DetailType: 'SalesItemLineDetail', Amount: s.amount, Description: s.description?.slice(0, 4000),
        SalesItemLineDetail: { ItemRef: { value: itemId[s.item] }, Qty: 1, UnitPrice: s.amount } }],
    }, [s.appId]);
    srQbo.set(s.appId, qid);
  }

  // Deposits — one per bank line
  for (const d of deposits.sort((a, b) => a.date.localeCompare(b.date))) {
    const lines = [
      ...d.linked.map((l) => ({
        Amount: l.amount,
        LinkedTxn: [{ TxnId: l.kind === 'payment' ? payQbo.get(l.appId) : srQbo.get(l.appId), TxnType: l.kind === 'payment' ? 'Payment' : 'SalesReceipt', TxnLineId: '0' }],
      })),
      ...d.other.map((o) => ({
        Amount: o.direction === 'in' ? o.amount : -o.amount,
        DetailType: 'DepositLineDetail',
        Description: o.description?.slice(0, 4000),
        DepositLineDetail: { AccountRef: acct(o.account), ...(o.project ? { Entity: { value: projectRef(o.project).value, type: 'Customer' } } : {}) },
      })),
    ];
    await ensure('deposit', d.ref, 'Deposit', {
      DepositToAccountRef: acct(ACCT.bank), TxnDate: d.date, PrivateNote: note([d.ref]), Line: lines,
    }, [...d.linked.map((l) => l.appId), ...d.other.map((o) => o.appId)]);
  }

  // Purchases — one per bank line
  for (const p of purchases.sort((a, b) => a.date.localeCompare(b.date))) {
    await ensure('purchase', p.ref, 'Purchase', {
      PaymentType: p.paymentType,
      AccountRef: acct(ACCT.bank),
      TxnDate: p.date,
      ...(p.docNumber ? { DocNumber: p.docNumber } : {}),
      PrivateNote: note([p.ref]),
      Line: p.lines.map((l) => ({
        Amount: l.amount,
        DetailType: 'AccountBasedExpenseLineDetail',
        Description: l.description?.slice(0, 4000),
        AccountBasedExpenseLineDetail: { AccountRef: acct(l.account), BillableStatus: 'NotBillable', ...(l.project ? { CustomerRef: projectRef(l.project) } : {}) },
      })),
    }, p.lines.map((l) => l.appId));
  }

  // Journal entries — payroll runs and money owed to Isaiah
  for (const j of journals) {
    await ensure('journal', j.appId, 'JournalEntry', {
      TxnDate: j.date,
      PrivateNote: note([j.kind === 'payroll' ? `Gusto ${j.receipt ?? ''}` : 'Isaiah out of pocket', j.appId]),
      Line: j.lines.map((l) => ({
        Amount: l.amount,
        DetailType: 'JournalEntryLineDetail',
        Description: (l.description ?? (j.kind === 'payroll' ? `Gusto payroll, payday ${j.date}` : ''))?.slice(0, 4000),
        JournalEntryLineDetail: {
          PostingType: l.posting,
          AccountRef: acct(l.account),
          ...(l.project ? { Entity: { Type: 'Customer', EntityRef: projectRef(l.project) } } : {}),
        },
      })),
    }, [j.appId]);
  }

  // Cash handed back to Devon from the DC-26002 cash payment
  for (const m of cashMoves) {
    await ensure('cash_move', m.appId, 'Purchase', {
      PaymentType: 'Cash', AccountRef: acct(m.from), TxnDate: m.date, PrivateNote: note([m.appId]),
      Line: [{ Amount: m.amount, DetailType: 'AccountBasedExpenseLineDetail', Description: m.description?.slice(0, 4000),
        AccountBasedExpenseLineDetail: { AccountRef: acct(m.account) } }],
    }, [m.appId]);
  }

  console.log(`\nDone: ${created} QuickBooks objects created (projects as ${projectMode ?? 'n/a'}).`);
  const bank = (await query(`select * from Account where Name = '${ACCT.bank}'`))[0];
  console.log(`QuickBooks now shows ${ACCT.bank} at ${fmt(Number(bank.CurrentBalance))} (projected ${fmt(money(STATEMENT_CHECK.opening + bankEffect('2099-12-31')))}).`);
}
