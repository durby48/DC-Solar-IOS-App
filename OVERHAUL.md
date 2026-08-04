# DC Solar KC App — 2026-08-04 Overhaul

Front-end overhaul requested by Devon on 2026-08-04. Six work steps, one commit
series, **one** `eas update` at the end (no build quota burned).

## Hard constraint that shaped every decision

`react-native-svg` and `expo-linear-gradient` are **NOT** installed. Adding either
is a new native dependency → forces a full EAS build and breaks the "ship it all
in one OTA update" requirement. **Everything below is built from React Native
primitives already in the bundle** (`View`, `Animated`, transforms, border
tricks). No new dependencies were added in this overhaul.

Corollary for future sessions: if you want real illustration assets or gradients,
that is a native-build change — plan it as its own release.

## Steps

Each step is self-contained and verified with `npx tsc --noEmit` before moving on.
HANDOFF.md gets its status line updated at the end of every step.

### Step 0 — Palette overhaul (foundation)

`src/constants/theme.ts`. The old palette was 4 hues (cream / sun / ocean / ink)
and every stage pill reused them, so the pipeline read as one flat beige wall.

- Keep the brand core (cream, sun, ocean, ink) so the app still looks like itself.
- Add a full accent ramp: teal, indigo, violet, coral, rose, amber, lime, mint,
  plus soft/deep variants of each for backgrounds vs. text.
- Give all 8 pipeline stages their **own** hue in `STAGE_COLORS` (they currently
  share 4), so stage is readable at a glance from across the pipeline list.
- Add `gradients` (arrays of stops used by the hand-rolled gradient View stacks)
  and `artPalettes` (house/roof/sky sets consumed by Step 3's artwork).

Risk: theme tokens are referenced app-wide. Mitigation: only ADD keys and
re-point existing ones to close-but-richer values — never remove a key.

### Step 1 — Calendar: week pager + real dates + month tap-through

`src/app/(tabs)/index.tsx`.

1. **Week pager.** New `weekOffset` state (0 = current week). ‹ › arrows page
   backward into past weeks and forward into future ones. Header reads
   `This week · Aug 3 – Aug 8` (and `Week of Aug 10 – Aug 15` when off-current).
2. **Real dates on every row.** Each day row shows `Mon 8/3` instead of a bare
   weekday name. Today is marked, tomorrow is marked.
3. **Monday–Saturday only.** Sundays are dropped from the week list entirely —
   nobody works Sunday. (The month grid keeps its Sunday column so the calendar
   still lines up like every other calendar.)
4. **Month grid job chips are tappable** and route straight to `/job/[id]`,
   matching week-view behavior. Tapping the empty part of a day cell still just
   selects the day.

Data: past weeks need rows the default fetch doesn't cover, so the week view now
pulls its own range via the existing `fetchScheduleRange(from, to)`.

### Step 2 — Job money section

`src/components/JobFinanceHeader.tsx` + `src/components/JobInvoices.tsx`.

1. **Header becomes a stock-ticker.** The six tiles (Estimate, Invoiced, Paid,
   Expenses, Hours, Labor) scroll right-to-left continuously and loop seamlessly.
   Built with `Animated` + a duplicated tile track measured by `onLayout`;
   `useNativeDriver` on native, off on web (RN-Web ignores it). Respects
   `prefers-reduced-motion` by falling back to a static scroll view.
2. **Section renamed** to "Invoices, Estimates, & Payments".
3. **Overlap fixed.** The row was `icon | title+date | amount | 3 buttons` on one
   line, so a 5-figure amount collided with the recorded date. Restructured into
   `icon | title+date (flex, shrinkable) | right column (amount over actions)` —
   the amount now owns its own space and can never sit on top of the date.

### Step 3 — Pipeline property artwork (real per-address cartoons)

Devon's requirement, clarified mid-build: the background must be a cartoon of
**that specific house** — the address determines the picture. Sourced from
Street View or a photo he takes, then cartoonified.

**Two corrections made to the original ask, and why:**

1. **Claude cannot generate images.** Claude reads images; it does not produce
   them, and there is no Anthropic image-generation endpoint to call. Gemini
   *does* do image-to-image, so the cartoon step runs on Gemini. Bonus: Street
   View is also Google, so **one API key covers both halves**.
2. **The generator does NOT run on the Windows PC.** A Claude Code session on a
   home desktop can't generate images, isn't reachable from crew iPhones on cell
   data, is only up when that machine is on, and would mean storing DB
   credentials on a desktop. It runs as a **Supabase Edge Function**, the same
   pattern as `notify` and `extract-materials`.

**What was built:**

- **Migration `2026-08-04_job_artwork.sql`** (APPLIED): `job_artwork` table
  (one row per job: source, art_path, source_ref, status, error) + the private
  `property-art` storage bucket, both under the usual RLS (members read, admins
  write).
- **Edge function `supabase/functions/property-art`** (DEPLOYED v1, verify_jwt
  ON, re-checks admin role server-side):
  1. Street View **metadata** endpoint first — free, and tells us whether the
     address has coverage before billing an image request.
  2. Street View Static image of the address (or a photo already in storage,
     when `photoPath` is passed — that's the manual override).
  3. Gemini `gemini-2.5-flash-image` image-to-image with a prompt that keeps
     rooflines, storeys, garage and window placement recognizable.
  4. PNG stored in `property-art`, row flipped to `ready`.
  Results are cached — regenerating is opt-in via `force`, so browsing the
  pipeline never re-bills.
- **`src/lib/artwork.ts`** — batched signed URLs for the whole pipeline in one
  request, plus `generateArtwork()`. Never throws; every failure path falls back
  to the drawn illustration.
- **`src/components/JobArtwork.tsx`** — admin card on the job screen: live
  preview, "Generate from address", and "Use a photo" (picks from the job's
  existing photos, so no new upload flow).
- **`src/components/PropertyArt.tsx`** — renders the real artwork when it
  exists; otherwise draws a **cartoon house scene from plain Views**
  (sky/sun/clouds/lawn/driveway/trees, plus siding, brick skirt, border-triangle
  roof, garage, mullioned windows and **solar panels**), seeded deterministically
  from the job id via FNV-1a → mulberry32 so a job always draws the same house.
  This is the placeholder, not the goal — it exists so no card is ever blank
  while artwork is pending or where Street View has no coverage.
- A white scrim (`rgba(255,255,255,0.80)` + a denser top band behind the chips)
  sits between art and text so contrast never suffers.

**Blocked on Devon:** the pipeline produces real cartoons only once a
`GOOGLE_API_KEY` secret (Street View Static API + Generative Language API both
enabled) is set on the function. Until then every card shows the drawn
placeholder and the job screen surfaces the missing-key error in plain text.
**The Street View and Gemini calls are therefore written but UNTESTED** — they
cannot be exercised without the key.

### Step 4 — Payroll pay dates

`src/lib/payroll.ts` + `src/app/(tabs)/hours.tsx`.

Payroll reality, per Devon: **submitted the Wednesday after the period ends, paid
the Friday after.** The period that ended Mon 8/3/26 is submitted Wed 8/5 and
paid Fri 8/7.

- `PayrollPeriod` gains `submitOn` and `payOn` (first Wednesday / first Friday
  strictly after `end`).
- New `payrollState(period, today)` → `current` | `awaiting-submit` |
  `submitted` | `paid`, so the UI stops calling an unpaid past period "Paid".
- The period card shows a status line: `Submit Wed, Aug 5 · Pay Fri, Aug 7`, and
  the money tile reads "Payroll due" until the pay date has passed, "Payroll paid"
  after.

### Step 5 — Verify + ship

1. `npx tsc --noEmit`
2. `npx expo export --platform web`
3. Commit + **one** push to `main` (auto-deploys the web app via Vercel).
4. **One** `eas update --channel production --environment production` — this is
   also the outstanding build-27 OTA adoption test. If it doesn't land after two
   relaunches, the fallback is a full build, not blind debugging.

## Verification status

| Step | Code | tsc | Verified how |
|---|---|---|---|
| 0 Palette | ✅ | ✅ | 30 new tokens, 8 distinct stage hues |
| 1 Calendar | ✅ | ✅ | week pager, dated Mon–Sat rows, month chips route to job |
| 2 Money | ✅ | ✅ | ticker + rename + overlap fix |
| 3 Artwork | ⚠️ | ✅ | migration applied + function deployed against the live project; **Street View/Gemini calls untested — need GOOGLE_API_KEY**. Drawn fallback works now. |
| 4 Payroll | ✅ | ✅ | date math asserted: end 8/3 → submit 8/5 → pay 8/7 |
| 5 Ship | ✅ | ✅ | `tsc --noEmit` clean, `expo export --platform web` clean |

**Not verified by me:** how any of this *looks* on a real iPhone. I typechecked
and built it; I did not run it on a device. First launch after the OTA lands is
the real test — particularly the ticker animation and the artwork scrim contrast.

## Devon's to-do to finish Step 3

1. Google Cloud console → create an API key, enable **Street View Static API**
   and **Generative Language API** on it.
2. Set it as a function secret named `GOOGLE_API_KEY` (Supabase dashboard →
   Edge Functions → property-art → Secrets), or hand it to a session to set via
   the Management API.
3. Open any job → "Property artwork" → **Generate from address**. If Street View
   has no coverage, upload a photo and use **Use a photo** instead.
