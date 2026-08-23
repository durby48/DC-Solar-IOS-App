/**
 * card-forge calibration — do the stat rules still reproduce the printed set?
 *
 * Runs `statsForJob()` from supabase/functions/card-forge/index.ts over the
 * LIVE job record behind every printed job card and diffs the result against
 * what is actually printed on that card (panels, kW, kWh, difficulty, reward,
 * rarity, location, service type). docs/CARD_FORGE.md, "How well it fits",
 * lists the residuals this should report and why each one is there. Run it
 * after touching the rules, the job data they read, or `cityOf()`.
 *
 * It imports the function's OWN code rather than a copy of the rules: the
 * source is read, everything from `Deno.serve(` down is cut off, the jsr
 * import is stubbed, and the pure helpers are exported and loaded through
 * Node's built-in TypeScript type-stripping (Node ≥ 22.18). No transpiler, no
 * npm install — `node scripts/tcg/calibrate.mjs` is the whole thing.
 *
 * Reads the service-role key from OUTSIDE this repo (the repository is
 * public), exactly like import.mjs. Nothing is written anywhere. Street
 * addresses are read (cityOf needs them) but never printed — only the city the
 * function would put on the card, plus a digit check on it.
 *
 *   node scripts/tcg/calibrate.mjs                 # every printed job card
 *   node scripts/tcg/calibrate.mjs --job DC-26019  # one job
 *   node scripts/tcg/calibrate.mjs --misses        # residuals only
 *   node scripts/tcg/calibrate.mjs --secrets <dir> # where the key file lives
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCTION_SOURCE = join(HERE, '..', '..', 'supabase', 'functions', 'card-forge', 'index.ts');
const DEFAULT_SECRETS = 'C:\\Durbin Enterprises\\config\\secrets';
const COMPANY = 'dc-solar';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { secrets: DEFAULT_SECRETS, job: null, misses: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--secrets') args.secrets = argv[++i];
    else if (a === '--job') args.job = String(argv[++i] ?? '').trim().toUpperCase();
    else if (a === '--misses') args.misses = true;
    else if (a === '--help' || a === '-h') {
      console.log(
        'node scripts/tcg/calibrate.mjs [--job DC-26019] [--misses] [--secrets <dir>]',
      );
      process.exit(0);
    } else fail(`Unknown argument: ${a}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// The function's pure half, loaded from its own source
// ---------------------------------------------------------------------------

async function loadRules() {
  let src = readFileSync(FUNCTION_SOURCE, 'utf8').replace(/\r\n/g, '\n');

  const cut = src.indexOf('\nDeno.serve(');
  if (cut < 0) fail('card-forge/index.ts: could not find `Deno.serve(` — the harness needs updating.');
  src = src.slice(0, cut);

  const jsrImport = /^import \{ createClient \} from 'jsr:@supabase\/supabase-js@2';[ \t]*$/m;
  if (!jsrImport.test(src)) fail('card-forge/index.ts: the supabase-js import moved — the harness needs updating.');
  src = src.replace(
    jsrImport,
    'const createClient = () => { throw new Error("createClient is not available in the calibration harness"); };',
  );

  // Anything left that needs the Deno runtime means the cut landed wrong.
  if (/\bDeno\b/.test(src) || /from 'jsr:/.test(src)) {
    fail('card-forge/index.ts: Deno/jsr references survive above Deno.serve — the harness needs updating.');
  }

  src += '\nexport { statsForJob, cityOf };\n';

  const dir = mkdtempSync(join(tmpdir(), 'card-forge-calibrate-'));
  const file = join(dir, 'card-forge-pure.ts');
  writeFileSync(file, src);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Live data, read-only, service role (same key file as import.mjs)
// ---------------------------------------------------------------------------

function credentials(secretsDir) {
  let block;
  try {
    block = readFileSync(join(secretsDir, 'supabase-service-role-keys.txt'), 'utf8')
      .split('Mobile Mulligans')[0]; // DC Solar's block comes first.
  } catch {
    fail(
      `Could not read credentials from ${secretsDir}.\n` +
        'They are deliberately outside this repo — pass --secrets <dir>.',
    );
  }
  const url = block.match(/NEXT_PUBLIC_SUPABASE_URL\s*=\s*(\S+)/)?.[1];
  const key = block.match(/SUPABASE_SERVICE_ROLE_KEY\s*=\s*(\S+)/)?.[1];
  if (!url || !key) fail('Credentials file did not contain a URL and a key.');
  return { url: url.replace(/\/+$/, ''), key };
}

async function rest({ url, key }, path) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) fail(`GET ${path.split('?')[0]} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const rules = await loadRules();
const creds = credentials(args.secrets);

const [jobs, cards] = await Promise.all([
  rest(
    creds,
    `jobs?company=eq.${COMPANY}&select=id,job_number,address,stage,job_type,module_count,module_watts,has_critter_guard,critter_guard_panels,completed_on,is_internal&order=job_number`,
  ),
  rest(
    creds,
    `cards?company=eq.${COMPANY}&card_type=eq.job&select=id,title,job_id,job_number,rarity,panels,kw_dc,annual_kwh,difficulty,reward_kw,location,service_type,archived_at&order=sort_order`,
  ),
]);

const byId = new Map(jobs.map((j) => [j.id, j]));
const byNumber = new Map(jobs.map((j) => [j.job_number?.trim().toUpperCase(), j]));

const num = (v) => (v === null || v === undefined ? null : Number(v));

let exact = 0;
let compared = 0;
let unmatched = 0;
const lines = [];
const residuals = [];

for (const card of cards) {
  const number = card.job_number?.trim().toUpperCase() ?? null;
  if (args.job && number !== args.job) continue;

  const job = (card.job_id && byId.get(card.job_id)) || (number && byNumber.get(number)) || null;
  if (!job) {
    unmatched++;
    // A card outlives the job it was drawn from (delete_job never touches
    // cards), so this is a data fact, not a failure — nothing to diff against.
    lines.push(`${(number ?? card.id).padEnd(9)} | ${card.title.slice(0, 30).padEnd(30)} | no job record behind this card any more — skipped`);
    continue;
  }

  const s = rules.statsForJob(job);
  compared++;

  const diffs = [];
  const cmp = (name, got, want) => {
    if (num(got) !== num(want)) diffs.push(`${name} ${num(got)} vs ${num(want)}`);
  };
  cmp('panels', s.panels, card.panels);
  cmp('kW', s.kw_dc, card.kw_dc);
  cmp('kWh', s.annual_kwh, card.annual_kwh);
  cmp('difficulty', s.difficulty, card.difficulty);
  cmp('reward', s.reward_kw, card.reward_kw);
  if (s.rarity !== card.rarity) diffs.push(`rarity ${s.rarity} vs ${card.rarity}`);
  if (s.location !== card.location) diffs.push(`location "${s.location}" vs "${card.location}"`);
  if (s.service_type !== card.service_type) diffs.push(`service "${s.service_type}" vs "${card.service_type}"`);

  const fit = diffs.length === 0 ? 'ok' : `MISS: ${diffs.join('; ')}`;
  if (diffs.length === 0) exact++;
  else residuals.push({ number, title: card.title, diffs });

  if (args.misses && diffs.length === 0) continue;
  lines.push(
    [
      (number ?? '?').padEnd(9),
      card.title.slice(0, 30).padEnd(30),
      String(s.panels ?? '-').padStart(3),
      `${job.module_watts ?? 400}W`.padStart(5),
      String(s.kw_dc ?? '-').padStart(5),
      String(s.annual_kwh ?? '-').padStart(6),
      String(s.difficulty ?? '-').padStart(2),
      String(s.reward_kw ?? '-').padStart(3),
      s.rarity.padEnd(9),
      s.longHaul ? 'LH' : '  ',
      s.location.padEnd(20),
      fit,
    ].join(' | '),
  );
}

console.log(
  'job#      | card                           | pan | watts |  kW   |  kWh   | d | rw | rarity    | LH | location             | fit',
);
console.log(lines.join('\n'));
console.log(`\nEXACT ${exact}/${compared} job cards reproduce from their job record` + (unmatched ? ` (${unmatched} card(s) with no job record)` : ''));
for (const r of residuals) console.log(`  RESIDUAL ${r.number ?? '?'} ${r.title}: ${r.diffs.join('; ')}`);

// --- location privacy sweep: the city is the only thing allowed out -------
let leaks = 0;
for (const job of jobs) {
  if (!job.address) continue;
  const city = rules.cityOf(job.address);
  if (/\d/.test(city)) {
    leaks++;
    console.log(`  LEAK ${job.job_number ?? job.id}: cityOf() produced a location containing a digit`);
  }
}
console.log(leaks === 0 ? '\ncityOf(): no digits in any location. clean.' : `\ncityOf(): ${leaks} LEAK(S)`);

process.exitCode = leaks === 0 ? 0 : 2;
