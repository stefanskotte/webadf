# Demozoo identification — design

**Written 2026-09-14**, after a measured spike (HANDOFF backlog, "DEMOZOO", spike block).
Every operator ruling below was made in the brainstorming session the same day and is marked
as such; do not re-litigate them without the operator.

## 0. The problem, and what was measured before this was designed

TOSEC identifies disks by content hash and OpenRetro enriches the games among them. Neither
covers the rest of an Amiga library: demos, intros, diskmags, musicdisks, tools. OpenRetro is
a games database and was measured to add nothing for those (HANDOFF 3ad).

**Operator framing (ruling):** Demozoo is *complementary* to TOSEC, not a cross-reference.
TOSEC answers for games; Demozoo answers for everything that is not a game. Together they
aim to identify a whole library.

Facts from the spike, on the 2026-09-14 export (200,800,986 bytes):

1. **The export is usable without Postgres.** It is a plain SQL dump; its `COPY … FROM stdin`
   blocks stream-parse directly. 78,447 Amiga productions (platform ids 5 OCS/ECS, 6 AGA,
   26 PPC/RTG), 376,772 screenshots overall.
2. **There is no usable hash route.** `mirror_download` has sha1/md5, but only 438 of 84,560
   Amiga download links are mirrored, of the downloaded archive rather than the ADF, and
   **0 of the 40 live disks matched.**
3. **Title matching mislabels games.** Unique title hits for TOSEC *games* are wrong: Alien
   Breed II resolves to a Fairlight cracktro; Lemmings and Project-X to cracktros and music.
4. **Title matching works for non-games, at ~89% precision.** Across all 2,826 TOSEC Amiga
   demo titles: 1,502 unique matches (53%), 304 ambiguous (11%), 1,020 none (36%). Where TOSEC
   names a group, the unique match agrees in 270 of 304 cases; year agrees in 252 of 304. The
   5 demos in the live library all resolve correctly (9 Fingers, State of the Art, Wayfarer →
   Spaceballs; Global Trash → The Silents; Ray of Hope 2 → Majic 12).
5. **Most TOSEC demo entries carry no group or year to verify with** — only 304 of the 1,502
   unique matches do.

## 1. Operator rulings (2026-09-14)

| Question | Ruling |
|---|---|
| Role of Demozoo | Complement to TOSEC for non-games; never answers for a game |
| Disks TOSEC does not identify | **Suggest candidates; a person picks** |
| TOSEC-identified non-games | **Automatic only when TOSEC's group or year agrees**; otherwise a suggestion |
| Data source | **Scheduled server import** of the bulk export |
| Import frequency | **Weekly at most** — Demozoo is a non-profit and must not be pounded |
| Screenshots | **Copied into our image store**, fetched once each, politely |
| Bulk libraries | **A review queue with bulk accept** for suggestions |

## 2. Scope

In: the weekly import, the nightly matching phase, automatic links, suggestions, the game-page
panel and suggestion card, a title search, the review queue, screenshot fetching, unlink.

Out (§11): Pouet, fuzzy matching, identification from disk *contents* beyond the volume name,
the live Demozoo API.

## 3. Data flow

```
weekly cron ──stage 1──▶ data.demozoo.org export ──▶ our blob store (raw .sql.gz)
            ──stage 2──▶ stream-parse OUR copy ──▶ demozoo_* tables (Amiga only)

nightly sweep (existing /api/cron/scan) ──new phase──▶ match blobs ──▶ links / suggestions
                                        ──new phase──▶ fetch screenshots (capped)
```

### 3.1 Stage 1 — fetch once

`/api/cron/demozoo`, scheduled weekly (Sunday 04:00 UTC) in `vercel.ts`, separate from the
nightly scan.

- A **conditional request** (`If-None-Match` / `If-Modified-Since` from the stored cursor).
  `304` → log and exit: nothing to do this week.
- On `200`, the body is streamed into our blob store under a single key
  (`demozoo/export.sql.gz`, overwritten) with its `ETag` / `Last-Modified` recorded in the
  cursor as *fetched, not yet applied*.
- **This is the only code that requests `data.demozoo.org`**, one request per run, with a
  User-Agent naming webadf (the `openretro-images.ts` rule). A failure in stage 2 never
  causes a second fetch: retries read our copy.

### 3.2 Stage 2 — extract from our copy

Stream-gunzip our copy; parse only the `COPY` blocks needed: `platforms_platform`,
`productions_production`, `productions_production_platforms`, `productions_production_types`,
`productions_productiontype`, `productions_production_author_nicks`, `demoscene_nick`,
`demoscene_releaser`, `productions_screenshot`. COPY text format: tab-separated, `\N` is null,
backslash escapes (`\t`, `\n`, `\\`) must be decoded.

Table order in the dump is alphabetical, so `productions_production` precedes its platforms
table: productions are held in memory keyed by id (title, date, supertype — ~390k small rows)
until platforms resolve which are Amiga, then only those are written.

Upserts keyed on Demozoo ids; rows absent from a newer export are deleted (Demozoo does merge
and delete productions). Any automatic link, confirmation or suggestion pointing at a deleted
production is cleared and its blob's `demozoo_checked_at` reset, so the next sweep re-matches
it rather than leaving a link to nothing. The cursor is marked *applied* only when stage 2
completes.

**TIMING GATE — before the cron is scheduled:** measure stage 2 (parse + database writes) on
the real export against the route's `maxDuration`. If it does not fit, stage 2 is split into
resumable steps across invocations (the cursor records the step); the schedule is not
tightened to compensate.

## 4. Data model

Global tables (like `openretro_*` — a production describes bytes, not a tenant):

- `demozoo_productions` — `id` (Demozoo's, PK), `title`, `title_key` (§5.1, indexed),
  `release_year`, `supertype`, `types` (comma-joined names), `groups` (comma-joined author
  names), `imported_at`.
- `demozoo_screenshots` — `id` (Demozoo's), `production_id`, `standard_url`, `ordinal`.
- `demozoo_images` — one row per image **we have stored**: `screenshot_id`, `production_id`,
  `storage_key`, `size_bytes`, `source_url`, `fetched_at`, `failed_at`.
- `demozoo_import` — single-row cursor: `etag`, `last_modified`, `fetched_at`, `applied_at`,
  `step`.

On `blobs` (global, alongside the OpenRetro cursor):

- `demozoo_production_id` — the **automatic** link only.
- `demozoo_state` — `'applied' | 'suggested' | 'none' | 'skipped_game'`.
- `demozoo_checked_at`.

`demozoo_suggestions` (global) — `sha256`, `production_id`, `source`
(`'tosec_title' | 'volume_name' | 'filename'`). Computed facts about bytes.

Org-scoped:

- `games.demozoo_production_id` + `games.demozoo_link_source` (`'confirmed'`) — a person's
  confirmation, **visible only in that org's library**.
- `demozoo_dismissals` — `org_id`, `sha256`, `production_id`. "Not this", remembered.

## 5. Matching — a new phase of the nightly sweep

Runs inside the existing sweep budget, after OpenRetro enrichment, over blobs whose
`demozoo_checked_at` is null or older than `demozoo_import.applied_at`.

### 5.1 Title key

`title_key(t)`: lowercase; strip one leading `the ` / `a ` / `an `; remove every character
that is not `a-z0-9`. (The spike's normaliser; "State of the Art" and "state-of-the-art" share
a key, which is why §5.2's type filter matters.)

### 5.2 Candidate productions

Amiga productions with `supertype = 'production'` and no type named `Game`. This excludes
standalone music and graphics entries (the Glide "state-of-the-art" track) and scene-made
games. Cracktros and intros remain candidates: they are real non-game disks.

**Unverified:** the spike measured a *type allowlist* (Demo, Intro, sized intros, Musicdisk,
Diskmag, Slideshow), scoped to TOSEC's Demos set. This filter is broader, to match the
operator's non-games scope (applications, coverdisks, tools). That the Glide entry's
`supertype` is `music`, and how much the broader filter changes §0.4's numbers, are both to be
confirmed by the acceptance step in §10 — not assumed.

### 5.3 The cascade, per blob

1. **TOSEC says game → skip.** TOSEC set name contains `- Games -` (covers `Games` and
   `Games - Public Domain`) → `skipped_game`. Demozoo never answers for a game.
2. **TOSEC identified a non-game** → candidates = productions whose `title_key` equals the
   TOSEC title's key.
   - Exactly one candidate **and** (TOSEC year = Demozoo year **or** TOSEC publisher's key is a
     substring of any Demozoo group's key or vice versa) → **automatic**: set
     `blobs.demozoo_production_id`, state `applied`.
   - Otherwise, candidates exist → `suggested` (source `tosec_title`).
   - None → fall through to 3.
3. **No TOSEC identity, or 2 found nothing** → candidate keys from (a) the AmigaDOS volume
   name, read with `readVolume` from the blob's bytes (one store read per blob, once per
   import), and (b) the stem of each entitlement's `source_filename` via `parseTosecName`.
   Any exact `title_key` hits → `suggested` (sources recorded). None → `none`.

Suggestions are never narrowed by guessing; all exact-key candidates are stored.

## 6. Applying a link

### 6.1 What it changes

A link — automatic, or confirmed — updates the game **only where machines own the value**,
using the existing `metadataSource` / `MACHINE_SOURCES` guard from `openretro-apply.ts`: title,
year, and publisher (the first Demozoo group). A hand-edited value is never overwritten.
Metadata source recorded as `'demozoo'`.

### 6.2 Tenancy (ruling)

- **Automatic links are global**, on the blob: they describe bytes and passed verification,
  so every library holding the disk benefits (26 blobs are already shared across orgs).
- **Confirmed suggestions are org-scoped**, on that org's game. One user's pick — or mistake
  — never relabels another tenant's copy; the other tenant still sees a suggestion.
- Precedence on a game page: the org's confirmation, else the blob's automatic link.

### 6.3 Unlink

- Org-confirmed link → cleared.
- Automatic (global) link → a `demozoo_dismissals` row for this org; the blob's global link
  is untouched for other tenants.
- In both cases, fields whose source is `'demozoo'` are re-derived from the next machine
  source (the TOSEC entry if the blob has one, else the filename parse). A hand edit made
  after the link stays.

## 7. Screenshots

A second new sweep phase, after matching, following `openretro-images.ts`'s rules without
exception: one request at a time, a delay between, the webadf User-Agent, a hard cap per run,
never re-fetch a stored image. Only for productions that are linked or suggested — never the
catalogue. At most 5 per production, `standard_url` (not the original). A failed fetch sets
`failed_at` and is retried on a later night; it never blocks matching. Served through the
existing `/api/images/…` route.

## 8. UI

- **Game page, linked:** a Demozoo panel — type, groups, year, screenshots, link to the
  production on demozoo.org, credit line "Metadata and images from Demozoo", **Unlink**.
- **Game page, suggested:** "Possibly on Demozoo" card, each candidate with title, group, year,
  type, first screenshot, **Use this** / **Not this**; a **Find on Demozoo** title search
  beneath (searches `demozoo_productions` by `title_key` prefix and title `ILIKE`).
- **Library grid:** a linked demo's first stored screenshot is its cover, as OpenRetro covers
  are today.
- **Review queue (ruling):** reached from a "N Demozoo suggestions" badge in the library
  header; org-scoped, not admin.
  - Single-candidate suggestions first, **pre-ticked**, each row: thumbnail, title, group,
    year, type, and the disk it came from. **Accept selected** applies exactly the ticked
    rows through §6 (so the human-edit guard holds).
  - Multi-candidate suggestions below, **nothing pre-selected**: pick one per disk or skip.
  - **Not this** per row, remembered in `demozoo_dismissals`.

## 9. Failure handling

- Export unreachable, or `304` → stage 1 logs and exits; next week tries again.
- Stage 2 fails or times out → cursor stays *fetched*; the next run resumes from our copy.
- Suggestions requested before any import → no card, no badge.
- A blob whose bytes cannot be read → state `none` for this import; not retried until the next.

## 10. Verification

Independent checks, not own-fixture agreement:

- **Parser** — unit tests on real rows cut from the 2026-09-14 export into a small committed
  excerpt: tabs, `\N`, escapes, a production with several types and several authors.
- **Matcher** — unit tests pinning every spike case: the 5 live demos resolve to productions
  89, 2, 4162, 710, 737; Alien Breed II, Lemmings, Project-X are `skipped_game`; a unique title
  whose group disagrees (the "Millions" Beyond/Abyss shape) becomes a suggestion; the Glide
  music entry is excluded by §5.2.
- **Acceptance numbers** — after the first real import, recompute §0.4's table for the final
  rule on all TOSEC non-game titles and on the live library; record in HANDOFF. A large
  deviation from the spike is explained before merge.
- **Timing gate** (§3.2) — measured and recorded before the cron is scheduled.
- **Politeness** — tests assert stage 1 makes exactly one request per run, sends the
  conditional headers, and the screenshot phase stops at its cap.
- **e2e** — seeded production: shows as a suggestion; Use this retitles and shows the panel;
  Not this stays gone after a re-sweep; Unlink restores prior machine values; a hand-edited
  title survives a link; a confirmation in org A does not appear in org B; bulk accept
  applies exactly the ticked rows and leaves the unticked ones suggested.
- **The full Playwright suite passes before merge** (operator's standing bar).

## 11. Out of scope

- **Pouet** — the other scene database; a later source if Demozoo coverage proves short.
- **Fuzzy title matching** — exact keys only; a wrong title is worse than a missing one.
- **Identification from disk contents** beyond the volume name (bootblock text, file names).
- **The live Demozoo API** — the bulk export makes it unnecessary, and it would put per-lookup
  load on a non-profit.
