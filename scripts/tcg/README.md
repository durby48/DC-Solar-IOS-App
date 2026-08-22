# Trading card import

Loads the DC Solar trading card game into the database so the app can render it.

> **This repository is public.** The source repo, `github.com/durby48/dc-solar-tcg`,
> contains `art/reference/` — real photographs of Devon, Isaiah, Ben and Simon,
> with their kids in frame. **Nothing from that folder is ever read, imported,
> uploaded or committed.** Clone the source outside this repo, import, delete
> the clone. Devon should re-private the source repo afterwards.

## What it does

`import.mjs` walks `cards/cards.json` from a `dc-solar-tcg` checkout once and:

| Step | Result |
|---|---|
| `meta` + `RULES.md` | one `card_sets` row, `DCS26`, rules stored as `rules_md` |
| each card, in array order | one `cards` row; `sort_order` = index, `card_number` = index + 1 |
| `jobNumber` | resolved against `public.jobs` into `job_id` (27 of them) |
| the four likeness cards | resolved by an explicit slug → email map into `employee_id` |
| `art/generated/<id>.png` | 900×1200 WebP q82 uploaded to the private `cards` bucket |
| `art/cardback.png` | re-encoded into `app/assets/images/` as the only bundled art |

Schema and RLS live in `supabase/migrations/2026-08-22_trading_cards.sql` —
apply that first.

## Running it

```bash
git clone https://github.com/durby48/dc-solar-tcg   # outside this repo
cd DC-Solar-IOS-App/scripts/tcg && npm install      # sharp + supabase-js
cd ../..

node scripts/tcg/import.mjs --source ../dc-solar-tcg --dry-run
node scripts/tcg/import.mjs --source ../dc-solar-tcg
```

`--dry-run` resizes every image and builds every row so you see the real
numbers, then writes nothing — not the database, not the bucket, not the app
bundle. Run it first; the output is the review.

`--source` takes the checkout folder or `cards/cards.json` itself.
`--secrets <dir>` overrides where `supabase-service-role-keys.txt` is read from
(default `C:\Durbin Enterprises\config\secrets`). The key is **never** inside
this repo.

Its own `package.json` and `node_modules/` are deliberate: `sharp` is a native
binary that the Expo app must never take a dependency on. Do not add these deps
to `app/package.json`.

## Re-running it

Safe. Rows upsert on `cards.id` and art re-uploads with `upsert: true`.

Two columns are **not** sent, so admin edits to them survive a re-import:
`version` and `archived_at`. Everything else is overwritten from the JSON — if
someone has been editing card text in the app, a re-import throws that away.
Once the in-app editor ships, this script is a bootstrap, not a sync.

## Rules the hard way

- **Zero is not null.** `power: 0` (The Inspector genuinely contributes nothing)
  and `bonus: 0` (The Sharpie) are real values. `panels: null` on a Critter
  Guard job means panels are not how that job is measured. `?? null`
  everywhere, never `|| null`, and never `coalesce(power, 0)` in a query.
- **Array order is the printed order.** `sort_order` is the index. Sorting
  `cards.json` before importing renumbers the whole set.
- **Card art gets its own bucket.** The tempting shortcut is a prefix inside
  `job-photos`; its INSERT policy is member-level, so any crew member could
  overwrite card art. `cards` is admin-write only.
- **`crew-foreman` is Ben.** The slug says foreman, the card says "Ben, The Crew
  Lead", the roster says Ben Nettleton. The map in `LIKENESS_EMAILS` is explicit
  for exactly this reason — do not try to join card titles to display names.
- **Only four crew cards are real people.** Every other crew card is an
  archetype and stays unlinked, even where the art prompt describes a specific-
  looking human (`crew-sandals` in particular). An unlabelled likeness is a
  guess, and a guess attaches the wrong person's employee record to a card.
- **The logo is already bundled.** `art/logo.png` is byte-identical to
  `app/assets/images/logo.png`. The script detects this and refuses to write a
  duplicate — 72 KB that would ride along in every OTA update forever. The card
  renderer imports `assets/images/logo.png`.
- **Fields that are dropped are reported.** `houseArt`, `refImage` and
  `refPerson` are not imported, and the script prints why. Any field the script
  does not recognise is printed as a warning rather than silently ignored, so a
  future edit to `cards.json` cannot quietly lose data.
