// Split Gusto's Chase-feed payroll lines in QuickBooks to jobs by hours (2026-11-21).
// Dry run by default; `--apply` writes. Same logic as the qbo-books 'split_payroll' action.
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=<secret key> QBO_CLIENT_ID=… QBO_CLIENT_SECRET=… \
//   deno run -A scripts/qbo/split-payroll.ts [--apply] [runId …]
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { client, liveConnection, readEnv, splitPayroll } from '../../supabase/functions/qbo-books/index.ts';

const env = readEnv();
if (typeof env === 'string') throw new Error(env);
const admin = createClient(env.supabaseUrl, env.serviceKey);
const qbo = client(env, await liveConnection(env, admin, 'dc-solar'));
const apply = Deno.args.includes('--apply');
const ids = Deno.args.filter((a) => !a.startsWith('--'));
const res = await splitPayroll(qbo, admin, 'dc-solar', !apply, ids.length ? new Set(ids) : null);
console.log(JSON.stringify(res, null, 1));
