# OpenRetro enrichment — design

**Written 2026-08-31.** Increment C of the metadata effort, following the TOSEC identity scan
(`2026-08-31-tosec-identity-scan-design.md`). Read §0 before assuming this delivers everything
the request asked for: it delivers images and facts, and deliberately not prose.

## 0. What OpenRetro actually is, established before designing

The request was "list all info for that game — description, history, screenshots, publisher and
everything", sourced from openretro.org. Four facts were established first, and two of them
change the shape of the work:

1. **OpenRetro identifies disks by SHA-1 of the ADF file.** Its own documentation for FS-UAE
   Launcher is explicit: files are found by checksum rather than name, and only *unmodified* ADFs
   are recognised. **We already store that hash on every blob**, computed server-side by the TOSEC
   scan. So matching here is exact — no title comparison, no fuzzy logic, nothing to tune.
2. **OpenRetro has no descriptions and no history.** It is a game *configuration* database, built
   to auto-configure emulators. A record carries a front cover, a title screen, screenshots
   (each referenced by its own SHA-1), plus publisher, year, languages and copy-protection notes.
   There is no prose anywhere in it. Description, history and reviews live at **Hall of Light**
   (`amiga.abime.net`), a different database whose covers are watermarked.
3. **There is no documented public API**, and no JSON or database export is offered. FS-UAE
   Launcher and other clients do query it, so a machine-readable interface exists; two open-source
   clients — `FrodeSolheim/fs-uae-launcher` and `sonnenscheinchen/oagd-launch` — are the reference
   for what it is. **Implementation must read one of them rather than guess at endpoints.**
4. **Bulk image packs are published** for FS-UAE Launcher. They are a sanctioned alternative to
   per-game fetching and are worth revisiting if per-request fetching proves unwelcome or slow.

## 1. Why this is worth doing now and was not worth doing before

Enrichment needs a reliable key. Before the TOSEC scan, the only thing identifying a disk was the
filename its uploader chose — so an external lookup would have been a string search against
whatever someone typed. Now every blob carries a server-computed SHA-1, which is precisely the key
OpenRetro indexes on. The identity work is what makes this increment exact rather than heuristic.

## 2. Scope

**In scope:** matching blobs to OpenRetro records by SHA-1; storing publisher, year, languages and
the image references; copying cover art, title screens and screenshots into this project's own
Blob storage; surfacing all of it on `/games/[id]`.

**Deliberately not in scope:** description and history. They are not in OpenRetro. The schema is
shaped so a later Hall of Light increment can supply them **without reshaping anything** — see
§3.3 — but no scraping of Hall of Light happens here.

**Also excluded:** editing enriched values by hand, and re-fetching on a schedule to track
upstream edits. A record is fetched once and refreshed only when explicitly asked.

## 3. Data model

### 3.1 `openretro_entries` — global, like `tosec_entries` and `blobs`

An OpenRetro record describes *bytes*, not a tenant's copy of them, so this table has **no
`orgId`** and one fetch serves every organization. Columns: the OpenRetro identifier (slug and/or
UUID — §0.3's reference clients determine which is stable), `game_name`, `publisher`, `year`,
`languages`, `front_image_sha1`, `title_image_sha1`, an ordered set of `screenshot_sha1`s, the
source URL, and `fetched_at`.

The source URL is stored deliberately: it costs nothing now and is what makes attribution
possible later (§8).

### 3.2 `blobs` gains an enrichment cursor

`openretro_entry_id`, `enrich_state` (`enriched` / `none` / `ambiguous`) and `enrich_checked_at`
— mirroring `tosec_entry_id` / `match_state` / `match_checked_at` **exactly**. That symmetry is
the point: the sweeper's existing resumable, budget-bounded, cursor-driven pattern then applies to
this phase with no new machinery, and anyone who understands one phase understands the other.

**No foreign key on `openretro_entry_id`**, for the same reason `tosec_entry_id` has none: a
re-fetch may remove an entry, and a dangling reference must degrade to "unenriched" rather than
block anything.

### 3.3 `games` gains prose columns and a per-field source

`description` and `history` are added now and left empty. Alongside them, a record of **which
source supplied each field** — so that when Hall of Light arrives it can fill the prose without
overwriting OpenRetro's facts, and so a future edit UI can tell machine-authored values from
human ones the way `metadataSource` already does for titles.

This is the whole cost of "Hall of Light later": two empty columns and a source record, decided
now instead of migrated later.

## 4. Matching

Exact SHA-1 equality between `blobs.sha1` and OpenRetro's disk hash. No fallback, no title
comparison — an unmodified ADF matches or it does not.

A **game** inherits enrichment from any of its disks that matched. Multi-disk games resolve
through whichever disk OpenRetro recognises; a game whose disks resolve to *different* OpenRetro
records is recorded as ambiguous and left alone, exactly as the TOSEC matcher refuses to choose.

**Expect a substantial miss rate**, and do not treat it as failure. The TOSEC scan recognised 45%
of this archive, and its misses were Workbench and utility disks — a games database will know
those even less well. A miss is a recorded fact, not an error.

## 5. Images

Each referenced image is fetched once and stored in this project's Blob storage under its own
content hash, so the same cover shared by two games is stored once. `games.coverAssetId` — which
has existed and been rendered since plan 1 and has never been written by anything — finally points
at something.

Screenshots are stored as their own rows with an order, since a game page shows several.

**Size discipline matters here.** 379 MB of e2e fixtures was deliberately reclaimed on
2026-08-31; this increment must not quietly give it back. Images are small (covers and
screenshots, not disk images), but the implementation records total bytes stored so the cost is
visible rather than discovered.

## 6. Job mechanics — a third sweeper phase

Enrichment is **phase 3 of the existing sweeper**, after hashing and matching, not a separate job.

The operator already knows `/admin/scan` → **Run now**, and a nightly cron already runs at 03:00.
A separate job would mean a second schedule, a second shared secret, and a second status page for
no benefit. The phase is bounded by the same wall-clock budget, resumable through the same cursor
pattern, and reports its counts through the same `SweepResult` and the same admin tiles.

**Ordering matters:** enrichment runs after matching, because a blob's TOSEC identity is useful
context for a human reviewing an enrichment miss, and because both phases share one time budget.

## 7. Politeness, and how failure is recorded

**OpenRetro is a volunteer-run community database, not a paid API.** The implementation must:

- fetch **sequentially**, never in parallel, with a deliberate delay between requests;
- send a **descriptive User-Agent** identifying this project, so the operators can see who is
  calling and contact someone if it is a nuisance;
- enforce a **hard cap per sweep run**, so a first run over a large library spreads across nights
  rather than arriving as a burst.

Failure handling follows the sweeper's existing and deliberate asymmetry:

- **A miss** — OpenRetro has no record for this hash — stamps `enrich_checked_at` with
  `enrich_state = 'none'`. It is decided, and not retried.
- **A fetch failure** — network error, timeout, 5xx — **does not stamp**, logs, and moves to the
  next blob. It is presumed transient and retried on the next run.
- A permanently-failing blob therefore retries indefinitely. That is the same known gap the match
  phase carries (recorded in `HANDOFF.md`), and the same eventual fix — a bounded retry — would
  serve both. Do not solve it differently here.

## 8. Attribution, and a decision made knowingly

Copying OpenRetro's images into this project's storage is **redistribution of content contributed
by volunteers**. OpenRetro describes itself as having "liberal usage terms, where anyone can
submit content/fixes"; no explicit licence text was found. The operator chose local copies
knowingly, for page speed and independence from upstream availability.

Two things follow, and both cost nothing:

- **Store the source URL and OpenRetro identifier with every image**, so attribution can be
  rendered whenever it is wanted and the origin is never lost.
- **Do not strip or alter the images.**

If OpenRetro ever objects, §0.4's published image packs and plain hotlinking are both available
fallbacks, and the stored source URLs make either switch mechanical.

## 9. Verification

- The OpenRetro response parser is **pure** and Vitest-tested against captured fixture payloads,
  including a record with no cover and one with several screenshots. **Vitest never opens a
  database connection in this repo** and has no `DATABASE_URL`.
- The matching rule is pure and unit-tested, including the ambiguous case where one game's disks
  resolve to different records.
- Playwright covers the flow end to end against a seeded `openretro_entries` row, so the suite
  never depends on openretro.org being reachable. **No test may make a live third-party request.**
- A test asserts that an enrichment sweep leaves `devices` desired state untouched — the same
  hazard class the TOSEC merge carries, since enrichment writes to `games`.

## 10. Out of scope

Hall of Light and any prose (§2). Editing enriched values. Scheduled re-fetching to follow
upstream edits. Bulk image-pack ingestion (§0.4) — noted as a fallback, not built. Localisation of
`languages` beyond storing what OpenRetro reports.

`blobs` is never deleted by this increment, and no id is ever re-derived — both invariants are
inherited unchanged from the TOSEC work, and the second one exists because re-keying a disk is
indistinguishable from ejecting it from real hardware.
