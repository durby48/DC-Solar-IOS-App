// One-off, 2026-11-21 (Devon): invoices the app has but QuickBooks never got, and the
// customer payments that came in through the Chase feed without an invoice to apply to.
// Dry run unless --apply. Re-runnable: everything is looked up in qbo_links first.
//
//   1. Invoices (qbo_links 'invoice', same shape as scripts/qbo/import.mjs) for every billed job
//      without one: DC-26007 26015 26025 26028 26042 26044 26049 26050 26055 26056 26057.
//   2. Feed deposits that went straight to A/R (451 SunSmart $31,980.89, 452 $2,100): a Payment
//      applied to the job's invoice, then the SAME deposit re-pointed at that payment.
//   3. Cromwell $13,100 (11/13, still in the bank feed's For Review): three Payments
//      (DC-26050 / 26007 / 26044) and ONE Deposit into checking — Devon then MATCHES the feed
//      line to it (never "Add").
//   4. DC-26032 / 26038 / 26035: already paid in QuickBooks (Payments 367 / 381 / 395) — only
//      linked to the app rows so the import never makes them again.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { client, ensureProject, liveConnection, readEnv } from '../../supabase/functions/qbo-books/index.ts';

const APPLY = Deno.args.includes('--apply');
const env = readEnv();
if (typeof env === 'string') throw new Error(env);
const admin = createClient(env.supabaseUrl, env.serviceKey);
const qbo = client(env, await liveConnection(env, admin, 'dc-solar'));
const money = (n: number) => Math.round(n * 100) / 100;
const JOBS = ['DC-26007', 'DC-26015', 'DC-26025', 'DC-26028', 'DC-26042', 'DC-26044', 'DC-26049', 'DC-26050', 'DC-26055', 'DC-26056', 'DC-26057'];

const { data: jobs } = await admin.from('jobs').select('id, job_number, name, job_type, customer_id').eq('company', 'dc-solar').in('job_number', [...JOBS, 'DC-26032', 'DC-26035', 'DC-26038']);
const jobByNo = new Map((jobs ?? []).map((j: any) => [j.job_number, j]));
const { data: links } = await admin.from('qbo_links').select('*').eq('company', 'dc-solar');
const link = (kind: string, key: string) => (links ?? []).find((l: any) => l.app_kind === kind && l.app_key === key)?.qbo_id as string | undefined;
const accounts = await qbo.query('select * from Account');
const acct = (name: string) => {
  const a = accounts.find((x: any) => x.FullyQualifiedName === name || x.Name === name);
  if (!a) throw new Error(`no account ${name}`);
  return { value: a.Id, name: a.Name };
};
const kindOf = (j: any) => {
  const t = `${j.job_type ?? ''} ${j.name ?? ''}`.toLowerCase();
  if (/critter/.test(t)) return 'critter';
  if (/clean|inspection|service/.test(t)) return 'service';
  if (/\br&r\b|reinstall|remov/.test(t)) return 'rr';
  return 'install';
};
const save = async (kind: string, key: string, type: string, id: string, appIds: string[]) => {
  if (!APPLY) return;
  const { error } = await admin.from('qbo_links').upsert({ company: 'dc-solar', app_kind: kind, app_key: key, qbo_type: type, qbo_id: id, app_ids: appIds, synced_at: new Date().toISOString() });
  if (error) throw error;
};
const log = (...a: unknown[]) => console.log(APPLY ? '' : '[dry]', ...a);

// ------------------------------------------------------------------ 1. invoices
const invoiceQbo = new Map<string, string>();
for (const no of JOBS) {
  const j = jobByNo.get(no);
  const { data: invs } = await admin.from('finance_entries').select('*').eq('job_id', j.id).eq('type', 'invoice').neq('status', 'void').order('occurred_on', { ascending: false }).order('created_at', { ascending: false });
  const inv = (invs ?? []).find((r: any) => !/-Contract$/i.test(r.document_number ?? ''));
  if (!inv) { log(no, 'no invoice in the app — skipped'); continue; }
  const existing = link('invoice', inv.id);
  if (existing) { invoiceQbo.set(no, existing); log(no, 'invoice already', existing); continue; }
  const items = Array.isArray(inv.line_items) ? inv.line_items : [];
  let lines = items.map((li: any) => ({ description: li.name, qty: Number(li.qty) || 1, rate: Number(li.rate) || 0, amount: money((Number(li.qty) || 1) * (Number(li.rate) || 0)) }));
  if (!lines.length || Math.abs(lines.reduce((s: number, l: any) => s + l.amount, 0) - Number(inv.amount)) > 0.005) {
    lines = [{ description: j.name, qty: 1, rate: money(Number(inv.amount)), amount: money(Number(inv.amount)) }];
  }
  const itemId = link('item', kindOf(j));
  log(no, `invoice $${inv.amount} ${inv.occurred_on} item ${kindOf(j)}`);
  if (!APPLY) continue;
  const customer = await ensureProject(qbo, admin, 'dc-solar', j.id);
  const created = (await qbo.post('invoice', {
    CustomerRef: { value: customer }, TxnDate: inv.occurred_on, DocNumber: no,
    PrivateNote: `DC Solar app 2026-11-21 · ${inv.id}`,
    Line: lines.map((l: any) => ({ DetailType: 'SalesItemLineDetail', Amount: l.amount, Description: l.description?.slice(0, 4000), SalesItemLineDetail: { ItemRef: { value: itemId }, Qty: l.qty, UnitPrice: l.rate } })),
  })).Invoice;
  await save('invoice', inv.id, 'Invoice', created.Id, [inv.id]);
  invoiceQbo.set(no, created.Id);
}

// ------------------------------------------------------------------ payments
async function appPayment(no: string, bankRef: string) {
  const j = jobByNo.get(no);
  const { data } = await admin.from('finance_entries').select('id, amount, occurred_on').eq('job_id', j.id).eq('type', 'payment').neq('status', 'void').eq('extracted->>bank_ref', bankRef);
  if (data?.length !== 1) throw new Error(`${no}: expected one app payment for ${bankRef}, found ${data?.length}`);
  return data[0] as { id: string; amount: number; occurred_on: string };
}
async function payment(no: string, row: { id: string; amount: number; occurred_on: string }) {
  const have = link('payment', row.id);
  if (have) return have;
  log(no, `payment $${row.amount} ${row.occurred_on} → invoice`);
  if (!APPLY) return `dry-${no}`;
  const customer = await ensureProject(qbo, admin, 'dc-solar', jobByNo.get(no).id);
  const p = (await qbo.post('payment', {
    CustomerRef: { value: customer }, TotalAmt: money(Number(row.amount)), TxnDate: row.occurred_on,
    DepositToAccountRef: acct('Undeposited funds'), PrivateNote: `DC Solar app 2026-11-21 · ${row.id}`,
    Line: [{ Amount: money(Number(row.amount)), LinkedTxn: [{ TxnId: invoiceQbo.get(no), TxnType: 'Invoice' }] }],
  })).Payment;
  await save('payment', row.id, 'Payment', p.Id, [row.id]);
  return p.Id as string;
}

// 2. feed deposits posted straight to A/R → point them at a real payment
for (const [depId, no, ref] of [['451', 'DC-26042', '2026-11-11|31980.89|SUNSMART ACH'], ['452', 'DC-26056', '2026-11-12|2100.00|DEPOSIT 9040']] as const) {
  if (link('feed_deposit', ref)) { log(no, 'deposit already re-pointed'); continue; }
  const row = await appPayment(no, ref);
  const dep = (await qbo.get(`deposit/${depId}`)).Deposit;
  const arLine = dep.Line.find((l: any) => /receivable/i.test(l.DepositLineDetail?.AccountRef?.name ?? ''));
  if (!arLine || Math.abs(Number(arLine.Amount) - Number(row.amount)) > 0.005) throw new Error(`deposit ${depId} is not the A/R line we expect`);
  const payId = await payment(no, row);
  log(no, `deposit ${depId}: A/R line → payment ${payId}`);
  if (!APPLY) continue;
  dep.Line = dep.Line.map((l: any) => (l === arLine ? { Amount: l.Amount, LinkedTxn: [{ TxnId: payId, TxnType: 'Payment', TxnLineId: '0' }] } : l));
  const saved = (await qbo.post('deposit', dep)).Deposit;
  await save('feed_deposit', ref, 'Deposit', saved.Id, [row.id]);
}

// 3. Cromwell $13,100 — payments + one deposit for the feed line to match
{
  const ref = '2026-11-13|13100.00|CROMWELL ACH';
  if (link('feed_deposit', ref)) log('Cromwell deposit already made');
  else {
    const rows = await Promise.all(['DC-26050', 'DC-26007', 'DC-26044'].map(async (no) => [no, await appPayment(no, ref)] as const));
    const total = money(rows.reduce((s, [, r]) => s + Number(r.amount), 0));
    if (total !== 13100) throw new Error(`Cromwell rows add to ${total}`);
    const ids = [];
    for (const [no, r] of rows) ids.push(await payment(no, r));
    log(`Cromwell: deposit $${total} 2026-11-13 into checking from payments ${ids.join(', ')}`);
    if (APPLY) {
      const dep = (await qbo.post('deposit', {
        DepositToAccountRef: acct('BUS COMPLETE CHK (7086)'), TxnDate: '2026-11-13',
        PrivateNote: 'Cromwell ACH $13,100 = DC-26050 + DC-26007 + DC-26044 (DC Solar app 2026-11-21). MATCH the bank-feed line to this.',
        Line: ids.map((id, i) => ({ Amount: money(Number(rows[i][1].amount)), LinkedTxn: [{ TxnId: id, TxnType: 'Payment', TxnLineId: '0' }] })),
      })).Deposit;
      await save('feed_deposit', ref, 'Deposit', dep.Id, rows.map(([, r]) => r.id));
    }
  }
}

// 4. paid in QuickBooks already — link only
for (const [no, qboId, appId] of [['DC-26032', '367', 'f78993fd-c4d5-413c-9bd1-5becb1085833'], ['DC-26038', '381', 'a8a4c17b-e4e3-4e2f-b101-2238e093890e'], ['DC-26035', '395', 'fa4b88fa-c04f-465b-bebf-d3463f86a6b6']]) {
  if (link('payment', appId)) continue;
  log(no, `link app payment ${appId.slice(0, 8)} ↔ QuickBooks Payment ${qboId}`);
  await save('payment', appId, 'Payment', qboId, [appId]);
}
console.log('done', APPLY ? '(applied)' : '(dry run)');
