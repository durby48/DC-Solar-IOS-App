#!/usr/bin/env node
/**
 * One-time: connect the Chase account through Plaid Link.
 *
 * Serves a small page locally, opens it, and waits. YOU log into Chase on
 * Chase's own OAuth page — the credentials never reach this script, this
 * machine's disk, or anybody helping you run it. Plaid hands back a
 * `public_token`, which this exchanges for a long-lived `access_token` and
 * writes to the secrets folder outside the repo.
 *
 * Run again only if the connection breaks or you re-link the account.
 *
 *   node scripts/plaid/link.mjs
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const SECRETS = join(homedir(), 'Desktop', 'DC Solar LLC', 'secrets');
const CREDS = join(SECRETS, 'plaid.txt');
const TOKEN_FILE = join(SECRETS, 'plaid-access-token.txt');
const PORT = 8712;

if (!existsSync(CREDS)) {
  console.error(`
No Plaid credentials found at:
  ${CREDS}

Create that file with your keys from https://dashboard.plaid.com/developers/keys:

  PLAID_CLIENT_ID=...
  PLAID_SECRET=...
  PLAID_ENV=sandbox        # sandbox | production

Sandbox works immediately with fake data. Real Chase needs Production access,
which Plaid grants on request — Chase uses OAuth and is not available against
sandbox credentials.
`);
  process.exit(1);
}

const creds = readFileSync(CREDS, 'utf8');
const CLIENT_ID = creds.match(/PLAID_CLIENT_ID\s*=\s*(\S+)/)?.[1];
const SECRET = creds.match(/PLAID_SECRET\s*=\s*(\S+)/)?.[1];
const ENV = (creds.match(/PLAID_ENV\s*=\s*(\S+)/)?.[1] ?? 'sandbox').toLowerCase();
if (!CLIENT_ID || !SECRET) {
  console.error('plaid.txt must contain PLAID_CLIENT_ID and PLAID_SECRET.');
  process.exit(1);
}
const BASE = `https://${ENV}.plaid.com`;

async function plaid(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, secret: SECRET, ...body }),
  });
  const json = await res.json();
  if (!res.ok) {
    console.error(`\nPlaid ${path} failed: ${json.error_code} — ${json.error_message}\n`);
    process.exit(1);
  }
  return json;
}

console.log(`Plaid environment: ${ENV}`);
const { link_token } = await plaid('/link/token/create', {
  user: { client_user_id: 'dc-solar-owner' },
  client_name: 'DC Solar KC',
  products: ['transactions'],
  country_codes: ['US'],
  language: 'en',
  // Chase requires OAuth; Plaid needs this registered on your dashboard under
  // Team Settings → API → Allowed redirect URIs before production linking.
  redirect_uri: ENV === 'production' ? `http://localhost:${PORT}/oauth` : undefined,
});

const page = `<!doctype html><meta charset="utf-8">
<title>Connect Chase — DC Solar KC</title>
<style>
  body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#3D352E}
  h1{font-size:1.4rem;margin-bottom:.4rem}
  p{color:#6B5D4F}
  button{background:#FFB066;border:0;border-radius:999px;padding:.85rem 1.6rem;font:inherit;font-weight:700;cursor:pointer}
  .done{color:#2f7d5d;font-weight:700}
  .err{color:#b3402f;font-weight:700}
</style>
<h1>Connect your Chase account</h1>
<p>You'll sign in on Chase's own page. Your username and password go to Chase,
not to this tool — it only receives read access to balances and transactions.</p>
<button id="go">Connect Chase</button>
<p id="status"></p>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
  const status = document.getElementById('status');
  const handler = Plaid.create({
    token: ${JSON.stringify(link_token)},
    onSuccess: async (public_token) => {
      status.textContent = 'Linked. Exchanging token…';
      const r = await fetch('/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_token }),
      });
      status.className = r.ok ? 'done' : 'err';
      status.textContent = r.ok
        ? 'Connected. You can close this tab and return to the terminal.'
        : 'Exchange failed — check the terminal.';
    },
    onExit: (err) => {
      if (err) { status.className = 'err'; status.textContent = 'Cancelled: ' + err.error_message; }
    },
  });
  document.getElementById('go').onclick = () => handler.open();
</script>`;

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/exchange') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { public_token } = JSON.parse(body);
    const out = await plaid('/item/public_token/exchange', { public_token });
    writeFileSync(
      TOKEN_FILE,
      `# Plaid access token for the Chase account. Read-only.\n` +
        `# NEVER copy this into a git repo — DC-Solar-IOS-App is public.\n` +
        `PLAID_ACCESS_TOKEN=${out.access_token}\nPLAID_ITEM_ID=${out.item_id}\n`,
    );
    console.log(`\nAccess token saved to ${TOKEN_FILE}`);
    console.log('Next: node scripts/plaid/sync.mjs\n');
    res.writeHead(200).end('{"ok":true}');
    setTimeout(() => server.close(() => process.exit(0)), 500);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' }).end(page);
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nOpening ${url} — sign in to Chase there.`);
  console.log('Waiting for you to finish…\n');
  spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
});
