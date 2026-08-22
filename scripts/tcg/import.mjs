#!/usr/bin/env node
/**
 * Import the DC Solar trading card deck into Supabase.
 *
 * The game was built in its own repo (github.com/durby48/dc-solar-tcg) as a
 * print-and-play gag gift: one cards.json, prose rules, and 51.5 MB of art. The
 * app cannot read any of that, so this walks the JSON once and lands it in
 * `card_sets` + `cards` (see supabase/migrations/2026-08-22_trading_cards.sql),
 * shrinking every piece of art to a phone-sized WebP in the private `cards`
 * bucket on the way through.
 *
 * Three things this script is careful about, each of which is easy to get wrong:
 *
 *   1. NULL AND ZERO ARE DIFFERENT. `power: 0` (The Inspector contributes
 *      nothing) and `bonus: 0` (The Sharpie) are real values; `panels: null` on
 *      a Critter Guard job means the panel count is not what that job is
 *      measured in. Nothing here coalesces one into the other.
 *   2. ORDER IS THE PRINTED ORDER. `sort_order` is the array index and
 *      `card_number` is index + 1, so the collection screen and a printed sheet
 *      agree. Never sort the array before importing.
 *   3. art/reference/ IS NEVER TOUCHED. Those are real photographs of Devon,
 *      Isaiah, Ben and Simon (with their kids in frame) used as likeness
 *      references by the art generator. They do not go in the database, the
 *      bucket, or the app bundle. Only art/generated/ is read.
 *
 * Idempotent: re-running upserts on `cards.id` and re-uploads the art. It does
 * NOT send `version` or `archived_at`, so an admin's edits to those two survive
 * a re-import — every other column is overwritten from the JSON, which is the
 * point of a re-import.
 *
 * Usage:
 *   node scripts/tcg/import.mjs --source <path to dc-solar-tcg checkout> [--dry-run]
 *   node scripts/tcg/import.mjs --source ../dc-solar-tcg/cards/cards.json
 *
 * The service-role key is read from outside this repo at runtime (this
 * repository is public). Override the folder with --secrets <dir> if it moves.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPANY = 'dc-solar';
const SET_CODE = 'DCS26';
const BUCKET = 'cards';
const CREATED_BY = 'import:dc-solar-tcg';

const DEFAULT_SECRETS = 'C:\\Durbin Enterprises\\config\\secrets';

/** Card art: 3:4 portraits, downscaled to fit a phone screen at 3x. */
const ART_MAX = { width: 900, height: 1200 };
const ART_QUALITY = 82;

/** The card back is decoration, not detail — half the pixels, none of the loss. */
const CARDBACK_MAX_HEIGHT = 900;
const CARDBACK_MAX_BYTES = 300 * 1024;

/**
 * The four cards drawn from a real person's likeness, mapped slug -> roster
 * email. This is an explicit list on purpose: card titles are nicknames
 * ("Ben, The Crew Lead"), the roster has full legal names, and guessing at the
 * join would eventually attach the wrong person's employee record to a card.
 * Every other crew card is an archetype (The Rookie, The Inspector) and stays
 * unlinked even where the art describes a real-looking human.
 */
const LIKENESS_EMAILS = {
  'crew-devon': 'devonsd311@gmail.com',
  'crew-isaiah': 'inettleton18@gmail.com',
  'crew-foreman': 'bnettleton403@gmail.com', // Ben Nettleton
  'crew-simon': 'snettleton2005@gmail.com',
};

/** Fields in cards.json that this importer deliberately does not store. */
const IGNORED_FIELDS = {
  // Path to a photograph of a real person. Never imported. See the header.
  refImage: 'points at art/reference/ — real photos, never imported',
  refPerson: 'prompt fragment describing a real person in a reference photo',
  // The app already has these: art/property/*.jpg are exports of job_artwork.
  houseArt: 'duplicate of public.job_artwork — reachable through job_id',
};

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { dryRun: false, source: null, secrets: DEFAULT_SECRETS };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') args.dryRun = true;
    else if (a === '--source') args.source = argv[++i];
    else if (a === '--secrets') args.secrets = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else fail(`Unknown argument: ${a}\nRun with --help.`);
  }
  return args;
}

const USAGE = `
Import the DC Solar trading card deck.

  node scripts/tcg/import.mjs --source <dc-solar-tcg checkout> [--dry-run]

  --source <path>   The dc-solar-tcg checkout (the folder holding cards/ and
                    art/), or the cards.json file itself.
  --dry-run, -n     Print every row, link and upload that would happen. Writes
                    nothing to the database, the bucket, or the app bundle.
  --secrets <dir>   Folder holding supabase-service-role-keys.txt.
                    Default: ${DEFAULT_SECRETS}
`;

/** Supabase client with the service-role key, loaded from outside this repo. */
function db(secretsDir) {
  let block;
  try {
    block = readFileSync(
      join(secretsDir, 'supabase-service-role-keys.txt'),
      'utf8',
    ).split('Mobile Mulligans')[0]; // DC Solar's block comes first.
  } catch {
    fail(
      `Could not read credentials from ${secretsDir}.\n` +
        'They are deliberately outside this repo — pass --secrets <dir>.',
    );
  }
  const url = block.match(/NEXT_PUBLIC_SUPABASE_URL\s*=\s*(\S+)/)?.[1];
  const key = block.match(/SUPABASE_SERVICE_ROLE_KEY\s*=\s*(\S+)/)?.[1];
  if (!url || !key) fail('Credentials file did not contain a URL and a key.');
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Resolve --source to { root, cardsJson }, accepting either shape. */
function resolveSource(source) {
  if (!source) fail(`--source is required.\n${USAGE}`);
  const p = resolve(source);
  if (!existsSync(p)) fail(`--source does not exist: ${p}`);
  const cardsJson = p.endsWith('.json') ? p : join(p, 'cards', 'cards.json');
  // cards/cards.json -> repo root is two levels up.
  const root = p.endsWith('.json') ? dirname(dirname(p)) : p;
  if (!existsSync(cardsJson)) fail(`No cards.json at ${cardsJson}`);
  return { root, cardsJson };
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * One card from cards.json -> one `cards` row.
 *
 * `?? null` rather than `|| null` throughout: 0 and '' must survive.
 * `version` and `archived_at` are absent on purpose — see the header.
 */
function toRow(card, index, { jobIdByNumber, employeeIdByEmail }) {
  const email = LIKENESS_EMAILS[card.id] ?? null;
  return {
    id: card.id,
    company: COMPANY,
    set_code: SET_CODE,
    card_number: index + 1,
    sort_order: index,
    card_type: card.cardType,
    title: card.title,
    rarity: card.rarity,
    ability: card.ability ?? null,
    flavor: card.flavor ?? null,
    art_prompt: card.artPrompt ?? null,
    job_number: card.jobNumber ?? null,
    job_id: card.jobNumber ? (jobIdByNumber.get(card.jobNumber) ?? null) : null,
    employee_id: email ? (employeeIdByEmail.get(email) ?? null) : null,
    location: card.location ?? null,
    service_type: card.serviceType ?? null,
    panels: card.panels ?? null,
    kw_dc: card.kWdc ?? null,
    annual_kwh: card.annualKWh ?? null,
    difficulty: card.difficulty ?? null,
    reward_kw: card.rewardKW ?? null,
    role: card.role ?? null,
    power: card.power ?? null,
    bonus: card.bonus ?? null,
    full_art: card.fullArt === true,
    holo_only: card.holoOnly === true,
    art_path: `${card.id}.webp`,
    created_by: CREATED_BY,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv);
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const { root, cardsJson } = resolveSource(args.source);
const deck = JSON.parse(readFileSync(cardsJson, 'utf8'));
if (!Array.isArray(deck.cards) || !deck.meta) {
  fail(`${cardsJson} is not a {meta, cards[]} card database.`);
}

const rulesPath = join(root, 'RULES.md');
// Normalised to LF: git checks the source repo out with CRLF on Windows, and a
// Markdown renderer in the app should not have to care which machine imported.
const rulesMd = existsSync(rulesPath)
  ? readFileSync(rulesPath, 'utf8').replace(/\r\n/g, '\n')
  : null;
if (!rulesMd) {
  console.warn(`! No RULES.md at ${rulesPath} — card_sets.rules_md will be null.`);
}

const artDir = join(root, 'art', 'generated');
if (!existsSync(artDir)) fail(`No artwork folder at ${artDir}`);

console.log(`DC SOLAR TCG import${args.dryRun ? ' (DRY RUN — nothing is written)' : ''}`);
console.log(`  source   ${root}`);
console.log(`  deck     ${deck.cards.length} cards, set ${SET_CODE} v${deck.meta.version}`);
console.log(`  rules    ${rulesMd ? `${rulesMd.length} chars from RULES.md` : 'MISSING'}`);
console.log();

const client = db(args.secrets);

// --- resolve the real-world links -----------------------------------------

const { data: jobs, error: jobsError } = await client
  .from('jobs')
  .select('id, job_number')
  .eq('company', COMPANY);
if (jobsError) fail(`Could not read jobs: ${jobsError.message}`);
const jobIdByNumber = new Map();
for (const j of jobs ?? []) if (j.job_number) jobIdByNumber.set(j.job_number, j.id);

const { data: employees, error: employeesError } = await client
  .from('employees')
  .select('id, email, display_name')
  .eq('company', COMPANY);
if (employeesError) fail(`Could not read employees: ${employeesError.message}`);
const employeeIdByEmail = new Map();
const employeeNameByEmail = new Map();
for (const e of employees ?? []) {
  employeeIdByEmail.set(e.email, e.id);
  employeeNameByEmail.set(e.email, e.display_name ?? e.email);
}

// --- build the rows --------------------------------------------------------

const rows = deck.cards.map((c, i) => toRow(c, i, { jobIdByNumber, employeeIdByEmail }));

const unmatchedJobs = rows.filter((r) => r.job_number && !r.job_id);
const matchedJobs = rows.filter((r) => r.job_id);
const linkedCrew = rows.filter((r) => r.employee_id);
const missingLikeness = Object.entries(LIKENESS_EMAILS).filter(
  ([, email]) => !employeeIdByEmail.has(email),
);

console.log(`Job links   ${matchedJobs.length} matched, ${unmatchedJobs.length} unmatched`);
for (const r of unmatchedJobs) console.log(`  ! ${r.id.padEnd(14)} ${r.job_number} — no such job`);
console.log(`Crew links  ${linkedCrew.length} of ${Object.keys(LIKENESS_EMAILS).length}`);
for (const r of linkedCrew) {
  const email = LIKENESS_EMAILS[r.id];
  console.log(`    ${r.id.padEnd(14)} -> ${employeeNameByEmail.get(email)}`);
}
for (const [slug, email] of missingLikeness) {
  console.log(`  ! ${slug.padEnd(14)} -> ${email} is not on the roster — left null`);
}

// Report fields the JSON carries that the schema deliberately drops, so a
// future change to cards.json does not silently lose data.
const dropped = new Map();
for (const c of deck.cards) {
  for (const f of Object.keys(IGNORED_FIELDS)) {
    if (c[f] !== undefined) dropped.set(f, (dropped.get(f) ?? 0) + 1);
  }
}
const unknown = new Set();
const KNOWN = new Set([
  'id', 'cardType', 'title', 'rarity', 'ability', 'flavor', 'artPrompt',
  'jobNumber', 'location', 'serviceType', 'panels', 'kWdc', 'annualKWh',
  'difficulty', 'rewardKW', 'role', 'power', 'bonus', 'fullArt', 'holoOnly',
  ...Object.keys(IGNORED_FIELDS),
]);
for (const c of deck.cards) for (const f of Object.keys(c)) if (!KNOWN.has(f)) unknown.add(f);

console.log();
for (const [f, n] of dropped) console.log(`Not imported  ${f} (${n} cards) — ${IGNORED_FIELDS[f]}`);
if (unknown.size) console.log(`  ! UNKNOWN FIELDS in cards.json, not imported: ${[...unknown].join(', ')}`);

// --- artwork ---------------------------------------------------------------

const artFiles = new Set(readdirSync(artDir));
const missingArt = deck.cards.filter((c) => !artFiles.has(`${c.id}.png`));
if (missingArt.length) {
  console.log(`  ! ${missingArt.length} card(s) have no artwork: ${missingArt.map((c) => c.id).join(', ')}`);
}

console.log(`\nArtwork  ${deck.cards.length} images -> ${BUCKET}/<id>.webp`);
let bytesIn = 0;
let bytesOut = 0;
let uploaded = 0;
const artFailures = [];

for (const [i, card] of deck.cards.entries()) {
  const src = join(artDir, `${card.id}.png`);
  if (!existsSync(src)) {
    artFailures.push(`${card.id}: no source image`);
    continue;
  }
  const original = readFileSync(src);
  let webp;
  try {
    webp = await sharp(original)
      .resize({ ...ART_MAX, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: ART_QUALITY })
      .toBuffer();
  } catch (e) {
    artFailures.push(`${card.id}: ${e.message}`);
    continue;
  }
  bytesIn += original.length;
  bytesOut += webp.length;

  if (!args.dryRun) {
    const { error } = await client.storage
      .from(BUCKET)
      .upload(`${card.id}.webp`, webp, { contentType: 'image/webp', upsert: true });
    if (error) {
      artFailures.push(`${card.id}: upload failed — ${error.message}`);
      continue;
    }
  }
  uploaded++;
  const n = String(i + 1).padStart(2);
  process.stdout.write(
    `  ${n}/${deck.cards.length}  ${card.id.padEnd(24)} ${kb(original.length).padStart(7)} -> ${kb(webp.length).padStart(7)}\n`,
  );
}

console.log(
  `  ${uploaded} image(s) ${args.dryRun ? 'would be uploaded' : 'uploaded'} — ` +
    `${mb(bytesIn)} -> ${mb(bytesOut)} (${(100 - (bytesOut / bytesIn) * 100).toFixed(0)}% smaller)`,
);
for (const f of artFailures) console.log(`  ! ${f}`);

// --- database --------------------------------------------------------------

const setRow = {
  company: COMPANY,
  code: SET_CODE,
  name: deck.meta.game,
  tagline: deck.meta.tagline ?? null,
  version: deck.meta.version ?? null,
  notes: deck.meta.notes ?? null,
  rules_md: rulesMd,
  generated_on: deck.meta.generated ?? null,
};

console.log(`\nDatabase`);
if (args.dryRun) {
  console.log(`  would upsert card_sets ${SET_CODE} "${setRow.name}"`);
  console.log(`  would upsert ${rows.length} cards`);
  const byType = {};
  const byRarity = {};
  for (const r of rows) {
    byType[r.card_type] = (byType[r.card_type] ?? 0) + 1;
    byRarity[r.rarity] = (byRarity[r.rarity] ?? 0) + 1;
  }
  console.log(`    by type   ${JSON.stringify(byType)}`);
  console.log(`    by rarity ${JSON.stringify(byRarity)}`);
  console.log(`  sample row: ${JSON.stringify(rows[0], null, 2).split('\n').join('\n  ')}`);
} else {
  const { error: setError } = await client
    .from('card_sets')
    .upsert(setRow, { onConflict: 'company,code' });
  if (setError) fail(`card_sets upsert failed: ${setError.message}`);
  console.log(`  card_sets ${SET_CODE} upserted`);

  const { error: cardsError } = await client
    .from('cards')
    .upsert(rows, { onConflict: 'id' });
  if (cardsError) fail(`cards upsert failed: ${cardsError.message}`);
  console.log(`  ${rows.length} cards upserted`);

  const { count, error: countError } = await client
    .from('cards')
    .select('id', { count: 'exact', head: true })
    .eq('company', COMPANY)
    .eq('set_code', SET_CODE);
  if (countError) fail(`count failed: ${countError.message}`);
  console.log(`  ${count} row(s) now in cards for ${SET_CODE}`);
}

// --- bundled assets --------------------------------------------------------
//
// Two images ship inside the app rather than the bucket, because they are
// chrome rather than content: the card back is behind every unflipped card and
// the logo sits on it. Everything else stays server-side — 61 pieces of art in
// the bundle would be in every OTA update forever.

const APP_ASSETS = fileURLToPath(new URL('../../app/assets/images/', import.meta.url));

console.log(`\nBundled assets -> ${APP_ASSETS}`);

const cardbackSrc = join(root, 'art', 'cardback.png');
if (existsSync(cardbackSrc)) {
  const original = readFileSync(cardbackSrc);
  const pipeline = () =>
    sharp(original).resize({ height: CARDBACK_MAX_HEIGHT, fit: 'inside', withoutEnlargement: true });
  // Prefer PNG (lossless, no surprises in RN's image pipeline); fall back to
  // WebP when the photographic sunburst refuses to fit in the budget.
  const png = await pipeline().png({ compressionLevel: 9, palette: true }).toBuffer();
  const useP = png.length <= CARDBACK_MAX_BYTES;
  const out = useP ? png : await pipeline().webp({ quality: ART_QUALITY }).toBuffer();
  const ext = useP ? 'png' : 'webp';
  const dest = join(APP_ASSETS, `tcg-cardback.${ext}`);
  console.log(
    `  tcg-cardback.${ext}  ${kb(original.length)} -> ${kb(out.length)}` +
      (useP ? '' : ` (PNG was ${kb(png.length)}, over the ${kb(CARDBACK_MAX_BYTES)} budget)`),
  );
  if (!args.dryRun) writeFileSync(dest, out);
} else {
  console.log(`  ! no cardback at ${cardbackSrc}`);
}

const logoSrc = join(root, 'art', 'logo.png');
if (existsSync(logoSrc)) {
  const logo = readFileSync(logoSrc);
  const existing = join(APP_ASSETS, 'logo.png');
  const same =
    existsSync(existing) &&
    createHash('md5').update(readFileSync(existing)).digest('hex') ===
      createHash('md5').update(logo).digest('hex');
  if (same) {
    // The TCG repo's logo IS the app's logo, byte for byte. A tcg-logo.png
    // would be 72 KB of duplicate shipped in every OTA update.
    console.log(`  logo.png             already bundled, byte-identical — not duplicated`);
    console.log(`                       card renderer should import assets/images/logo.png`);
  } else {
    const dest = join(APP_ASSETS, 'tcg-logo.png');
    console.log(`  tcg-logo.png         ${kb(logo.length)}`);
    if (!args.dryRun) writeFileSync(dest, logo);
  }
} else {
  console.log(`  ! no logo at ${logoSrc}`);
}

console.log(
  `\n${args.dryRun ? 'Dry run complete — nothing was written.' : 'Import complete.'}`,
);
console.log(`Reminder: ${basename(root)} still contains art/reference/ — real photographs. Nothing`);
console.log(`from that folder was read, and the repo should be made private again.`);
process.exit(artFailures.length ? 1 : 0);
