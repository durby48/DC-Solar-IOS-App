// Shared plumbing for the reconciliation scripts.
//
// The service-role key is read from outside this repo at runtime. Never inline
// it, never echo it, never write it to a file inside the working tree — this
// repository is public.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(join(process.cwd(), 'app', 'package.json'));

const SECRETS = join(homedir(), 'Desktop', 'DC Solar LLC', 'secrets');
export const COMPANY = 'dc-solar';

/** Supabase client with the service-role key, loaded from the secrets folder. */
export function db() {
  const { createClient } = require('@supabase/supabase-js');
  let block;
  try {
    block = readFileSync(
      join(SECRETS, 'supabase-service-role-keys.txt'),
      'utf8',
    ).split('Mobile Mulligans')[0];
  } catch {
    fail(
      `Could not read credentials from ${SECRETS}.\n` +
        'They are deliberately outside this repo — see scripts/reconcile/README.md.',
    );
  }
  const url = block.match(/NEXT_PUBLIC_SUPABASE_URL\s*=\s*(\S+)/)?.[1];
  const key = block.match(/SUPABASE_SERVICE_ROLE_KEY\s*=\s*(\S+)/)?.[1];
  if (!url || !key) fail('Credentials file did not contain a URL and key.');
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Load a statement JSON file. Path must be supplied on the command line. */
export function loadStatement(argv) {
  const path = argv[2];
  if (!path) {
    fail(
      'Usage: node scripts/reconcile/<script>.mjs <statement.json>\n' +
        'Keep statements OUTSIDE this repo — it is public.',
    );
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    fail(`Could not read statement file: ${path}`);
  }
  const s = JSON.parse(raw);
  for (const field of ['debits', 'credits']) {
    if (!Array.isArray(s[field])) fail(`Statement is missing "${field}" array.`);
  }
  s.payrollRuns ??= [];
  s.reimbursementChecks ??= [];
  return s;
}

export const money = (n) =>
  `$${Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export const cents = (n) => Math.round(Number(n) * 100) / 100;

export function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/** Every expense row, with its job number resolved. */
export async function fetchExpenses(client, { from, to } = {}) {
  let q = client
    .from('finance_entries')
    .select('id, occurred_on, amount, description, job_id, type, direction')
    .eq('company', COMPANY)
    .eq('type', 'expense');
  if (from) q = q.gte('occurred_on', from);
  if (to) q = q.lte('occurred_on', to);
  const { data, error } = await q;
  if (error) fail(`Query failed: ${error.message}`);

  const { data: jobs } = await client
    .from('jobs')
    .select('id, job_number, is_internal')
    .eq('company', COMPANY);
  const numberOf = new Map((jobs ?? []).map((j) => [j.id, j.job_number]));

  return (data ?? []).map((r) => ({
    id: r.id,
    date: r.occurred_on,
    amount: cents(r.amount),
    desc: r.description ?? '',
    job: numberOf.get(r.job_id) ?? '(none)',
  }));
}

/** Totals the bridge needs, all in one round trip. */
export async function fetchTotals(client) {
  const sumOf = async (type, direction) => {
    let q = client
      .from('finance_entries')
      .select('amount')
      .eq('company', COMPANY)
      .eq('type', type);
    if (direction) q = q.eq('direction', direction);
    const { data, error } = await q;
    if (error) fail(`Query failed: ${error.message}`);
    return (data ?? []).reduce((s, r) => s + Number(r.amount), 0);
  };
  const { data: hours } = await client
    .from('employee_hours')
    .select('hours, rate, occurred_on')
    .eq('company', COMPANY);

  return {
    payments: await sumOf('payment'),
    expenses: await sumOf('expense'),
    capitalIn: await sumOf('investment', 'in'),
    capitalOut: await sumOf('investment', 'out'),
    hours: hours ?? [],
  };
}
