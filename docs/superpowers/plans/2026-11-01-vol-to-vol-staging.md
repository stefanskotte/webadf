# Volume-to-volume copies without STASH: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Copy or Move between two NET: volumes (one board or two) no longer passes its files through a visible STASH: row: the fetched bytes are internal staging that STASH: listings, quota and search never see, released once handed to the destination queue or once the get fails, and swept if stale.

**Architecture:** The relayed get's upload stays an `amiga_uploads` row (the board's open/chunk/close protocol needs one) but with `source = 'staging'`. Every STASH: read (`listStash`, both quota counts, `getUpload`) excludes that source; the close skips STASH:'s naming for it; `relay()` releases the row (status `deleted`, chunks dropped) on success AND on every failure; `placeFetched` releases a staging row whose get is no longer live; the daily transfers cron deletes staging rows older than 24 h. The blob stays referenced by the existing blob-GC sources: the staging row while it is not deleted, then the destination `transfers` row (any status) -- no new column, no migration.

**Tech Stack:** Next.js (this repo's version; no Next API touched), drizzle-orm + Postgres, vitest db tests (`vitest.db.config.mts`), Playwright e2e via `scripts/e2e-local.sh`.

**Spec:** `docs/superpowers/specs/2026-10-31-net-volumes-writes-design.md` §4 and §9; supersedes ruling W8's "visible in STASH: only while it moves" (`docs/superpowers/plans/2026-10-31-net-writes-web.md`), keeps everything else of W8 and of `docs/superpowers/plans/2026-11-01-safe-moves-web.md`.

## Global Constraints

- No STASH: row for a volume-to-volume copy at any moment: not receiving, not stored, not failed.
- STASH: quota (500 files / 256 MB per org) neither counts staging nor refuses it.
- The blob must stay referenced while any transfers row needs it; a new column naming a blob sha MUST join `runBlobGc`'s reference list (none is added here).
- Nothing left behind on success, failure or cancel; stale staging older than 24 h is swept by the existing daily `/api/cron/transfers`.
- §9 move settling (remove only what was copied; notfound/notempty) unchanged.
- Copy and Move from a volume to STASH: (source `copy`) and to LIBRARY: unchanged.
- Self-host parity: nothing here depends on the hosted deployment.

## Rulings

- **S1** Staging is an `amiga_uploads` row with `source = 'staging'`: no migration, GC reference list unchanged (non-deleted upload rows and every transfers row are already references). Cost if wrong: a reader of amiga_uploads that forgets the source filter shows staging; mitigated by funnelling STASH: reads through `listStash`/`getUpload`/the two quota counts, all filtered.
- **S2** Staging is released at the hand-off to the destination queue; from then the `transfers` row keeps the blob (GC references it in every status until the cron deletes finished rows after 7 days). Equivalent protection to "held until the FILE row ended" with one reference instead of two to keep in sync. Cost if wrong: none for the bytes.
- **S3** Staging is bounded by the job limits (64 files, 16 MB), not STASH:'s quota. Cost if wrong: several concurrent jobs could stage more than 256 MB of chunks for a while.
- **S4** A relay the destination queue refuses now drops the bytes (was: left in STASH: "so nothing is lost"): the source is still on the Amiga and a move keeps it. Cost if wrong: the person re-runs the copy.
- **S5** An upload resumes only a row of the same source, so a staging row and a Receive upload of the same name/size/date never share chunks.
- **S6** The sweep deletes staging rows older than 24 h in any status (the resume window), chunks cascading.

## Review Focus

1. The destination queue is full when the file arrives -- the STASH: copy used to stay; now nothing may stay (Task 2 test "relay refused").
2. The get fails (board ERR / not live) while its file is still going up, then the close arrives (Task 2 test "late close").
3. A CRC-failed staging close is not a STASH: stub (Task 1 test).
4. STASH: is at its quota and a vol->vol copy runs (Task 1 test).
5. A board Receive upload of the same name, size and date as a staging upload does not resume into it (Task 1 test).

---

### Task 1: Staging rows -- hidden from STASH:, outside its quota, not named by it

**Files:**
- Modify: `src/lib/amiga-uploads.ts` (openUpload/openRow source + quota + resume; closeUpload skips STASH: naming; getUpload; new `releaseStaging`, sweep in `expireUploads`)
- Modify: `src/lib/stash.ts` (`listStash`, `insertStash` quota exclude `staging`)
- Test: `src/lib/files/vol-staging.db.test.ts` (new, own database `webadf_vol_staging_test`, helpers as in `net-write.db.test.ts`)

**Interfaces:**
- Produces: `STAGING = 'staging'` (exported from `amiga-uploads.ts`); `releaseStaging(db: Db, uploadId: string): Promise<void>` -- sets a staging row `deleted` and drops its chunks; no-op for any other row.

- [ ] Step 1: failing tests -- same-board copy `NET:/w1/Work/x` -> `NET:/w1/DF0`: after open + a chunk, `listStash` is `[]`; after close (before placement) `listStash` is `[]` and `blobRefsElsewhere([sha])` names it; STASH: filled to 256 MB still lets the staging open succeed and `insertStash` of 1 byte is refused only by the user's own rows; a CRC-failed staging close leaves `listStash` `[]`; a Receive (`request` absent) open of the same path/size/date gets a new row id.
- [ ] Step 2: run, expect FAIL (listStash shows the receiving row; open answers `full`).
- [ ] Step 3: implement: `openUpload` passes `staging = !!target?.relay`; `openRow` inserts `source: staging ? 'staging' : 'copy'` for a get, skips the quota for staging, matches resume on source; `closeUpload` for staging skips Replace, `uniqueStashPath`, `touchStashDirs`; `listStash`, both quota counts and `getUpload` add `ne(source, 'staging')`.
- [ ] Step 4: run, expect PASS.
- [ ] Step 5: commit.

### Task 2: Release on every ending, and the sweep

**Files:**
- Modify: `src/lib/files/net-fetch.ts` (`placeFetched`, `relay`)
- Modify: `src/lib/amiga-uploads.ts` (`expireUploads`)
- Test: `src/lib/files/vol-staging.db.test.ts`

- [ ] Step 1: failing tests -- (a) copy w1->w2 done: staging row `deleted`, transfers row on w2, `blobRefsElsewhere` still names the sha while the row is queued, after delivery and after a cancel; (b) relay refused (w2 queue full): get failed, staging `deleted`, `listStash` `[]`; (c) get answered ERR mid-upload, then close + placeFetched: staging `deleted`; (d) move w1 Work -> w2 DF0 and same-board move Work -> DF0: no STASH: row at any step, source removed as §9 (DELETE … one); (e) `expireUploads` 25 h later deletes a receiving and a stored staging row and their chunks, leaves a fresh one and a STASH: row.
- [ ] Step 2: run, expect FAIL for (b), (c), (e).
- [ ] Step 3: implement: `relay` calls `releaseStaging` on each failure path before settling the get; `placeFetched` with no live get releases; the `place` catch releases too; `expireUploads` deletes `source = 'staging'` rows with `created_at < now - 24 h`.
- [ ] Step 4: run, expect PASS; run `net-write`, `net-fetch`, `amiga-uploads`, `stash-*` db tests and the unit suite.
- [ ] Step 5: commit.

### Task 3: e2e -- a vol->vol copy with STASH: open shows nothing

**Files:**
- Modify: `e2e/amiga-board.ts` (`fakeBoardTiming.beforeClose`: awaited between a GET's chunks and its close)
- Modify: `e2e/files-net-writes.spec.ts` (new test)

- [ ] Step 1: test -- board with volumes Work and Data, a user file `keep.txt` in STASH: (a Receive upload); a second page shows STASH:; copy `c.txt` Work -> Data; `beforeClose` holds the upload: the STASH: page (reloaded) shows only `keep.txt`, `listStash` has only `keep.txt`; release; job says copied; `fs['Data:']` has `c.txt`; STASH: still only `keep.txt`.
- [ ] Step 2: run on the old code (stash the fix by checking out the parent commit's two files into a scratch copy is not needed: run the test before Task 1/2 code is committed is impractical, so the RED is shown by the db tests; the e2e is run GREEN and its hold point is checked to be reached).
- [ ] Step 3: run `files-net-writes`, `files-net-volumes`, `files-net`, `files-stash` each via `PORT=3100 scripts/e2e-local.sh <spec>` (< 9 min each, one at a time).
- [ ] Step 4: commit.

### Task 4: Comments, plan ruling, review

- [ ] Update the W8 comments in `net-fetch.ts` and `remote-requests.ts` (GetTarget.relay) to say staging, not STASH:.
- [ ] One fresh opus reviewer over the branch; fix Critical/Important RED->GREEN; ledger minors here.
