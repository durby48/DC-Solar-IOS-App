# Contacts — the company directory, tags, and importing from an iPhone

Goal: everyone the crew phones who is **not** a customer or a lead — the
distributor, the driver, the city inspector, the electrician, and the five
people behind one contractor customer — lives in the app, tagged, and is
one tap away for every employee. Owners and operators keep it; the crew
reads it.

Added 2026-09-12 on top of the Phone section's Phase 1 `contacts` table
(2026-09-06). **Importing from the phone needs build 31** — `expo-contacts`
is a native module (config plugin + `NSContactsUsageDescription` in
`app.json`), so an EAS build and an App Store / TestFlight update are
required. Everything else in this document is JS and ships with a push.

---

## The model

```
customers ─────< contacts        one customer, many people
                 ├ name, org, title       "Bob Reyes", "Cromwell", "Project manager"
                 ├ phone → phone_e164     GENERATED; the number texts match on
                 ├ email, notes
                 ├ tags text[]            ["contractor", "electrician"] — free text
                 ├ kind                   Phase 1 column; always = tags[1]
                 ├ customer_id            null for a stand-alone contact
                 ├ is_primary             the one to ring first for that customer
                 ├ source                 'manual' | 'ios_import'
                 ├ external_id            iOS contact identifier (unique per company)
                 └ archived_at            "Remove from contacts" hides, never deletes
```

- **A contact belongs to at most one customer.** Cromwell's PM, office and
  site lead are three `contacts` rows with `customer_id = <Cromwell>`. A
  distributor is a row with no customer. The customer record's own
  phone/email stay on the customer; contacts are the *additional* people.
- **Tags are Devon's own words.** No CHECK list. The app offers the tags
  already in use plus a starting vocabulary (`PRESET_TAGS` in
  `app/src/lib/contacts.ts`: supplier, distributor, vendor, contractor,
  electrician, driver, city inspector, inspector, utility, other) and anything
  typed joins the vocabulary from then on. Tags are lowercased and
  de-duplicated on every write.
- **`kind` is kept in step as the first tag** so Phase 1 code and the
  `twilio-inbound` thread label keep reading something sensible. The
  migration backfills `tags = {kind}` on the rows that pre-date it.
- **Matching is unchanged.** `contacts.phone_e164` is the key
  `twilio-inbound` uses (customers → leads → contacts) to file an inbound
  text; nothing in this feature touches the edge functions.

Migration: `supabase/migrations/2026-09-12_contacts_tags.sql` (idempotent;
also re-creates `phone_directory()` with `customer_id`, `tags`, `title` as
columns 8–10 so existing callers are unaffected). Data layer:
`app/src/lib/contacts.ts`; `lib/comms.ts` re-exports the Phase 1 names.

## Where it shows up

| Place | What |
|---|---|
| Home / Menu → CRM → **Contacts** (`/phone/contacts`) | The directory: customers, leads, crew and contacts A–Z, filter chips per source **and per tag**, search by name/company/tag/number. Rows show title, company, tags and "at *Customer*" when filed. Admins: **Add contact**, **Edit** (name, company, title, phone, email, tags, customer link), **Remove**, **Import from phone** (iPhone only). |
| Customer record, phone (`/crm/[id]` → **Contacts** segment) | The customer's people, primary first. Tap a row: Call via DC Solar / Text via DC Solar / Call from my phone / Email. Admins: Make primary, Edit, Detach, Remove, and **Add contact** as a new person or by attaching an existing stand-alone contact. |
| Customer record, web (CRM workspace → detail panel) | The same block under Contact info. |
| Phone → Contacts / Keypad / thread headers | Unchanged behaviour; the directory rows now also carry tags and title. |

## Importing from an iPhone (`/contacts/import`, admin only)

1. **Read my contacts** asks for permission once (iOS 18 "selected contacts
   only" is honoured — the app only ever sees what was allowed). The address
   book is read **200 at a time** in a loop so a big one shows progress
   instead of freezing.
2. **Tick** the people who belong. Search by name, company or number. There
   is deliberately **no "import everything"** — only "Select shown" while a
   search is active, and a selection is required to continue.
3. **Tag** the whole selection (existing tags + type new ones), optionally
   **file them under a customer**, review the summary, **Import N**.
4. The result says what was added, updated and skipped, and offers "Open
   Contacts".

Only the **first phone number and first email** on each card come across
(the phone's primary, if it marks one). Name, company and job title map to
`name`, `org`, `title`. Photos are not read.

### Dedupe rules (per ticked contact, in order)

1. Same `external_id` (this phone's identifier for that card) → **update**
   that row.
2. Else same `phone_e164` as an existing contact → **update** that row and
   stamp the `external_id` on it, so rule 1 catches it next time.
3. Else → **insert**.

An update merges tags in (never removes any), fills in company/title/
phone/email where the row was empty, takes the phone's name, un-archives the
row, and sets the customer link **only if one was chosen** — an import never
detaches anyone. Two ticked cards with the same number insert once. A card
with no name is skipped and counted. Customers and leads are **not** matched
by number: a customer's own number stays on the customer, and the directory
de-duplicates those on display as before.

## Permissions

| | Owner / operator | Crew (viewer) |
|---|---|---|
| Read the `contacts` table (customer record → Contacts, the directory rows) | yes | **yes** — member SELECT, by design: the driver's number belongs on the roof |
| Add / edit / tag / attach / archive / import | yes | no — admin INSERT/UPDATE/DELETE, split per verb; the app hides the buttons and RLS refuses regardless |
| `phone_directory()` (customers + leads + crew cells + contacts, one list) | yes | **no** — admin-only inside the function, unchanged from Phase 1 |
| `messages` (texts and calls) | yes | no — unchanged |

**Known gap for the crew:** the Contacts hub tile is gated `all`, but it
points into the Phone section (`/phone/_layout.tsx`), which mounts
`useAdminOnlyScreen()` and sends non-admins back, and its list is
`phone_directory()`, which gives them zero rows. For the crew to actually
see the directory, either the Phone layout's gate has to make an exception
for the Contacts tab and that tab has to fall back to `fetchContacts()`
(member-readable), or the tile needs a small crew-facing screen of its own.
Neither was in scope for this pass; the data model and RLS already allow it.

Verify RLS the house way — simulate, don't read the policy. The probe is at
the bottom of `2026-09-12_contacts_tags.sql`; it runs inside one transaction
that ends in `rollback`.

## Build note

`expo-contacts@~57.0.5` is installed and its config plugin is registered in
`app.json` with the permission string. SDK 57's root `expo-contacts` export
throws for the classic `getContactsAsync`; the app imports it from
**`expo-contacts/legacy`**, lazily, inside
`app/src/components/contacts/deviceContacts.native.ts`, so a binary without
the module (anything before build 31) reads "unsupported" and the import
screen says so instead of crashing. The web bundle never touches it —
`deviceContacts.ts` is the web file and answers "unsupported".
