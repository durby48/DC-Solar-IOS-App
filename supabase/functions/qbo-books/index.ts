/**
 * qbo-books — the app's window onto the QuickBooks books (2026-11-21).
 *
 * QuickBooks is now the system of record (Devon, 2026-11-21): the Financials
 * tab shows QuickBooks' own numbers, and the app only ADDS what QuickBooks
 * cannot know (which job an expense belongs to, the receipt photo).
 *
 * Every action needs a signed-in owner / operator / developer.
 *
 *   { action: 'overview', start, end }
 *       → P&L by month, balance sheet at `end`, A/R aging, headline figures.
 *   { action: 'jobs', start, end }
 *       → per-job P&L (ProfitAndLoss summarized by Customers), each column
 *         tied back to the app job through qbo_links (app_kind 'project').
 *   { action: 'untagged', start, end }
 *       → expense lines (Purchase / Bill) with no customer/project, or still on
 *         Uncategorized / Ask My Accountant, plus the spending accounts for a
 *         picker. A HINT is shown where the app can tell (matching app receipt,
 *         a DC-26xxx in the memo, the only job scheduled that day for fuel) —
 *         nothing is ever applied without Devon choosing it (Devon, 2026-11-21).
 *   { action: 'assign', type, id, lineId, jobId | overhead: true, accountId? }
 *       → puts the line on the job's project in QuickBooks (creating the
 *         project if the job has none yet), on `accountId` when given or else
 *         an overhead account's job-cost twin; `overhead: true` keeps it off
 *         any job (and recategorizes when accountId is given).
 *   { action: 'split_payroll', dryRun?, runIds? }
 *       → rewrites a Gusto run's Chase-feed purchase (one "Payroll expenses"
 *         line) into Job labor per job by hours + overhead wages + employer
 *         taxes. Same transaction, same total. See splitPayroll().
 *   { action: 'match_app', dryRun?, keys? }
 *       → THE DUPLICATE GUARD. App expenses paid from the bank are never
 *         created in QuickBooks — Chase's bank feed already brings that money
 *         in. Instead each one waits until its bank line is in QuickBooks
 *         (same amount, within 5 days, not already matched) and then stamps
 *         that transaction with the job. The Financials screen runs it as a
 *         dry run; Devon confirms matches on /books-jobs, which passes the
 *         chosen `keys` (only those are written). Links are recorded in qbo_links as
 *         app_kind 'feed_match', which scripts/qbo/import.mjs never creates,
 *         updates or deletes.
 *
 * verify_jwt ON. Secrets: QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_ENV (shared
 * with qbo-oauth).
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const MINOR_VERSION = '75';
/** The books start (BOOKS_START in lib/books.ts). */
const BOOKS_START = '2026-06-26';
/**
 * First day of bank-feed bookkeeping. The last app → QuickBooks import ran
 * 2026-10-14; from the 15th on, Chase's feed brings bank money into QuickBooks
 * and the app must never create it again (FEED_START in scripts/qbo/import.mjs).
 */
const FEED_START = '2026-10-15';
const MATCH_WINDOW_DAYS = 5;

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}
const ok = (p: Record<string, unknown>) => json({ ok: true, ...p });
const fail = (status: number, code: string, error: string) => json({ ok: false, code, error }, status);

type Env = { supabaseUrl: string; serviceKey: string; clientId: string; clientSecret: string; apiBase: string };

export function readEnv(): Env | string {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const clientId = Deno.env.get('QBO_CLIENT_ID');
  const clientSecret = Deno.env.get('QBO_CLIENT_SECRET');
  if (!supabaseUrl || !serviceKey) return 'Server is missing its Supabase settings.';
  if (!clientId || !clientSecret) return 'QuickBooks keys are not set (QBO_CLIENT_ID / QBO_CLIENT_SECRET).';
  const sandbox = Deno.env.get('QBO_ENV') === 'sandbox';
  return {
    supabaseUrl,
    serviceKey,
    clientId,
    clientSecret,
    apiBase: sandbox ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com',
  };
}

// ---------------------------------------------------------------- connection

type Conn = { company: string; realm_id: string; access_token: string; access_expires_at: string; refresh_token: string };

class QboError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function liveConnection(env: Env, admin: SupabaseClient, company: string): Promise<Conn> {
  const { data } = await admin.from('qbo_connections').select('*').eq('company', company).maybeSingle();
  const conn = data as Conn | null;
  if (!conn) throw new QboError(409, 'QuickBooks is not connected. Systems Management → QuickBooks → Connect.');
  if (new Date(conn.access_expires_at).getTime() - Date.now() > 5 * 60 * 1000) return conn;
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.clientId}:${env.clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: conn.refresh_token }).toString(),
  });
  const t = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof t.access_token !== 'string') {
    throw new QboError(409, `QuickBooks refused the saved login (${String(t.error ?? res.status)}). Connect again.`);
  }
  const now = Date.now();
  const patch = {
    access_token: t.access_token as string,
    refresh_token: t.refresh_token as string,
    access_expires_at: new Date(now + Number(t.expires_in) * 1000).toISOString(),
    refresh_expires_at: t.x_refresh_token_expires_in
      ? new Date(now + Number(t.x_refresh_token_expires_in) * 1000).toISOString()
      : null,
    updated_at: new Date(now).toISOString(),
  };
  await admin.from('qbo_connections').update(patch).eq('company', company);
  return { ...conn, ...patch };
}

type Qbo = {
  get: (path: string) => Promise<Record<string, any>>;
  post: (path: string, body: unknown) => Promise<Record<string, any>>;
  query: (q: string) => Promise<Record<string, any>[]>;
};

export function client(env: Env, conn: Conn): Qbo {
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${env.apiBase}/v3/company/${conn.realm_id}/${path}${sep}minorversion=${MINOR_VERSION}`, {
      method,
      headers: {
        Authorization: `Bearer ${conn.access_token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      const fault = data?.Fault?.Error?.[0];
      throw new QboError(res.status === 401 ? 409 : 502, `QuickBooks: ${fault?.Detail ?? fault?.Message ?? res.status}`);
    }
    return data;
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    async query(q) {
      const out: Record<string, any>[] = [];
      for (let start = 1; ; start += 1000) {
        const data = await call('GET', `query?query=${encodeURIComponent(`${q} STARTPOSITION ${start} MAXRESULTS 1000`)}`);
        const resp = data.QueryResponse ?? {};
        const key = Object.keys(resp).find((k) => Array.isArray(resp[k]));
        const rows = key ? (resp[key] as Record<string, any>[]) : [];
        out.push(...rows);
        if (rows.length < 1000) return out;
      }
    },
  };
}

// ---------------------------------------------------------------- reports

/**
 * A QuickBooks report flattened into a tree. `values` line up with `columns`;
 * `group` is QuickBooks' section tag (Income, COGS, Expenses, NetIncome,
 * BankAccounts, AR, …) so the app can find the headline figures without
 * matching on labels.
 */
type ReportNode = { label: string; group?: string; id?: string; values: number[]; children?: ReportNode[]; total?: boolean };
type Report = { title: string; columns: { title: string; key?: string }[]; rows: ReportNode[] };

const num = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

function parseRows(rows: any[] | undefined): ReportNode[] {
  const out: ReportNode[] = [];
  for (const r of rows ?? []) {
    if (r.type === 'Section' || r.Rows || r.Header) {
      const head = r.Header?.ColData ?? [];
      const sum = r.Summary?.ColData ?? [];
      const children = parseRows(r.Rows?.Row);
      const label = head[0]?.value || sum[0]?.value || r.group || '';
      out.push({
        label,
        group: r.group,
        values: (sum.length ? sum : head).slice(1).map((c: any) => num(c.value)),
        children: children.length ? children : undefined,
        total: !head.length,
      });
    } else if (r.ColData) {
      out.push({ label: r.ColData[0]?.value ?? '', id: r.ColData[0]?.id, values: r.ColData.slice(1).map((c: any) => num(c.value)) });
    }
  }
  return out;
}

async function report(qbo: Qbo, name: string, params: Record<string, string>): Promise<Report> {
  const data = await qbo.get(`reports/${name}?${new URLSearchParams(params).toString()}`);
  const cols = (data.Columns?.Column ?? []) as any[];
  return {
    title: data.Header?.ReportName ?? name,
    columns: cols.slice(1).map((c) => ({
      title: c.ColTitle ?? '',
      key: (c.MetaData ?? []).find((m: any) => m.Name === 'ColKey')?.Value,
    })),
    rows: parseRows(data.Rows?.Row),
  };
}

/** Last value (the Total column) of the section tagged `group`, anywhere in the tree. */
function groupTotal(rows: ReportNode[], group: string): number | null {
  for (const r of rows) {
    if (r.group === group) return r.values.at(-1) ?? 0;
    const inner = r.children ? groupTotal(r.children, group) : null;
    if (inner != null) return inner;
  }
  return null;
}
function groupValues(rows: ReportNode[], group: string): number[] | null {
  for (const r of rows) {
    if (r.group === group) return r.values;
    const inner = r.children ? groupValues(r.children, group) : null;
    if (inner) return inner;
  }
  return null;
}

const isISO = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const todayCentral = () => new Date(Date.now() - 6 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round(Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000);
const money = (n: number) => Math.round(n * 100) / 100;

export async function overview(qbo: Qbo, start: string, end: string) {
  const [pnl, bs, ar] = await Promise.all([
    report(qbo, 'ProfitAndLoss', { start_date: start, end_date: end, summarize_column_by: 'Month', accounting_method: 'Cash' }),
    report(qbo, 'BalanceSheet', { end_date: end, accounting_method: 'Cash' }),
    report(qbo, 'AgedReceivables', { report_date: end }),
  ]);
  const months = pnl.columns.filter((c) => c.title && !/total/i.test(c.title)).map((c, i) => ({
    title: c.title,
    income: groupValues(pnl.rows, 'Income')?.[i] ?? 0,
    cogs: groupValues(pnl.rows, 'COGS')?.[i] ?? 0,
    expenses: groupValues(pnl.rows, 'Expenses')?.[i] ?? 0,
    net: groupValues(pnl.rows, 'NetIncome')?.[i] ?? 0,
  }));
  return {
    period: { start, end },
    headline: {
      income: groupTotal(pnl.rows, 'Income') ?? 0,
      cogs: groupTotal(pnl.rows, 'COGS') ?? 0,
      grossProfit: groupTotal(pnl.rows, 'GrossProfit') ?? 0,
      expenses: groupTotal(pnl.rows, 'Expenses') ?? 0,
      netIncome: groupTotal(pnl.rows, 'NetIncome') ?? 0,
      bank: groupTotal(bs.rows, 'BankAccounts') ?? 0,
      // The books are cash basis, where the balance sheet always shows A/R as $0 —
      // what customers owe comes from the A/R aging report's grand total instead.
      receivables: groupTotal(ar.rows, 'GrandTotal') ?? ar.rows.at(-1)?.values.at(-1) ?? 0,
      liabilities: groupTotal(bs.rows, 'Liabilities') ?? 0,
      equity: groupTotal(bs.rows, 'Equity') ?? 0,
    },
    months,
    pnl,
    balanceSheet: bs,
    receivables: ar,
  };
}

// ---------------------------------------------------------------- jobs

type JobRef = { id: string; job_number: string | null; name: string | null; stage: string | null; customer_id: string | null; is_internal?: boolean | null };

async function projectLinks(admin: SupabaseClient, company: string) {
  const { data } = await admin.from('qbo_links').select('app_key, qbo_id').eq('company', company).eq('app_kind', 'project');
  const byQbo = new Map<string, string>();
  const byJob = new Map<string, string>();
  for (const l of (data ?? []) as { app_key: string; qbo_id: string }[]) {
    byQbo.set(l.qbo_id, l.app_key);
    byJob.set(l.app_key, l.qbo_id);
  }
  return { byQbo, byJob };
}

export async function jobsReport(qbo: Qbo, admin: SupabaseClient, company: string, start: string, end: string) {
  const [pnl, links, jobsRes] = await Promise.all([
    report(qbo, 'ProfitAndLoss', { start_date: start, end_date: end, summarize_column_by: 'Customers', accounting_method: 'Cash' }),
    projectLinks(admin, company),
    admin.from('jobs').select('id, job_number, name, stage, customer_id').eq('company', company),
  ]);
  const jobs = new Map(((jobsRes.data ?? []) as JobRef[]).map((j) => [j.id, j]));
  const pick = (group: string, i: number) => groupValues(pnl.rows, group)?.[i] ?? 0;
  const rows = pnl.columns
    .map((c, i) => {
      // "Total <customer>" columns are QuickBooks' roll-up of a parent customer's
      // projects — counting them would double every job.
      if (/^total\b/i.test(c.title)) return null;
      const jobId = c.key ? links.byQbo.get(c.key) : undefined;
      const job = jobId ? jobs.get(jobId) : undefined;
      const income = pick('Income', i);
      const cogs = pick('COGS', i);
      const expenses = pick('Expenses', i);
      const net = pick('NetIncome', i);
      if (!income && !cogs && !expenses && !net) return null;
      return {
        qboId: c.key ?? null,
        title: c.title || 'Not assigned to a job',
        jobId: job?.id ?? null,
        jobNumber: job?.job_number ?? null,
        stage: job?.stage ?? null,
        income,
        cogs,
        expenses,
        net,
        marginPct: income ? Math.round((net / income) * 1000) / 10 : null,
      };
    })
    .filter(Boolean);
  return { period: { start, end }, rows };
}

// ---------------------------------------------------------------- untagged lines

type Account = { Id: string; Name: string; FullyQualifiedName: string; AccountType: string; Active: boolean };
const SPENDING_TYPES = new Set(['Expense', 'Cost of Goods Sold', 'Other Expense']);
/** Overhead account → the job-cost twin it becomes when the line goes on a job (lib/books.ts). */
const JOB_TWIN: Record<string, string> = {
  'Vehicle expenses:Fuel': 'Job fuel & travel',
  Fuel: 'Job fuel & travel',
  Supplies: 'Job materials',
  'Tools & small equipment': 'Job materials',
  'Equipment rental': 'Job equipment rental',
  'Uncategorized Expense': 'Job materials',
};
const FUELISH = /fuel|gas|travel|vehicle/i;
const UNCATEGORIZED = /uncategori[sz]ed|ask my accountant/i;

type Line = {
  type: 'Purchase' | 'Bill';
  id: string;
  lineId: string;
  date: string;
  amount: number;
  total: number;
  payee: string | null;
  memo: string | null;
  account: string;
  accountType: string;
  jobCost: boolean;
  hasJob: boolean;
  uncategorized: boolean;
  suggestion: { jobId: string; jobNumber: string | null; why: string } | null;
};

export async function untagged(qbo: Qbo, admin: SupabaseClient, company: string, from: string, end: string) {
  // Before FEED_START every expense was categorised in the app's Review for QuickBooks and
  // imported; what is untagged there is deliberate overhead. Only feed-era lines need a look.
  const start = from < FEED_START ? FEED_START : from;
  const [accounts, purchases, bills, reviewedRes, jobsRes] = await Promise.all([
    qbo.query('select * from Account'),
    qbo.query(`select * from Purchase where TxnDate >= '${start}' and TxnDate <= '${end}'`),
    qbo.query(`select * from Bill where TxnDate >= '${start}' and TxnDate <= '${end}'`),
    admin.from('qbo_links').select('app_key').eq('company', company).eq('app_kind', 'overhead_ok'),
    admin.from('jobs').select('id, job_number, name, stage, customer_id, is_internal').eq('company', company),
  ]);
  const acct = new Map((accounts as Account[]).map((a) => [a.Id, a]));
  const reviewed = new Set(((reviewedRes.data ?? []) as { app_key: string }[]).map((r) => r.app_key));
  const jobs = (jobsRes.data ?? []) as JobRef[];
  const jobByNumber = new Map(jobs.filter((j) => j.job_number).map((j) => [j.job_number!.toUpperCase(), j]));

  const lines: Line[] = [];
  for (const [type, txns] of [['Purchase', purchases], ['Bill', bills]] as const) {
    for (const t of txns) {
      for (const l of t.Line ?? []) {
        const d = l.AccountBasedExpenseLineDetail;
        if (!d) continue;
        const a = acct.get(d.AccountRef?.value);
        if (!a || !SPENDING_TYPES.has(a.AccountType)) continue;
        const uncategorized = UNCATEGORIZED.test(a.FullyQualifiedName);
        if (d.CustomerRef?.value && !uncategorized) continue;
        if (reviewed.has(`${type}:${t.Id}:${l.Id}`)) continue;
        lines.push({
          type,
          id: t.Id,
          lineId: l.Id,
          date: t.TxnDate,
          amount: money(num(l.Amount)),
          total: money(num(t.TotalAmt)),
          payee: t.EntityRef?.name ?? null,
          memo: [...new Set([l.Description, t.PrivateNote].filter(Boolean))].join(' · ') || null,
          account: a.FullyQualifiedName,
          accountType: a.AccountType,
          jobCost: a.AccountType === 'Cost of Goods Sold',
          hasJob: Boolean(d.CustomerRef?.value),
          uncategorized,
          suggestion: null,
        });
      }
    }
  }
  const accountChoices = (accounts as Account[])
    .filter((a) => a.Active !== false && SPENDING_TYPES.has(a.AccountType) && !UNCATEGORIZED.test(a.FullyQualifiedName))
    .map((a) => ({ id: a.Id, name: a.FullyQualifiedName, jobCost: a.AccountType === 'Cost of Goods Sold' }))
    .sort((a, b) => Number(b.jobCost) - Number(a.jobCost) || a.name.localeCompare(b.name));
  if (!lines.length) return { period: { start, end }, lines, accounts: accountChoices };

  // Suggestions. 1) An app expense on a job with the same amount within the window.
  const { data: appRows } = await admin
    .from('finance_entries')
    .select('id, job_id, amount, occurred_on, description')
    .eq('company', company)
    .eq('type', 'expense')
    .neq('status', 'void')
    .not('job_id', 'is', null)
    .gte('occurred_on', addDays(start, -MATCH_WINDOW_DAYS))
    .lte('occurred_on', addDays(end, MATCH_WINDOW_DAYS));
  // 2) Who was scheduled where, for fuel.
  const { data: sched } = await admin
    .from('job_schedule_dates')
    .select('job_id, work_date')
    .eq('company', company)
    .gte('work_date', start)
    .lte('work_date', end);
  const schedByDay = new Map<string, string[]>();
  for (const s of (sched ?? []) as { job_id: string; work_date: string }[]) {
    schedByDay.set(s.work_date, [...(schedByDay.get(s.work_date) ?? []), s.job_id]);
  }
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const internal = (id: string) => jobById.get(id)?.is_internal === true;

  for (const l of lines) {
    const m = (l.memo ?? '').toUpperCase().match(/DC-\d{5}/);
    const byMemo = m ? jobByNumber.get(m[0]) : undefined;
    if (byMemo) {
      l.suggestion = { jobId: byMemo.id, jobNumber: byMemo.job_number, why: `${m![0]} in the memo` };
      continue;
    }
    const twin = ((appRows ?? []) as { job_id: string; amount: number; occurred_on: string }[])
      .filter((r) => !internal(r.job_id) && Math.abs(num(r.amount) - l.amount) < 0.005 && dayDiff(r.occurred_on, l.date) <= MATCH_WINDOW_DAYS)
      .sort((a, b) => dayDiff(a.occurred_on, l.date) - dayDiff(b.occurred_on, l.date))[0];
    if (twin) {
      l.suggestion = { jobId: twin.job_id, jobNumber: jobById.get(twin.job_id)?.job_number ?? null, why: 'Matches a receipt in the app' };
      continue;
    }
    if (FUELISH.test(l.account) || FUELISH.test(l.payee ?? '')) {
      const onDay = [...new Set((schedByDay.get(l.date) ?? []).filter((id) => !internal(id)))];
      if (onDay.length === 1) {
        l.suggestion = { jobId: onDay[0], jobNumber: jobById.get(onDay[0])?.job_number ?? null, why: 'Only job scheduled that day' };
      }
    }
  }
  lines.sort((a, b) => b.date.localeCompare(a.date));
  return { period: { start, end }, lines, accounts: accountChoices };
}

// ---------------------------------------------------------------- projects + assign

/** The QuickBooks customer id of the job's project, creating customer + project when missing. */
export async function ensureProject(qbo: Qbo, admin: SupabaseClient, company: string, jobId: string): Promise<string> {
  const links = await projectLinks(admin, company);
  const have = links.byJob.get(jobId);
  if (have) return have;

  const { data: job } = await admin.from('jobs').select('id, job_number, name, customer_id').eq('id', jobId).maybeSingle();
  if (!job) throw new QboError(404, 'That job is not in the app.');
  const j = job as JobRef;
  if (!j.customer_id) throw new QboError(400, `${j.job_number ?? 'This job'} has no customer — give it one first.`);

  const { data: custLink } = await admin
    .from('qbo_links')
    .select('qbo_id')
    .eq('company', company)
    .eq('app_kind', 'customer')
    .eq('app_key', j.customer_id)
    .maybeSingle();
  let parent = (custLink as { qbo_id: string } | null)?.qbo_id;
  if (!parent) {
    const { data: c } = await admin.from('customers').select('id, name, email, phone, address').eq('id', j.customer_id).maybeSingle();
    const cust = c as { id: string; name: string; email?: string; phone?: string; address?: string } | null;
    if (!cust) throw new QboError(404, 'The job’s customer is missing.');
    const body: Record<string, unknown> = { DisplayName: cust.name.slice(0, 100), CompanyName: cust.name.slice(0, 100) };
    if (cust.email && /@/.test(cust.email)) body.PrimaryEmailAddr = { Address: cust.email };
    if (cust.phone) body.PrimaryPhone = { FreeFormNumber: cust.phone };
    if (cust.address) body.BillAddr = { Line1: cust.address.slice(0, 500) };
    const esc = cust.name.slice(0, 100).replace(/'/g, "\\'");
    const existing = (await qbo.query(`select * from Customer where DisplayName = '${esc}'`))[0];
    parent = existing?.Id ?? (await qbo.post('customer', body)).Customer.Id;
    await admin.from('qbo_links').upsert({
      company, app_kind: 'customer', app_key: cust.id, qbo_type: 'Customer', qbo_id: parent, app_ids: [cust.id], synced_at: new Date().toISOString(),
    });
  }
  const name = `${j.job_number ?? ''} ${j.name ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, 100);
  const created = await qbo.post('customer', { DisplayName: name, Job: true, BillWithParent: false, ParentRef: { value: parent } });
  const id = created.Customer.Id as string;
  await admin.from('qbo_links').upsert({
    company, app_kind: 'project', app_key: j.id, qbo_type: 'Customer', qbo_id: id, app_ids: [j.id], synced_at: new Date().toISOString(),
  });
  return id;
}

async function accountsByName(qbo: Qbo) {
  const all = (await qbo.query('select * from Account')) as Account[];
  return new Map(all.filter((a) => a.Active !== false).map((a) => [a.FullyQualifiedName, a]));
}

/** Put lines of one Purchase / Bill on a project. Full update so QuickBooks keeps the bank-feed match. */
async function tagTransaction(
  qbo: Qbo,
  type: 'Purchase' | 'Bill',
  id: string,
  lineIds: string[] | 'all',
  customerId: string | null,
  note?: string,
  accountId?: string,
) {
  const entity = (await qbo.get(`${type.toLowerCase()}/${id}`))[type];
  const byName = await accountsByName(qbo);
  const byId = new Map([...byName.values()].map((a) => [a.Id, a]));
  for (const l of entity.Line ?? []) {
    const d = l.AccountBasedExpenseLineDetail;
    if (!d) continue;
    if (lineIds !== 'all' && !lineIds.includes(l.Id)) continue;
    if (customerId) {
      d.CustomerRef = { value: customerId };
      d.BillableStatus = 'NotBillable';
    }
    const chosen = accountId ? byId.get(accountId) : undefined;
    if (accountId && !chosen) throw new QboError(400, 'That account is not in QuickBooks (or is inactive).');
    const current = byId.get(d.AccountRef?.value);
    const twin = customerId && current ? byName.get(JOB_TWIN[current.FullyQualifiedName] ?? '') : undefined;
    const next = chosen ?? twin;
    if (next) d.AccountRef = { value: next.Id, name: next.Name };
  }
  if (note) entity.PrivateNote = [entity.PrivateNote, note].filter(Boolean).join(' | ').slice(0, 4000);
  const saved = await qbo.post(type.toLowerCase(), entity);
  return saved[type];
}

// ---------------------------------------------------------------- the duplicate guard

type AppExpense = {
  id: string;
  job_id: string | null;
  amount: number;
  occurred_on: string;
  description: string | null;
  paid_from_bank: boolean;
  extracted: Record<string, unknown> | null;
};

export async function matchApp(qbo: Qbo, admin: SupabaseClient, company: string, dryRun: boolean, keys: Set<string> | null) {
  const { data } = await admin
    .from('finance_entries')
    .select('id, job_id, amount, occurred_on, description, paid_from_bank, extracted')
    .eq('company', company)
    .eq('type', 'expense')
    .eq('paid_from_bank', true)
    .neq('status', 'void')
    .gte('occurred_on', FEED_START);
  const rows = ((data ?? []) as AppExpense[]).filter((r) => !r.extracted?.paid_via_payroll);

  const { data: linkRows } = await admin.from('qbo_links').select('app_kind, qbo_id, app_ids').eq('company', company);
  const linkedApp = new Set<string>();
  const usedQbo = new Set<string>();
  for (const l of (linkRows ?? []) as { app_kind: string; qbo_id: string; app_ids: string[] }[]) {
    for (const a of l.app_ids ?? []) linkedApp.add(a);
    if (l.app_kind === 'feed_match' || l.app_kind === 'purchase') usedQbo.add(l.qbo_id);
  }

  // One bank line can carry several app rows (a receipt split across jobs): group by bank_ref.
  const groups = new Map<string, AppExpense[]>();
  for (const r of rows) {
    if (linkedApp.has(r.id)) continue;
    const key = (r.extracted?.bank_ref as string | undefined) ?? `row:${r.id}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  if (!groups.size) return { matched: [], waiting: [], ambiguous: [] };

  const dates = [...groups.values()].flat().map((r) => r.occurred_on).sort();
  const from = addDays(dates[0], -MATCH_WINDOW_DAYS);
  const to = addDays(dates.at(-1)!, MATCH_WINDOW_DAYS);
  const purchases = (await qbo.query(`select * from Purchase where TxnDate >= '${from}' and TxnDate <= '${to}'`))
    .filter((p) => !usedQbo.has(p.Id));
  const links = await projectLinks(admin, company);
  // The internal "DC Solar Company" job is overhead in QuickBooks, never a project.
  const { data: internalJobs } = await admin.from('jobs').select('id').eq('company', company).eq('is_internal', true);
  const internal = new Set(((internalJobs ?? []) as { id: string }[]).map((j) => j.id));

  const matched: unknown[] = [];
  const waiting: unknown[] = [];
  const ambiguous: unknown[] = [];
  const claimed = new Set<string>();

  for (const [key, group] of groups) {
    const total = money(group.reduce((s, r) => s + num(r.amount), 0));
    const date = /^\d{4}-\d{2}-\d{2}\|/.test(key) ? key.slice(0, 10) : group.map((r) => r.occurred_on).sort()[0];
    const candidates = purchases
      .filter((p) => !claimed.has(p.Id) && Math.abs(money(num(p.TotalAmt)) - total) < 0.005 && dayDiff(p.TxnDate, date) <= MATCH_WINDOW_DAYS)
      .sort((a, b) => dayDiff(a.TxnDate, date) - dayDiff(b.TxnDate, date));
    const summary = { key, total, date, appIds: group.map((r) => r.id), description: group[0].description };
    if (!candidates.length) {
      waiting.push(summary); // its bank line is not in QuickBooks yet — never create it
      continue;
    }
    // Two equal-amount bank lines the same distance away: don't guess.
    if (candidates.length > 1 && dayDiff(candidates[1].TxnDate, date) === dayDiff(candidates[0].TxnDate, date)) {
      ambiguous.push({ ...summary, qboIds: candidates.slice(0, 3).map((c) => c.Id) });
      continue;
    }
    const target = candidates[0];
    claimed.add(target.Id);
    if (!dryRun && keys && !keys.has(key)) {
      matched.push({ ...summary, qboId: target.Id, qboDate: target.TxnDate, action: 'not chosen' });
      continue;
    }
    const jobs = [...new Set(group.map((r) => r.job_id).filter((id) => id && !internal.has(id)))] as string[];
    const alreadyTagged = (target.Line ?? []).some((l: any) => l.AccountBasedExpenseLineDetail?.CustomerRef?.value);
    let action = 'linked';
    if (!dryRun) {
      // Stamp the job only when the app knows ONE job for the whole bank line and QuickBooks has none yet.
      if (jobs.length === 1 && !alreadyTagged) {
        const customerId = links.byJob.get(jobs[0]) ?? (await ensureProject(qbo, admin, company, jobs[0]));
        await tagTransaction(qbo, 'Purchase', target.Id, 'all', customerId, `App: ${group.map((r) => r.id.slice(0, 8)).join(',')}`);
        action = 'tagged';
      }
      await admin.from('qbo_links').upsert({
        company, app_kind: 'feed_match', app_key: key, qbo_type: 'Purchase', qbo_id: target.Id,
        app_ids: group.map((r) => r.id), synced_at: new Date().toISOString(),
      });
    } else if (jobs.length === 1 && !alreadyTagged) {
      action = 'would tag';
    }
    matched.push({ ...summary, qboId: target.Id, qboDate: target.TxnDate, action });
  }
  return { matched, waiting, ambiguous };
}


// ---------------------------------------------------------------- payroll → jobs

/**
 * Gusto's withdrawals arrive through the Chase feed as ONE "Payroll expenses"
 * purchase per run. This rewrites that purchase's lines — same total, same
 * bank match, no new transaction — the way the 2026-10-14 import split payroll:
 *
 *   Job labor (COGS), one line per job      that job's logged labor cost in the period
 *                                           (hours × pay rate; scaled down only if the
 *                                           logged cost is more than the run's gross)
 *   Office & overhead wages                 the rest of gross — hours not on a job AND any
 *                                           extra hours Gusto paid beyond what was logged
 *                                           (Devon 2026-11-21: app hours are accurate; extra
 *                                           paid hours are office overhead)
 *   Payroll taxes (employer)                withdrawn − gross
 *   reimbursement lines                     expenses paid back inside the run
 *                                           (finance_entries.extracted.paid_via_payroll)
 *
 * Labor cost = logged hours (employee_hours) + clocked shifts (time_entries) ×
 * pay rate, within the run's pay period. A run needs a payroll_runs row (gross
 * + withdrawn, from the Gusto receipt); feed payroll lines without one are
 * reported, not touched. Links: qbo_links app_kind 'payroll_split', key = run id.
 */
type Run = { id: string; period_start: string; period_end: string; payday: string; gross_wages: number; total_withdrawn: number; kind: string; notes: string | null; reimbursements: number | null; receipt_id: string | null };

/** lib/books.ts BOOK_ACCOUNTS key → QuickBooks account (the overhead ones a reimbursed receipt uses). */
const BOOK_ACCOUNT_QBO: Record<string, string> = {
  job_materials: 'Job materials', job_fuel: 'Job fuel & travel', fuel: 'Vehicle expenses:Fuel',
  vehicle_repairs: 'Vehicle expenses:Vehicle repairs & maintenance', tools: 'Tools & small equipment', supplies: 'Supplies',
  job_equipment_rental: 'Job equipment rental', meals: 'Meals',
};

export async function splitPayroll(qbo: Qbo, admin: SupabaseClient, company: string, dryRun: boolean, runIds: Set<string> | null, force = false) {
  const [runsRes, reimbRes, hoursRes, clocksRes, empRes, jobsRes, linksRes] = await Promise.all([
    admin.from('payroll_runs').select('*').eq('company', company).gte('payday', FEED_START).order('payday'),
    admin.from('finance_entries').select('id, amount, job_id, description, extracted').eq('company', company).eq('type', 'expense').neq('status', 'void').not('extracted->>paid_via_payroll', 'is', null),
    admin.from('employee_hours').select('employee, email, job_id, occurred_on, hours, rate').eq('company', company).gte('occurred_on', addDays(FEED_START, -40)),
    admin.from('time_entries').select('employee, job_id, clock_in, clock_out').eq('company', company).not('clock_out', 'is', null).gte('clock_in', `${addDays(FEED_START, -40)}T00:00:00Z`),
    admin.from('employees').select('email, display_name, pay_rate').eq('company', company),
    admin.from('jobs').select('id, job_number, name, is_internal, customer_id, stage').eq('company', company),
    // A run the 10/14 import already booked as a split journal entry counts as done too.
    admin.from('qbo_links').select('app_kind, app_key, qbo_id').eq('company', company).in('app_kind', ['payroll_split', 'journal']),
  ]);
  const runs = (runsRes.data ?? []) as Run[];
  const periodGross = new Map<string, number>();
  for (const r of runs) {
    if (r.kind === 'off_cycle' && /for [A-Z][a-z]+ [A-Z][a-z]+/.test(r.notes ?? '')) continue; // one person's off-cycle stands alone
    const k = `${r.period_start}|${r.period_end}`;
    periodGross.set(k, money((periodGross.get(k) ?? 0) + num(r.gross_wages)));
  }
  const reimbByReceipt = new Map<string, AppExpense[]>();
  for (const e of (reimbRes.data ?? []) as AppExpense[]) {
    const key = String(e.extracted?.paid_via_payroll ?? '');
    reimbByReceipt.set(key, [...(reimbByReceipt.get(key) ?? []), e]);
  }
  const rateOf = new Map(((empRes.data ?? []) as { email: string; pay_rate: number }[]).map((e) => [e.email?.toLowerCase(), Number(e.pay_rate) || 0]));
  const nameToEmail = new Map(((empRes.data ?? []) as { email: string; display_name: string }[]).map((e) => [e.display_name?.toLowerCase(), e.email?.toLowerCase()]));
  const jobs = new Map(((jobsRes.data ?? []) as JobRef[]).map((j) => [j.id, j]));
  const onJob = (id: string | null) => !!id && !!jobs.get(id) && !jobs.get(id)!.is_internal;
  const linkRows = (linksRes.data ?? []) as { app_kind: string; app_key: string; qbo_id: string }[];
  const done = new Map(linkRows.map((l) => [l.app_key, l.qbo_id]));
  // Runs this function split before (not import journals) can be re-split with `force`.
  const splitLinks = new Map(linkRows.filter((l) => l.app_kind === 'payroll_split').map((l) => [l.app_key, l.qbo_id]));
  // Runs the 10/14 import booked as journal entries; `force` re-splits their wage lines in place.
  const journalLinks = new Map(linkRows.filter((l) => l.app_kind === 'journal').map((l) => [l.app_key, l.qbo_id]));
  const localDay = (ts: string) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

  const labor: { email: string; jobId: string | null; day: string; hours: number; cost: number }[] = [];
  for (const h of (hoursRes.data ?? []) as any[]) {
    const email = String(h.email ?? h.employee ?? '').toLowerCase();
    const hours = num(h.hours);
    labor.push({ email, jobId: h.job_id, day: h.occurred_on, hours, cost: hours * (num(h.rate) || rateOf.get(email) || 0) });
  }
  for (const c of (clocksRes.data ?? []) as any[]) {
    const email = String(c.employee ?? '').toLowerCase();
    const hours = Math.max(0, (Date.parse(c.clock_out) - Date.parse(c.clock_in)) / 3_600_000);
    labor.push({ email, jobId: c.job_id, day: localDay(c.clock_in), hours, cost: hours * (rateOf.get(email) || 0) });
  }

  const accounts = await accountsByName(qbo);
  const acct = (name: string) => {
    const a = accounts.get(name);
    if (!a) throw new QboError(500, `QuickBooks account "${name}" is missing.`);
    return { value: a.Id, name: a.Name };
  };
  const payrollAcct = accounts.get('Payroll expenses');
  const feed = payrollAcct
    ? (await qbo.query(`select * from Purchase where TxnDate >= '${addDays(FEED_START, -2)}'`)).filter((p) => {
        const lines = (p.Line ?? []).filter((l: any) => l.AccountBasedExpenseLineDetail);
        const isFee = /\bfee/i.test(`${p.PrivateNote ?? ''} ${lines[0]?.Description ?? ''}`); // "Chase Payroll Fee" is a bank fee, not a run
        return !isFee && lines.length === 1 && lines[0].AccountBasedExpenseLineDetail.AccountRef?.value === payrollAcct.Id && !lines[0].AccountBasedExpenseLineDetail.CustomerRef;
      })
    : [];
  const claimed = new Set(done.values());
  const results: Record<string, unknown>[] = [];

  for (const run of runs) {
    if (runIds && !runIds.has(run.id)) continue;
    const journalId = force ? journalLinks.get(run.id) : undefined;
    if (done.has(run.id) && !(force && (splitLinks.has(run.id) || journalId))) {
      results.push({ runId: run.id, payday: run.payday, status: 'already split', qboId: done.get(run.id) });
      continue;
    }
    const gross = money(num(run.gross_wages));
    const withdrawn = money(num(run.total_withdrawn));
    const forced = force && splitLinks.has(run.id) ? (await qbo.get(`purchase/${splitLinks.get(run.id)}`)).Purchase : null;
    const je = journalId ? (await qbo.get(`journalentry/${journalId}`)).JournalEntry : null;
    const target = je ? { Id: je.Id, TxnDate: je.TxnDate, TotalAmt: 0 } : forced ?? feed
      .filter((p) => !claimed.has(p.Id) && Math.abs(money(num(p.TotalAmt)) - money(withdrawn + money(num(run.reimbursements)))) < 0.005 && dayDiff(p.TxnDate, run.payday) <= 7)
      .sort((a, b) => dayDiff(a.TxnDate, run.payday) - dayDiff(b.TxnDate, run.payday))[0];
    if (!target) {
      results.push({ runId: run.id, payday: run.payday, withdrawn: money(withdrawn + money(num(run.reimbursements))), status: 'no matching Chase payroll line in QuickBooks yet' });
      continue;
    }
    claimed.add(target.Id);
    const only = run.kind === 'off_cycle' ? nameToEmail.get((run.notes ?? '').match(/for ([A-Z][a-z]+ [A-Z][a-z]+)/)?.[1]?.toLowerCase() ?? '') : null;
    // Several runs can pay the same period (a regular run + a correction run). The period's
    // logged job cost is booked ONCE across them, each run taking its share of the gross.
    const periodKey = `${run.period_start}|${run.period_end}`;
    const share = only ? 1 : gross / (periodGross.get(periodKey) || gross);
    const inPeriod = labor.filter((l) => l.day >= run.period_start && l.day <= run.period_end && (!only || l.email === only));
    const byJob = new Map<string, { cost: number; hours: number }>();
    for (const l of inPeriod) {
      if (!onJob(l.jobId)) continue;
      const cur = byJob.get(l.jobId!) ?? { cost: 0, hours: 0 };
      byJob.set(l.jobId!, { cost: cur.cost + l.cost, hours: cur.hours + l.hours });
    }
    type Out = { account: string; amount: number; jobId?: string; description: string };
    const out: Out[] = [];
    let allocated = 0;
    const jobCost = [...byJob.values()].reduce((s, v) => s + v.cost, 0);
    const periodTotal = only ? gross : periodGross.get(periodKey) || gross;
    const scale = (jobCost > periodTotal ? periodTotal / jobCost : 1) * share;
    if (jobCost > 0) {
      for (const [jobId, v] of [...byJob.entries()].sort()) {
        const amount = money(v.cost * scale);
        if (amount <= 0) continue;
        allocated = money(allocated + amount);
        out.push({ account: 'Job labor', amount, jobId, description: `${jobs.get(jobId)?.job_number ?? ''} labor, ${Math.round(v.hours * 10) / 10} h, ${run.period_start}–${run.period_end}` });
      }
    }
    if (gross - allocated > 0.004) out.push({ account: 'Payroll expenses:Office & overhead wages', amount: money(gross - allocated), description: 'Office & overhead: hours not on a job, and paid hours beyond those logged' });
    if (withdrawn - gross > 0.004) out.push({ account: 'Payroll expenses:Payroll taxes (employer)', amount: money(withdrawn - gross), description: 'Employer payroll taxes' });
    // Rounding only (cents): true the lines up to the withdrawal on the largest one.
    const drift = money(withdrawn - out.reduce((s, l) => s + l.amount, 0));
    if (drift !== 0 && out.length) {
      const big = out.reduce((a, b) => (b.amount > a.amount ? b : a));
      big.amount = money(big.amount + drift);
    }
    // Expenses paid back inside this run ride on the same bank line.
    const reimbursed = run.receipt_id ? reimbByReceipt.get(run.receipt_id) ?? [] : [];
    for (const e of reimbursed) {
      out.push({ account: BOOK_ACCOUNT_QBO[(e.extracted?.book_account as string) ?? ''] ?? 'Supplies', amount: money(num(e.amount)), jobId: onJob(e.job_id) ? e.job_id! : undefined, description: `Reimbursed: ${e.description ?? ''}`.slice(0, 200) });
    }
    const reimbTotal = money(num(run.reimbursements));
    const reimbBooked = money(reimbursed.reduce((s, e) => s + num(e.amount), 0));
    if (!journalId && reimbTotal - reimbBooked > 0.004) out.push({ account: 'Payroll expenses:Office & overhead wages', amount: money(reimbTotal - reimbBooked), description: 'Reimbursement paid beyond the receipts on file' });
    const bankOut = money(withdrawn + reimbTotal);
    const summary = {
      runId: run.id, payday: run.payday, period: `${run.period_start}–${run.period_end}`, gross, withdrawn: bankOut, qboId: target.Id, qboDate: target.TxnDate,
      lines: out.map((l) => ({ account: l.account, amount: l.amount, job: l.jobId ? jobs.get(l.jobId)?.job_number : null })),
    };
    if (dryRun) {
      results.push({ ...summary, status: 'would split' });
      continue;
    }
    if (je) {
      // Keep every line that is not wages / employer tax (the reimbursement debit, the bank
      // credit) exactly as it is; replace the wage and tax debits with the new split.
      const payrollNames = new Set(['Job labor', 'Payroll expenses:Office & overhead wages', 'Payroll expenses:Payroll taxes (employer)']);
      const payrollIds = new Set([...payrollNames].map((n) => accounts.get(n)?.Id).filter(Boolean));
      const kept = (je.Line ?? []).filter((l: any) => !(l.JournalEntryLineDetail?.PostingType === 'Debit' && payrollIds.has(l.JournalEntryLineDetail?.AccountRef?.value)));
      const wageLines = [];
      for (const l of out.filter((o) => payrollNames.has(o.account))) {
        const customer = l.jobId ? (await projectLinks(admin, company)).byJob.get(l.jobId) ?? (await ensureProject(qbo, admin, company, l.jobId)) : null;
        wageLines.push({
          Amount: l.amount, DetailType: 'JournalEntryLineDetail', Description: l.description.slice(0, 4000),
          JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: acct(l.account), ...(customer ? { Entity: { Type: 'Customer', EntityRef: { value: customer } } } : {}) },
        });
      }
      const lines = [...wageLines, ...kept];
      const dr = money(lines.filter((l: any) => l.JournalEntryLineDetail.PostingType === 'Debit').reduce((s2: number, l: any) => s2 + num(l.Amount), 0));
      const cr = money(lines.filter((l: any) => l.JournalEntryLineDetail.PostingType === 'Credit').reduce((s2: number, l: any) => s2 + num(l.Amount), 0));
      if (Math.abs(dr - cr) > 0.004) throw new QboError(409, `Journal ${je.Id}: debits ${dr} ≠ credits ${cr}`);
      if (dryRun) {
        results.push({ ...summary, qboId: `JE ${je.Id}`, status: 'would re-split journal' });
        continue;
      }
      je.Line = lines;
      je.PrivateNote = [je.PrivateNote, 'Re-split 2026-11-21: logged job hours → Job labor, extra paid hours → overhead'].filter(Boolean).join(' | ').slice(0, 4000);
      const savedJe = (await qbo.post('journalentry', je)).JournalEntry;
      results.push({ ...summary, qboId: `JE ${savedJe.Id}`, status: 're-split journal' });
      continue;
    }
    const keepId = (target.Line ?? []).find((l: any) => l.AccountBasedExpenseLineDetail)?.Id;
    if (Math.abs(money(num(target.TotalAmt)) - bankOut) > 0.004) throw new QboError(409, `Run ${run.payday}: lines ${bankOut} ≠ bank line ${target.TotalAmt}`);
    const newLines = [];
    for (const [i, l] of out.entries()) {
      const customer = l.jobId ? (await projectLinks(admin, company)).byJob.get(l.jobId) ?? (await ensureProject(qbo, admin, company, l.jobId)) : null;
      newLines.push({
        ...(i === 0 && keepId ? { Id: keepId } : {}), // keep the bank-feed match on the original line
        Amount: l.amount,
        DetailType: 'AccountBasedExpenseLineDetail',
        Description: l.description.slice(0, 4000),
        AccountBasedExpenseLineDetail: { AccountRef: acct(l.account), BillableStatus: 'NotBillable', ...(customer ? { CustomerRef: { value: customer } } : {}) },
      });
    }
    target.Line = newLines;
    target.PrivateNote = [target.PrivateNote, `Split to jobs by hours (app payroll run ${run.id.slice(0, 8)})`].filter(Boolean).join(' | ').slice(0, 4000);
    const saved = (await qbo.post('purchase', target)).Purchase;
    await admin.from('qbo_links').upsert({
      company, app_kind: 'payroll_split', app_key: run.id, qbo_type: 'Purchase', qbo_id: saved.Id, sync_token: saved.SyncToken,
      app_ids: [run.id], synced_at: new Date().toISOString(),
    });
    results.push({ ...summary, status: 'split' });
  }
  const unmatchedFeed = feed.filter((p) => !claimed.has(p.Id)).map((p) => ({ qboId: p.Id, date: p.TxnDate, amount: money(num(p.TotalAmt)), memo: p.PrivateNote ?? null }));
  return { runs: results, unmatchedFeed };
}

// ---------------------------------------------------------------- handler

// Served only when run as the function; scripts/qbo/books-check.ts imports the helpers above.
if (import.meta.main) Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'POST only');
  const env = readEnv();
  if (typeof env === 'string') return fail(500, 'not_configured', env);
  const admin = createClient(env.supabaseUrl, env.serviceKey);

  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: userData } = await admin.auth.getUser(jwt);
    const email = userData?.user?.email?.toLowerCase();
    if (!email) return fail(401, 'unauthorized', 'Not signed in.');
    const { data: employee } = await admin.from('employees').select('is_developer, role, company').eq('email', email).maybeSingle();
    const emp = employee as { is_developer?: boolean; role?: string; company?: string } | null;
    const role = emp?.is_developer ? 'owner' : emp?.role;
    if (role !== 'owner' && role !== 'operator') return fail(403, 'forbidden', 'Only an administrator can see the books.');
    const company = emp?.company ?? 'dc-solar';

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const end = isISO(body.end) ? body.end : todayCentral();
    const start = isISO(body.start) ? (body.start < BOOKS_START ? BOOKS_START : body.start) : `${end.slice(0, 4)}-01-01` < BOOKS_START ? BOOKS_START : `${end.slice(0, 4)}-01-01`;
    if (start > end) return fail(400, 'bad_request', 'start is after end.');

    const qbo = client(env, await liveConnection(env, admin, company));

    switch (body.action) {
      case 'overview':
        return ok(await overview(qbo, start, end));
      case 'jobs':
        return ok(await jobsReport(qbo, admin, company, start, end));
      case 'untagged':
        return ok(await untagged(qbo, admin, company, start, end));
      case 'assign': {
        const type = body.type === 'Bill' ? 'Bill' : body.type === 'Purchase' ? 'Purchase' : null;
        const id = typeof body.id === 'string' ? body.id : null;
        const lineId = typeof body.lineId === 'string' ? body.lineId : null;
        if (!type || !id || !lineId) return fail(400, 'bad_request', 'type, id and lineId are required.');
        const accountId = typeof body.accountId === 'string' ? body.accountId : undefined;
        if (body.overhead === true) {
          if (accountId) await tagTransaction(qbo, type, id, [lineId], null, `Category set in app by ${email}`, accountId);
          await admin.from('qbo_links').upsert({
            company, app_kind: 'overhead_ok', app_key: `${type}:${id}:${lineId}`, qbo_type: type, qbo_id: id,
            app_ids: [], synced_at: new Date().toISOString(),
          });
          return ok({ overhead: true });
        }
        if (typeof body.jobId !== 'string') return fail(400, 'bad_request', 'jobId (or overhead: true) is required.');
        const customerId = await ensureProject(qbo, admin, company, body.jobId);
        const saved = await tagTransaction(qbo, type, id, [lineId], customerId, `Job set in app by ${email}`, accountId);
        return ok({ id: saved.Id, syncToken: saved.SyncToken });
      }
      case 'match_app':
      {
        const keys = Array.isArray(body.keys) ? new Set(body.keys.filter((k): k is string => typeof k === 'string')) : null;
        // Writes only what Devon picked: a real run needs keys.
        if (body.dryRun !== true && !keys?.size) return fail(400, 'bad_request', 'Pick the matches to confirm (keys).');
        return ok(await matchApp(qbo, admin, company, body.dryRun === true, keys));
      }
      case 'split_payroll': {
        const runIds = Array.isArray(body.runIds) ? new Set(body.runIds.filter((k): k is string => typeof k === 'string')) : null;
        if (body.dryRun !== true && !runIds?.size) return fail(400, 'bad_request', 'Pick the payroll runs to split (runIds).');
        return ok(await splitPayroll(qbo, admin, company, body.dryRun === true, runIds));
      }
      default:
        return fail(400, 'bad_request', "action must be 'overview', 'jobs', 'untagged', 'assign', 'match_app' or 'split_payroll'.");
    }
  } catch (e) {
    if (e instanceof QboError) return fail(e.status, 'qbo', e.message);
    return fail(500, 'unexpected', e instanceof Error ? e.message : 'Unexpected error.');
  }
});
