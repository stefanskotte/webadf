# TOSEC identity scan — design

**Written 2026-08-31.** Increment A of a larger metadata effort. Read §2 before assuming this
covers reading inside disk images: deliberately, it does not.

## 0. The problem, and what was actually true when this was written

Every piece of catalog metadata in webadf comes from the **filename**. `/api/ingest/complete`
runs `parseTosecName(f.filename)` and writes `title`, `year`, `publisher` from whatever the
uploader happened to call the file. Nothing has ever read a byte *inside* a disk image, and
nothing has ever consulted a reference database.

Four facts established by inspection before this was designed, each of which shaped it:

1. **There is no TOSEC dataset in this repo.** `src/lib/tosec.ts` is a *filename parser* — it
   understands TOSEC naming conventions. There is no DAT file, no table of known titles,
   nothing to match against. The reference data is the bulk of this work, not the disk reading.
2. **`metadataSource` is only ever written as `'filename'`**, and **there is no metadata
   editing UI at all** — `games` rows are written only at ingest. So today every row is
   filename-derived and there are no manual edits to protect. The rule protecting them is
   written now anyway, before an edit UI exists to violate it.
3. **The corpus is small.** 850 blobs, 370 MB total, of which 410 are standard 901,120-byte DD
   images (the rest are e2e fixtures). A full server-side re-hash is cheap and one-off.
4. **This repo has no scheduled jobs and no `vercel.json` or `vercel.ts`.** Cron is a new
   capability here, not an existing flow being extended.

## 1. Why identity comes from hashes, not from disk contents

The original request was "read inside the disks; when the filename gives no TOSEC result, pair
and pull data from there." The order is inverted here, deliberately.

TOSEC DAT entries carry **CRC32, MD5 and SHA1 of the disk image file**. A hash match is
therefore exact and authoritative — it identifies the release, the dump flags and the disk
number with no inference at all.

Reading inside the image is far weaker, and on Amiga it is weaker than it first appears.
**Most commercial games are NDOS**: a custom bootblock and a custom track layout, with no
AmigaDOS filesystem on the disk at all. There is no volume name to read and no file list to
walk. OFS/FFS parsing only works on Workbench disks, utility disks and HD-installable titles —
and even where a volume name does exist it was chosen by whoever mastered the disk, which is
frequently a cracker's handle rather than the game's name.

So the cascade is **hash → filename → contents**, and this increment builds only the first two
steps.

## 2. Scope: this increment, and the two it defers

**In scope (Increment A):** TOSEC DAT import, content hashing of stored blobs, hash-based
matching, applying matched metadata to the catalog, and the job machinery to run all of it.

**Deferred, on purpose:**

- **Increment B — disk-content scanning.** The OFS/FFS reader already sitting in the backlog
  (disk-change spec §5): volume name, bootblock type, file listing.

  **Its value is much lower than it looks, and the reason is worth recording before anyone
  plans it.** OFS/FFS parsing requires an AmigaDOS filesystem, which **NDOS disks do not have**
  — and NDOS is the norm for commercial games, which use custom bootblocks and custom track
  layouts. The disks TOSEC is most likely to miss are cracked and trained *game* releases,
  which are exactly the disks a filesystem reader cannot read. The disks it *can* read —
  Workbench, utilities, HD-installable titles — are largely the ones TOSEC already knows.

  So a filesystem browser is a **library-browsing feature, not an identification strategy.**
  If identification of TOSEC misses is the goal, the technique is **bootblock fingerprinting**:
  hash the first 1024 bytes and match against known bootblocks, and extract the printable
  strings that crack intros and trainers habitually carry. That is a different piece of work
  from an OFS/FFS reader and should be specified as one.
- **Increment C — online enrichment.** Genre, cover art and richer publisher data from a source
  such as OpenRetro or Hall of Light, filling the `genre`, `chipset` and `coverAssetId` columns
  that exist today and are never populated.

**The deferral is the point, not an omission.** Increment A produces a measured miss rate over
the 410 real disks. Building an OFS/FFS parser is a very different proposition at a 5% miss
rate than at 60%, and right now that number is unknown. B is sized from A's output.

## 3. Data model

### 3.1 `tosec_entries` — global, like `blobs`

TOSEC identity is a property of *bytes*, not of a tenant, so this table has **no `orgId`** and
sits in the same class as `blobs`. One import serves every organization.

| column | notes |
|---|---|
| `id` | stable, derived from (set name, rom name) so re-import is idempotent |
| `set_name`, `set_version` | which DAT and which release of it |
| `game_name`, `rom_name` | TOSEC's own strings, stored verbatim |
| `size_bytes` | required for the CRC32 fallback in §4 |
| `crc32`, `md5`, `sha1` | lowercase hex; any may be absent in a given DAT |
| `title`, `sort_title`, `year`, `publisher`, `disk_no`, `disk_count`, `flags` | parsed from `game_name` |

**`parseTosecName` is reused here, and this is the first time it is used on input it was
actually designed for.** Today it guesses at a filename a user chose; here it parses a canonical
TOSEC string. Its existing behaviour — the `(Disk N of M)` clause, the trailing `-N` rule, the
`makeSortTitle` article handling — is exactly right for this input. Any divergence between the
two uses is a bug in one of them and should be fixed in the shared parser, not forked.

### 3.2 `blobs` gains content hashes and a match

`crc32`, `md5`, `sha1`, `hashes_verified`, `hashed_at`, `tosec_entry_id`, `match_state`,
`match_checked_at`.

`match_state` is one of `matched` / `none` / `ambiguous`, and is **not** inferable from
`tosec_entry_id` alone — "considered and found absent" and "not yet considered" are different
states, and telling them apart is what makes the miss rate in §2 measurable rather than
confused with unfinished work. `match_checked_at` records when the decision was made.

`hashes_verified` distinguishes hashes computed server-side from stored bytes (trustworthy)
from hashes supplied by an uploading client (not yet). §7 depends on this column.

**This is the correct home and the choice matters.** Because `blobs` is content-addressed and
shared across organizations, a disk is identified **once for every tenant simultaneously**. The
alternative — recording the match per-tenant on `disks` — would re-do identical work for every
org holding the same bytes and let two tenants disagree about what the same bytes are.

`hashed_at` and `match_checked_at` are nullable and double as the sweeper's cursors (§6).

## 4. The matching cascade

Preference order, strongest first:

1. **SHA1** — exact.
2. **MD5** — exact.
3. **CRC32 + `size_bytes`** — CRC32 alone is a 32-bit checksum and collides; it is never used
   without the size, and never preferred over a stronger hash that is present.

A blob matching **more than one** TOSEC entry is **not** matched automatically: it gets
`match_state = 'ambiguous'` and is surfaced for review. This is real, not defensive — TOSEC
carries the same bytes under several set names, and picking arbitrarily would silently choose a
country or dump-flag variant.

A blob matching **nothing** gets `match_state = 'none'`. It has been considered and found
absent, which is a different fact from not having been considered yet.

## 5. Applying a match

A TOSEC entry names one **disk**; titles live on **games**. So:

- **Disk level:** `disks.tosecName` ← `rom_name`, `disks.diskNo` ← the entry's disk number.
- **Game level:** `title`, `sortTitle`, `year`, `publisher` ← the entry's parsed values, with
  `metadataSource = 'tosec'`.

### 5.1 Authority

An exact hash match **overwrites** any row whose `metadataSource` is `'filename'`. A row whose
`metadataSource` indicates a human edit is **never** overwritten. Nothing writes such a value
today; the rule exists so that the first edit UI does not have to remember to add it.

### 5.2 The merge invariant

Game ids are derived by `stableId('game', orgId, sortTitle, year)`, and disk ids by
`stableId('disk', gameId, sha256)`. Correcting a title therefore changes what a game's id
*would* be — and, because disk ids descend from it, what every one of its disks' ids would be.

**Ids are never re-derived. This rule is safety-critical, not stylistic.**

`devices` carries `desiredDiskId`, `desiredGameId`, `mountedDiskId` and `mountedGameId` as
plain `text` with **no foreign keys**, and `readDesired` joins on `desiredDiskId` specifically
because `(gameId, diskNo, orgId)` is not unique. Re-keying a disk would leave a device's
`desiredDiskId` pointing at a row that no longer exists; the join would return nothing; and
"no disk desired" is not an error in this protocol — it *is* eject. A metadata scan would
silently eject a disk from real hardware, which disk-change spec §1 rule 1 forbids outright.

So the correction is title-only, and duplicates are resolved by **content, not by key**:

> Two `games` rows in the same organization with the same `(sortTitle, year)` are the same game.
> Merge them: move the disks to the survivor, repoint any device's `desiredGameId` /
> `mountedGameId` from the absorbed row to the survivor, and delete the emptied row.

The survivor is the row whose id already equals the derived id if one exists, otherwise the
oldest. **`disks.id` is never touched**, so `desiredDiskId` and `mountedDiskId` stay valid and
no device's desired state moves. Only `disks.gameId` changes, and only for disks being merged.

This also closes the case the key-based version missed. A later re-ingest of the same bytes
under a *correct* filename derives a different game id, finds no row, and inserts a second
game — the duplicate simply arrives later instead of never. Matching on `(sortTitle, year)`
catches it on the next sweep; matching on derived ids would not have.

This yields the property worth holding onto, stated carefully:

> **The sweeper converges the catalog's *content* to what a correctly-named ingest would have
> produced — one game per `(sortTitle, year)`, correctly titled. It does not converge the
> *keys*, and deliberately does not: ids stay as first issued.**

The distinction matters. An earlier draft of this design claimed the stronger property and
proposed re-deriving ids to achieve it; that would have ejected disks from live hardware, for
the reason given above. Content convergence is the achievable half, and it is the half anyone
actually looks at.

It is idempotent, and it is why renames are safe to apply automatically rather than queued for
review.

### 5.3 Atomicity

**`db.transaction()` throws on this driver** — drizzle's neon-http session raises *"No
transactions support in neon-http driver"*. `db.batch()`, which neon wraps in a single
server-side transaction, is the atomic primitive available, exactly as `src/lib/admin-delete.ts`
uses it. Each game's merge-and-update is one batch. Batches are non-interactive, so every read
shaping one runs first.

## 6. Job mechanics

- **`GET /api/cron/scan`**, authenticated by `Authorization: Bearer ${CRON_SECRET}` — the
  platform's documented mechanism. It is **not** behind `requireSuperAdmin()`: there is no
  session on a cron invocation.
- Declared in a **new `vercel.ts`** (the current recommended config format; this repo has no
  Vercel config file at all today).
- **Batched and resumable.** Work is bounded by wall clock — stop at roughly 240 s of the 300 s
  function limit and return, rather than being killed mid-write. The cursor is `hashed_at` /
  `match_checked_at` being null. Killing and re-running is always safe.
- **Two phases per run:** hash unhashed blobs, then match unmatched ones. A run may do only the
  first if there is a lot to hash.
- **Admin surface:** a page under the admin plane showing loaded DAT sets, counts of blobs
  hashed / matched / unmatched / ambiguous, and the measured miss rate from §2 — plus **Run
  now** and the DAT upload. It calls `requireSuperAdmin()` like every other admin route.

### 6.1 Hashing

`md5` and `sha1` come from `node:crypto`. **CRC32 does not exist in `node:crypto`** and is
written by hand — roughly 30 lines with a lookup table, dependency-free in the same spirit as
`adfmfm`, which was written that way deliberately. Bytes are streamed from Blob storage.

## 7. Ingest-time matching, and the trust decision

The CLI and the browser dropzone already stream every file to compute SHA-256. They will
compute **CRC32, MD5 and SHA1 on that same pass** — very close to free — and send all four to
`/api/ingest/complete`, which stores them on the blob. A freshly pushed disk is therefore
matched immediately, with no server-side re-read.

**This trusts a client-supplied hash, and the naive version of it has a cross-tenant flaw that
must not be built.** `blobs` is shared. If a client uploads bytes B and claims a false SHA1 that
happens to match some other TOSEC entry, and that match were written to `blobs.tosec_entry_id`,
then **every other organization holding the same bytes would see the wrong title** — metadata
contamination across the tenant boundary, from a value the server never checked. The blob is
shared precisely because dedupe works; that is what makes the blast radius bigger than the
uploader.

The rule that removes it:

> **An unverified hash may never write shared state.** `blobs.tosec_entry_id` and
> `match_state` are written **only** from hashes computed server-side, where
> `hashes_verified` is true.

A match derived from client-supplied hashes is applied **only to the uploading organization's
own `games` and `disks` rows**. That org gets its immediate, correct-looking result; no other
tenant can be affected by a number the server has not checked. The sweeper then re-hashes those
bytes server-side, sets `hashes_verified`, and promotes the match to the shared row — or
corrects the uploading org, if the client was wrong.

Two further things keep it honest:

- **SHA-256 is unaffected.** It still addresses the blob and gates entitlements, and is
  verified exactly as it is today. Nothing here touches that path.
- **The sweeper prioritises unverified blobs**, so the provisional window is short by design.

A disagreement found between a client-supplied hash and the stored bytes is **surfaced, not
silently corrected**: it means a broken client or a lying one, and both are worth knowing about.

**If this provisional-match machinery is judged not worth its complexity, the fallback is to
hash only server-side** — newly pushed disks then keep filename-derived titles until the next
sweeper run. That is a real option; it trades immediacy for a smaller design.

## 8. Verification

- The DAT parser is pure and gets Vitest coverage against real fixture snippets, including an
  entry with a missing hash field and one with a `(Disk 2 of 3)` clause.
- The CRC32 implementation is tested against known vectors.
- The matching cascade is pure logic over supplied hashes and is Vitest-tested, including the
  ambiguity case and the CRC32-without-size refusal.
- The merge invariant of §5.2 is tested end to end in Playwright: ingest two games under
  differing names that TOSEC resolves to one, run the sweeper, assert one game with both disks
  and no orphan.
- **The eject hazard of §5.2 gets its own test, because it is the one that reaches hardware:**
  mount a disk to a device, run a sweep that renames and merges that disk's game, then assert
  `desiredDiskId`, `desiredSha256` and `desiredVersion` are all unchanged and `readDesired`
  still resolves the same disk. A sweep must never be observable as an eject.
- **Vitest never opens a database connection** in this repo. Anything touching Postgres is
  Playwright, as established since plan 1.

## 9. Out of scope

Reading inside disk images (Increment B) and online enrichment (Increment C), per §2 — note
especially that a filesystem reader is a browsing feature rather than an identification
strategy, since NDOS game disks have no filesystem to read. Also
excluded: editing metadata by hand — this design protects a `metadataSource` value that no UI
can yet produce; cover art of any kind; and re-deriving `isBoot`, which continues to come from
`groupDisks` and remains subject to the recorded caveat that a set with no disk 1 gets no boot
disk at all.

Blob garbage collection remains out of scope and unaffected: nothing here deletes a blob, and
the §5.2 merge deletes only an emptied `games` row.
