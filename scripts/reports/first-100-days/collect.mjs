// Data for "DC Solar KC â€” Our First 100 Days" (Day 1 = 2026-07-01, through today).
import { readFileSync, writeFileSync } from 'node:fs';
import { qbo, sql } from 'file:///C:/Durbin%20Enterprises/DC-Solar-IOS-App/scripts/qbo/qbo.mjs';

const START = '2026-07-01';
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const money = (n) => Math.round(Number(n) * 100) / 100;
const ext = (r) => (typeof r.extracted === 'string' ? JSON.parse(r.extracted) : r.extracted) ?? {};

const [jobs, entries, runs, hours, clocks, employees, assets, customers] = await Promise.all([
  sql(`select id, job_number, name, job_type, stage, completed_on::text, module_count, has_critter_guard, critter_guard_panels, customer_id, is_internal from public.jobs where company='dc-solar'`),
  sql(`select type, direction, amount::float amount, occurred_on::text, job_id, customer_id, paid_from_bank, extracted from public.finance_entries where company='dc-solar' and status <> 'void'`),
  sql(`select payday::text, gross_wages::float gross, total_withdrawn::float withdrawn, bank_withdrawn_on::text from public.payroll_runs order by payday`),
  sql(`select lower(coalesce(email, employee)) who, occurred_on::text d, hours::float h, job_id from public.employee_hours where occurred_on >= '${START}'`),
  sql(`select lower(employee) who, ((clock_in at time zone 'America/Chicago')::date)::text d, extract(epoch from (clock_out - clock_in))/3600.0 h, job_id from public.time_entries where clock_out > clock_in`),
  sql(`select email, display_name, role, field_crew, is_test from public.employees where company='dc-solar'`),
  sql(`select name, purchase_date::text, cost::float cost from public.company_assets where company='dc-solar' order by purchase_date`),
  sql(`select id, name from public.customers where company='dc-solar'`),
]);

const inWin = (d) => d && d >= START && d <= TODAY;
const real = jobs.filter((j) => !j.is_internal);
const done = real.filter((j) => (j.stage === 'Complete' && inWin(j.completed_on)) || j.stage === 'Pending Payment');
const critterOnly = (j) => j.job_type === 'Critter Guard';
const removalOnly = (j) => /^removal of/i.test(j.name ?? '');
const panels = done.filter((j) => !critterOnly(j) && !removalOnly(j)).reduce((s, j) => s + (j.module_count ?? 0), 0);
const critter = done.filter((j) => j.has_critter_guard).reduce((s, j) => s + (j.critter_guard_panels ?? j.module_count ?? 0), 0);

const allHours = [...hours, ...clocks.filter((c) => inWin(c.d))].filter((h) => inWin(h.d)).map((h) => ({ ...h, h: Number(h.h) || 0 }));
const totalHours = allHours.reduce((s, h) => s + h.h, 0);
const workedJobIds = new Set(allHours.map((h) => h.job_id).filter(Boolean));
const activeJobs = real.filter((j) => workedJobIds.has(j.id) || entries.some((e) => e.job_id === j.id && inWin(e.occurred_on)));

const pays = entries.filter((e) => e.type === 'payment' && inWin(e.occurred_on));
const revenue = pays.reduce((s, e) => s + e.amount, 0);
const isAsset = (e) => ['vehicle_purchase', 'equipment_purchase'].includes(ext(e).book_account);
const isDraw = (e) => ext(e).book_account === 'owner_draw';
const exp = entries.filter((e) => e.type === 'expense' && inWin(e.occurred_on) && !isAsset(e) && !isDraw(e));
const expenses = exp.reduce((s, e) => s + e.amount, 0);
const materials = exp.filter((e) => ext(e).book_account === 'job_materials').reduce((s, e) => s + e.amount, 0);
const payrollRuns = runs.filter((r) => inWin(r.payday));
const payroll = payrollRuns.reduce((s, r) => s + r.withdrawn, 0);
const grossWages = payrollRuns.reduce((s, r) => s + r.gross, 0);
const invoiced = (() => {
  const plan = JSON.parse(readFileSync('C:\\Durbin Enterprises\\DC-Solar-IOS-App\\scripts\\qbo\\out\\plan.json', 'utf8'));
  return plan.invoices.filter((i) => inWin(i.date)).reduce((s, i) => s + i.total, 0);
})();
const customerIds = new Set(activeJobs.map((j) => j.customer_id).filter(Boolean));
for (const e of pays) if (e.customer_id) customerIds.add(e.customer_id);

// Cash: Chase running balance (activity export), last balance of each posting day.
const csv = readFileSync('C:\\Users\\Devon Durbin\\Downloads\\Chase7086_Activity_20261014.csv', 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
const dayBal = new Map();
for (const line of csv) {
  const cols = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''));
  const [m, d, y] = cols[1].split('/');
  const iso = `${y}-${m}-${d}`;
  const bal = parseFloat(cols[5]);
  if (!Number.isFinite(bal)) continue;
  if (!dayBal.has(iso)) dayBal.set(iso, bal); // file is newest first â†’ first seen = end of day
}
dayBal.set('2026-06-30', 790.36); // statement: ending balance Jun 30
const cash = [...dayBal.entries()].filter(([d]) => d >= '2026-06-30').sort((a, b) => a[0].localeCompare(b[0])).map(([d, v]) => ({ d, v }));

// Profit: cumulative cash-basis profit by day (payments âˆ’ costs âˆ’ payroll withdrawn on payday).
const delta = new Map();
const add = (d, v) => delta.set(d, (delta.get(d) ?? 0) + v);
for (const e of pays) add(e.occurred_on, e.amount);
for (const e of exp) add(e.occurred_on, -e.amount);
for (const r of payrollRuns) add(r.payday <= TODAY ? r.payday : TODAY, -r.withdrawn);
const profit = [];
let run = 0;
for (let t = new Date(`${START}T12:00:00Z`); t.toISOString().slice(0, 10) <= TODAY; t.setUTCDate(t.getUTCDate() + 1)) {
  const d = t.toISOString().slice(0, 10);
  run += delta.get(d) ?? 0;
  profit.push({ d, v: money(run) });
}
// Monthly profit bars
const monthly = {};
for (const [d, v] of delta) if (inWin(d)) monthly[d.slice(0, 7)] = money((monthly[d.slice(0, 7)] ?? 0) + v);
const monthlyIn = {};
for (const e of pays) monthlyIn[e.occurred_on.slice(0, 7)] = money((monthlyIn[e.occurred_on.slice(0, 7)] ?? 0) + e.amount);

// Value: QuickBooks balance sheet (accrual) â€” total equity at each week's end.
let value = [];
try {
  const bs = await qbo('GET', `reports/BalanceSheet?start_date=2026-06-26&end_date=${TODAY}&accounting_method=Accrual&summarize_column_by=Week`);
  const cols = bs.Columns.Column.map((c) => c.MetaData?.find((m) => m.Name === 'EndDate')?.Value ?? c.ColTitle);
  const find = (rows, label) => {
    for (const r of rows ?? []) {
      if (r.Summary?.ColData?.[0]?.value === label) return r.Summary.ColData;
      const hit = r.Rows ? find(r.Rows.Row, label) : null;
      if (hit) return hit;
    }
    return null;
  };
  const eq = find(bs.Rows.Row, 'Total Equity');
  const assetsRow = find(bs.Rows.Row, 'TOTAL ASSETS');
  value = cols.map((c, i) => ({ d: c, v: Number(eq?.[i]?.value) || 0, assets: Number(assetsRow?.[i]?.value) || 0 })).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.d));
} catch (e) {
  console.error('balance sheet:', e.message);
}

const crew = employees.filter((e) => !e.is_test && ['viewer', 'operator', 'owner'].includes(e.role));
const out = {
  start: START, today: TODAY,
  day: Math.round((new Date(`${TODAY}T12:00:00Z`) - new Date(`${START}T12:00:00Z`)) / 86400000) + 1,
  stats: {
    hours: Math.round(totalHours), panels, critter, projectsCompleted: done.length, projectsActive: activeJobs.length,
    revenue: money(revenue), invoiced: money(invoiced), expenses: money(expenses), materials: money(materials),
    payroll: money(payroll), grossWages: money(grossWages), payrollRuns: payrollRuns.length,
    netProfit: money(revenue - expenses - payroll), customers: customerIds.size,
    vehicles: assets.map((a) => a.name), vehicleCost: money(assets.reduce((s, a) => s + a.cost, 0)),
    crew: crew.length, cashToday: cash.at(-1)?.v, cashStart: 790.36,
  },
  monthly, monthlyIn, cash, profit, value,
  employees: employees.filter((e) => !e.is_test).map((e) => ({ name: e.display_name, role: e.role, crew: e.field_crew })),
  topCustomers: Object.entries(pays.reduce((m, e) => {
    const c = customers.find((x) => x.id === (e.customer_id ?? real.find((j) => j.id === e.job_id)?.customer_id))?.name ?? '?';
    m[c] = (m[c] ?? 0) + e.amount; return m;
  }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8),
};
writeFileSync(new URL('./data.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, cash: out.cash.length, profit: out.profit.length, value: out.value }, null, 1));

