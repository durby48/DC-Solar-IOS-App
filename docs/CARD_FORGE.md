# card-forge — turning jobs into trading cards

Goal: the trading card set **keeps growing on its own**. Every job DC Solar
books eventually becomes a card, and Devon can type a sentence and get a
one-off card back.

The 61-card set was hand-authored in the `dc-solar-tcg` repo and imported once
by `scripts/tcg/import.mjs`. That is a *printing*, not a living deck — DC-26029
through DC-26033 landed after the import and have no card, and every job after
them would have had the same problem. `open_card_pack()` draws from
`cards where archived_at is null`, so **a card that exists is a card in
circulation**: catching the catalog up with the job board is the whole feature.

Nothing here needs a decision from Devon. `GEMINI_API_KEY` is already set on the
project (it is the same key `card-art` and `property-art` use), the function is
deployed with `verify_jwt: true`, and it is admin-only on top of that.

---

## What it does

`POST /functions/v1/card-forge` with a JSON body. Three actions.

| Action | What it does | Writes to the database? |
|---|---|---|
| `sync_jobs` | Every non-internal job with no card gets one | **Yes** — inserts into `cards` |
| `draft` | One card written from a typed prompt | No — the editor saves it |
| `examples` | Keyword glossary + 3 real cards, for the prompt helper | No |

### `sync_jobs`

```jsonc
{ "action": "sync_jobs", "dryRun": true, "generateArt": false }
```

A job is eligible when it is DC Solar's, **not** `is_internal`, has a job
number, and no card points at it — checked two ways, by `cards.job_id` and by
`cards.job_number`, because a card outlives the job record it was drawn from
and the number is the durable half.

**Idempotent.** Pressing it twice creates nothing the second time. That is the
point: it is a "catch up" button, safe to wire to a screen and safe to press
when bored.

**Capped at 25 jobs per call.** More than that and the reply carries
`more: true`; press it again. Twenty-five Gemini calls run four at a time and
still fit inside the request.

Reply:

```jsonc
{
  "ok": true,
  "created": [{ "id": "job-26033", "title": "…", "rarity": "uncommon",
                "job_number": "DC-26033", "art": "ready|skipped|failed" }],
  "skipped": [{ "job_number": "DC-26031", "reason": "…" }],
  "counts":  { "scanned": 32, "alreadyCarded": 26, "internal": 1, "eligible": 5 },
  "dryRun": false,
  "more": false
}
```

`counts` exists so that a sync which creates nothing still says *why* it created
nothing. Jobs that already have cards are counted, not listed — twenty-six
"already has a card" lines is noise.

`dryRun: true` builds and writes every card **except** the insert, and returns
each planned row under `created[].preview`. It still calls Gemini once per job
(that is what makes it a preview of the actual words), so it is not free — but
text generation is fractions of a cent.

### `draft`

```jsonc
{ "action": "draft",
  "prompt": "a legendary card about the crew surviving a 100-degree roof day",
  "cardType": "event",     // optional; the model picks if omitted
  "rarity": "legendary" }  // optional; forced if given
```

Returns `{ ok: true, draft: { … } }` shaped exactly like `CardInput` in
`app/src/lib/cards.ts`, including a proposed `id` from the same
`slugifyCardId()` the app uses, so the editor can hand it straight to
`saveCard`.

**It deliberately does not insert.** A card is company-published artwork that
lands in somebody's binder through a pack they earned; a human reads it first.

### `examples`

No Gemini call, no key needed. Returns the keyword glossary, the compressed
rules, and three real cards — everything the app's prompt helper needs to show
Devon what he can ask for.

---

## The stats are not asked for

The model writes **title, ability, flavor and art prompt**. Everything numeric —
panels, kW, annual kWh, difficulty, reward, rarity — is computed from the job
record before Gemini is called, and Gemini is told the numbers are already
decided.

This is not fussiness. Difficulty is the number the game is *played* on: it is
what a table has to commit in Crew Power to complete the job. A language model
asked for a difficulty will hand a 10-panel job a 6 because it sounds heroic,
and then the card is broken in a way nobody notices until game night.

### The rules

Fitted against the 26 printed job cards. `panels` comes from
`jobs.module_count`, or `jobs.critter_guard_panels` on a Critter Guard job.

| Quantity | Rule |
|---|---|
| `kw_dc` | `panels × module_watts ÷ 1000`, one decimal, where a null `jobs.module_watts` means **400 W** (the company standard). Null on Critter Guard jobs. |
| `annual_kwh` | `kw_dc × 1400` (KC region), rounded to the nearest **100**, or nearest 10 under 1,000. That is what keeps The One-Panel Wonder at 560 instead of a self-important 600. |
| `difficulty` | By panels: **≤4 → 1, 5–19 → 2, 20–28 → 3, 29–36 → 4, 37–44 → 5, 45–48 → 6, ≥49 → 7.** Long Haul adds 1, capped at 7. |
| `reward_kw` | `max(1, round(kw_dc))`. |
| `rarity` | By panels: **≤27 common, 28–36 uncommon, 37–44 rare, ≥45 legendary.** Then floored to **uncommon** if the job is a Long Haul, a Critter Guard, 4 panels or fewer, or has no panel count. Then forced to **legendary** if `kw_dc ≥ 20`. |
| `service_type` | `R&R` → Removal & Reinstall · `Reinstall` · `Install` · `Critter Guard` · anything else → Service |

**Critter Guard jobs are their own small band**, exactly as the printed cards
read: `kw_dc` and `annual_kwh` null (they are not panels installed), difficulty
2 and reward 3 — or 3 and 4 on an array of 40 panels or more.

**A job with no `module_count` gets The Mystery Count shape**: panels, kW, kWh,
difficulty and reward all null, rarity uncommon, and the *Unknown Quantity*
keyword suggested to the writer. That is a playable card — the deck sets its
difficulty when you attempt it — not a broken one. `NULL IS SEMANTIC` here, the
same way the migration says it in capitals.

**`secret` is never assigned automatically.** It is a one-in-the-set joke and it
stays a human decision.

### Long Haul

`NEAR_CITIES` in the function is the list of towns DC Solar can be at and back
from in a day. **Anything not on that list is a Long Haul**: +1 difficulty and
an uncommon rarity floor, exactly as DC-26011 (Wichita) and DC-26019 (Oberlin)
spell out on their own faces.

An allow-list rather than a distance lookup, because an edge function has no
geocoder and because being wrong in this direction is harmless — an unknown town
is treated as far away, which is the right default for a company whose entire
metro is on the list. **If DC Solar starts working a new nearby town, add it to
`NEAR_CITIES`**, or its cards come out one step rarer and one step harder than
they should.

### How well it fits

Run over the live job records behind the 26 printed job cards
(`scripts/tcg/calibrate.mjs`, 2026-08-22), the rules reproduce **20 of the 24
that still have a job record exactly**. DC-26024 and DC-26025 were deleted from
`jobs` after the printing (a card outlives its job, so the cards are fine — there
is just nothing to diff them against). The four residuals, every one of them
explained:

| Card | Difference | Why |
|---|---|---|
| DC-26004 *Over The Top Restoration* | everything | The Classified card. No address, no panel count, hand-redacted on purpose. Nothing automatic can or should reproduce it. |
| DC-26020 *The Parkville IQ8* | panels 28 vs 38 | The **job record** says 28 modules; the card was printed from 38. Data drift, not a rule miss. |
| DC-26011 *The Wichita Road Trip* | reward 4 vs 5 | Hand-tuned +1 for the drive. |
| DC-26023 *Salina, Part II* | difficulty 3 vs 2, uncommon vs common | The only genuine disagreement: it is a Long Haul that was printed as routine. Its own card text (*"Sequel: … difficulty −1"*) is the joke about that. |

Two earlier residuals are gone: DC-26019 *The Oberlin Beast* (15.6 kW vs 23.4)
fits since `jobs.module_watts` exists and carries 600 for it — see below — and
DC-26024 *The Trimble Ground Mount* (hand-bumped to uncommon for *Feet on the
Ground*) no longer has a job record to compare against.

**Non-400 W modules.** `jobs.module_watts` (migration
`2026-08-22_module_watts.sql`) is the wattage per module, and **null means
400 W** — the column is deliberately not defaulted, so a job nobody checked
stays distinguishable from one somebody did. It is set in the job editor under
"Modules / panels", and only needs setting when a job runs something other than
the standard module. DC-26019 carries 600, which is what makes the Beast
reproduce; a future 600 W job needs the same one field filled in before the
sync runs, or its card comes out rated as 400 W panels and needs the `kw_dc`
hand-edit the original set took.

### Re-running the fit

`node scripts/tcg/calibrate.mjs` runs the function's own `statsForJob()` —
loaded from `index.ts` itself, not a copy of the rules — over the live job
record behind every printed job card and prints a row per card with the
residuals marked. Run it after touching the rules, `cityOf()`, or the job data
they read; the residual list it prints should match the table above. It needs
the service-role key file outside the repo (same as `import.mjs`) and writes
nothing.

---

## The prompt

Three parts, and it is worth knowing which is which.

1. **The game**, compressed to one paragraph from `RULES.md` — enough that the
   model knows difficulty is a cost and reward is a payout.
2. **The keyword glossary** — Quick Job, Shield, Two-Phase, Long Haul, Paperwork
   Pending, Pending Estimate, Unknown Quantity, Stage Confusion, Feet on the
   Ground, Cursed Draw, Fresh Steel, The Big One — plus the two or three that
   actually fit *this* job, derived from its type, stage and distance.
3. **Six to eight real cards from the set**, pulled live from `cards` so the
   voice examples improve as Devon edits the set, spread across rarities so the
   model does not learn one register.

Then the job's facts as JSON, and the four things it is allowed to write:

| Field | Cap | Notes |
|---|---|---|
| `title` | 37 chars | The set names jobs after the place and the panel count, or after the joke in them |
| `ability` | 256 chars, or null | About half the printed set has none, and the prompt says so |
| `flavor` | 96 chars | One line |
| `artPrompt` | 449 chars | **Scene only** — see below |

Every cap is the observed maximum of the printed set, so a generated card
cannot be wider than a card that already exists.

### Why `artPrompt` is scene-only

`card-art` builds the final image prompt as **STYLE preamble + `art_prompt` +
per-type framing note + rarity energy burst**. Every printed card's `art_prompt`
is therefore a bare scene — *"A full solar installation crew with two work
trucks, scaffolding, and mountains of equipment gathered dramatically around one
single tiny solar panel"* — with no style words and no colour.

So the writer is told, explicitly, **not** to write "premium collectible card
illustration", "no text or logos", or any rarity colour into the prompt. Putting
those in `art_prompt` would duplicate the preamble and the burst inside the
prompt and drift the card away from the other sixty. The style belongs to the
set; the scene belongs to the card.

---

## Privacy

Job cards are drawn from real customers' roofs and they end up in a binder that
gets passed around a shop. Four separate things enforce city-level only:

1. **`jobs.name` is never read.** It routinely contains the street address
   (*"R&R 4949 Park Ridge Drive, Blue Springs MO 64105 34 Modules"*), and it is
   deliberately absent from the sync's `select` list. Nothing that is never read
   can leak.
2. **`customers` is never read at all**, and `cards` has no customer column.
   The customer's name is not sent to Gemini and cannot reach a card.
3. **`cityOf()` walks backwards from the state token** and stops dead at
   anything containing a digit, anything one character long, or any street word
   (`St`, `Ave`, `Terrace`, `Hwy`, `Apt`, `NW`, …). Whatever survives is checked
   for digits one more time.
4. **The last gate**: a city is only allowed out if the address actually named a
   state, or the town is one the function already knows. `"123 Main"` becomes
   `"Kansas City, MO"`, not `"Main"`. Everything unrecognised falls back rather
   than guessing, because the cost of guessing here is somebody's address on a
   collectible.

The prompt also tells the model, twice and in absolute terms, that customer
names, street numbers and street names are forbidden. That is the belt; the four
rules above are the braces, and the braces are the ones doing the work.

The same `cityOf()` sanitiser runs over whatever the model puts in `location` on
a drafted card, so a hallucinated street address cannot survive `draft` either.

---

## Cost

| | Per card | 25 cards |
|---|---|---|
| Text (`gemini-2.5-flash`, this function) | fractions of a cent | pennies |
| Art (`gemini-3.1-flash-image`, via `card-art`) | **~4¢** | **~$1** |

`generateArt` is **off unless asked for**, and it runs *after* the cards are
committed, on a 90-second budget. Whatever the budget cuts off comes back
`art: "skipped"` and can be redrawn one card at a time from the card screen —
nothing is lost, because `card-art` is the thing that draws the art either way.

Thinking is disabled on the text model (`thinkingBudget: 0`). That halves the
cost and, more importantly, removes the classic gemini-2.5 failure where the
model spends its whole output budget thinking and returns an empty candidate. If
a future model rejects the field, the call is retried once without it rather
than failing the sync.

---

## Errors

| Status | Code | Means |
|---|---|---|
| 400 | `bad_request` | Bad JSON, unknown action, missing prompt, bad enum |
| 401 | — | No JWT (the platform answers this before the function runs) |
| 403 | `forbidden` | Signed in, but not an owner or operator |
| 502 | `gemini_error` | Gemini's own message, passed through |
| 503 | `not_configured` | `GEMINI_API_KEY` is missing |

A single Gemini failure inside a 25-job sync does not sink the other 24 — that
job lands in `skipped` with the reason. Only a *total* wipeout returns 502,
because that is a configuration problem and should read like one.

Nothing sensitive is logged. Addresses, names and keys never reach a log line.

---

## Deploying a change

Same shape as every other function here — Management API, multipart,
`verify_jwt: true`:

```
POST https://api.supabase.com/v1/projects/kjamxfezsathrsbztiln/functions/deploy?slug=card-forge
Authorization: Bearer <PAT from config/secrets/supabase-access-token.txt>
  metadata: {"entrypoint_path":"index.ts","name":"card-forge","verify_jwt":true}
  file:     supabase/functions/card-forge/index.ts
```

Smoke it afterwards: `OPTIONS` must answer **200** with the CORS headers (the
web app preflights from app.dcsolarkc.com), and a POST with no `Authorization`
must answer **401**.
