// Read-only check of the qbo-books function's logic against the live books, from a
// workstation (2026-11-21). Runs overview / jobs / untagged and match_app as a DRY RUN —
// writes nothing to QuickBooks (a token refresh is saved back to qbo_connections, as the
// function itself does).
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=<secret key> QBO_CLIENT_ID=… QBO_CLIENT_SECRET=… \
//   deno run -A scripts/qbo/books-check.ts [start] [end]
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { client, jobsReport, liveConnection, matchApp, overview, readEnv, untagged } from '../../supabase/functions/qbo-books/index.ts';

const env = readEnv();
if (typeof env === 'string') throw new Error(env);
const admin = createClient(env.supabaseUrl, env.serviceKey);
const qbo = client(env, await liveConnection(env, admin, 'dc-solar'));
const start = Deno.args[0] ?? '2026-06-26';
const end = Deno.args[1] ?? new Date().toISOString().slice(0, 10);

const o = await overview(qbo, start, end);
console.log(JSON.stringify({ headline: o.headline, months: o.months }, null, 1));
const j = await jobsReport(qbo, admin, 'dc-solar', start, end);
console.log(`jobs: ${j.rows.length} columns; unmatched to app: ${j.rows.filter((r: any) => !r.jobId).map((r: any) => r.title).join(' | ')}`);
console.log(JSON.stringify(j.rows.slice(0, 5), null, 1));
const u = await untagged(qbo, admin, 'dc-solar', start, end);
console.log(`untagged lines: ${u.lines.length}, with hint: ${u.lines.filter((l) => l.suggestion).length}, accounts: ${u.accounts.length}`);
console.log(JSON.stringify(u.lines.slice(0, 6), null, 1));
const m = await matchApp(qbo, admin, 'dc-solar', true, null);
console.log(`match_app dry run: matched ${m.matched.length}, waiting ${m.waiting.length}, ambiguous ${m.ambiguous.length}`);
console.log(JSON.stringify(m, null, 1).slice(0, 3000));
