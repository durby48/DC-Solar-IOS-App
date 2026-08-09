#!/usr/bin/env node
/**
 * Pull the balance and transactions from Chase via Plaid, and write the
 * statement JSON that scripts/reconcile/* already consume.
 *
 * This replaces converting a PDF by hand. It also updates the recorded bank
 * balance so the Cash Position panel stops going stale.
 *
 *   node scripts/plaid/sync.mjs                 # since the last sync
 *   node scripts/plaid/sync.mjs 2026-08-01      # from a date
 *
 * The statement is written OUTSIDE this repo — it is public.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(join(process.cwd(), 'app', 'package.json'));
const SECRETS = join(homedir(), 'Desktop', 'DC Solar LLC', 'secrets');
const CREDS = join(SECRETS, 'plaid.txt');
const TOKEN_FILE = join(SECRETS, 'plaid-access-token.txt');
const CURSOR_FILE = join(SECRETS, 'plaid-cursor.txt');

for (const [file, hint] of [
  [CREDS, 'Add your keys — see scripts/plaid/README.md'],
  [TOKEN_FILE, 'Run: node scripts/plaid/link.mjs'],
]) {
  if (!existsSync(file)) {
    console.error(`\nMissing ${file}\n  ${hint}\n`);
    process.exit(1);
  }
}

const creds = readFileSync(CREDS, 'utf8');
const CLIENT_ID = creds.match(/PLAID_CLIENT_ID\s*=\s*(\S+)/)[1];
const SECRET = creds.match(/PLAID_SECRET\s*=\s*(\S+)/)[1];
const ENV = (creds.match(/PLAID_ENV\s*=\s*(\S+)/)?.[1] ?? 'sandbox').toLowerCase();
const ACCESS_TOKEN = readFileSync(TOKEN_FILE, 'utf8').match(
  /PLAID_ACCESS_TOKEN\s*=\s*(\S+)/,
)[1];
const BASE = `https://${ENV}.plaid.com`;

async function plaid(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, secret: SECRET, ...body }),
  });
  const json = await res.json();
  if (!res.ok) {
    console.error(`\nPlaid ${path}: ${json.error_code} — ${json.error_message}\n`);
    process.exit(1);
  }
  return json;
}

const money = (n) =>
  `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// --- balance --------------------------------------------------------------
const { accounts } = await plaid('/accounts/balance/get', { access_token: ACCESS_TOKEN });
const checking =
  accounts.find((a) => a.subtype === 'checking') ?? accounts[0];
if (!checking) {
  console.error('No account returned by Plaid.');
  process.exit(1);
}
const balance = checking.balances.available ?? checking.balances.current;
console.log(`${checking.name} (…${checking.mask})  ${money(balance)}`);

// --- transactions ---------------------------------------------------------
// /transactions/sync is incremental: the cursor remembers where we stopped, so
// re-running never re-imports and never misses a late-posting charge.
let cursor = existsSync(CURSOR_FILE)
  ? readFileSync(CURSOR_FILE, 'utf8').trim() || undefined
  : undefined;
const added = [];
let hasMore = true;
while (hasMore) {
  const page = await plaid('/transactions/sync', {
    access_token: ACCESS_TOKEN,
    cursor,
    count: 500,
  });
  added.push(...page.added);
  cursor = page.next_cursor;
  hasMore = page.has_more;
}
writeFileSync(CURSOR_FILE, cursor ?? '');

const since = process.argv[2];
const inRange = since ? added.filter((t) => t.date >= since) : added;
// Plaid signs outflows POSITIVE on depository accounts, which is the opposite
// of what reads naturally — split rather than negate so the shape matches what
// the reconcile scripts expect.
const debits = inRange
  .filter((t) => t.amount > 0)
  .map((t) => ({ date: t.date.slice(5).replace('-', '/'), amount: t.amount, desc: t.name }));
const credits = inRange
  .filter((t) => t.amount < 0)
  .map((t) => ({ date: t.date.slice(5).replace('-', '/'), amount: -t.amount, desc: t.name }));

const period = (since ?? inRange[0]?.date ?? new Date().toISOString()).slice(0, 7);
const out = join(SECRETS, 'statements', `${period}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      period,
      from: since ?? undefined,
      closingBalance: Number(balance),
      debits,
      credits,
      // Filled in by hand from the Chase Payroll Business payments tab —
      // Plaid sees one lump debit and cannot split gross wages from taxes.
      payrollRuns: [],
      reimbursementChecks: [],
    },
    null,
    2,
  ) + '\n',
);

console.log(`${debits.length} debit(s), ${credits.length} credit(s) → ${out}`);

// --- record the balance so the app's Cash Position panel stays current -----
try {
  const { createClient } = require('@supabase/supabase-js');
  const block = readFileSync(
    join(SECRETS, 'supabase-service-role-keys.txt'),
    'utf8',
  ).split('Mobile Mulligans')[0];
  const db = createClient(
    block.match(/NEXT_PUBLIC_SUPABASE_URL\s*=\s*(\S+)/)[1],
    block.match(/SUPABASE_SERVICE_ROLE_KEY\s*=\s*(\S+)/)[1],
    { auth: { persistSession: false } },
  );
  const { error } = await db
    .from('company_settings')
    .update({
      bank_balance: Number(balance),
      bank_balance_as_of: new Date().toISOString().slice(0, 10),
      updated_by: 'plaid sync',
    })
    .eq('company', 'dc-solar');
  console.log(error ? `Balance not recorded: ${error.message}` : 'Balance recorded in the app.');
} catch (e) {
  console.log(`Balance not recorded: ${e.message}`);
}

console.log(`\nNext:\n  node scripts/reconcile/duplicates.mjs\n  node scripts/reconcile/match.mjs ${out}\n  node scripts/reconcile/bridge.mjs ${out}\n`);
