# NET: volumes server-side consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the fifteen server-side consistency issues left after the NET: volumes writes bench (HANDOFF §4-net-writes
"Open after the bench"; ledgers of 2026-10-31-net-writes-web.md, 2026-11-01-safe-moves-web.md,
2026-11-01-vol-to-vol-staging.md), each RED first.

**Architecture:** All in the web app: `src/lib/remote-requests.ts` (request queue), `src/lib/amiga-uploads.ts` (open/close),
`src/lib/files/net-fetch.ts` (placement, job progress), `src/lib/files/net-moves.ts` (a move's removal),
`src/lib/files/net-write.ts` (writes on a volume), `src/lib/transfers.ts` (queue rows, receiver report), the STASH:/LIBRARY:
drivers' kept words, the files manager's status row. One migration (0057, transfers.active_at). No wire, firmware or
tools/receive change.

**Tech Stack:** Next.js (this repo's version: read node_modules/next/dist/docs before Next code), drizzle-orm + node-postgres,
vitest (unit, db), Playwright against the fake board (e2e/amiga-board.ts).

**Spec:** docs/superpowers/specs/2026-10-31-net-volumes-writes-design.md (§4, §9).

## Global Constraints

- Do not change the wire protocol, wifi-floppy/ or tools/receive/ (read-only there).
- Self-host parity: no deployment-only dependency (no ICU collation, plain SQL only).
- Never touch production; migration applied only to test DBs (the e2e script migrates its own).
- e2e only via `PORT=3100 bash scripts/e2e-local.sh <specs>`, foreground, one at a time, < 9 min each.
- DB tests: `export TEST_DATABASE_URL=$(bash scripts/dev-db.sh start | tail -1); pnpm test:db <path>`.
- One commit per item; no attribution trailers; never `git add -A`.

## Review Focus

- A repeated close racing the first (board's 30 s retry): one queue row, one library add, get done once (Task 1 test: two concurrent placements).
- A Latin-1 capital in a drawer name under a C-collation database: memory dropped, listing found (Task 7 test DB is created with LC_CTYPE C).
- A settle that cannot run (throw, or pool exhausted): the get's own outcome never changes, and nothing waits on itself (Tasks 4, 5).
- A board that went offline mid-copy: the status row slows its polling and says so, and picks up when the board returns (Task 14).
- A 0-byte file on every path onto the Amiga: copied, not dropped (Task 15), the ordinary Queue keeps P7 (ruling).

## Rulings made while planning

- R1 (item 1): a get is claimed by `UPDATE … SET status='placing' … WHERE upload_id=$1 AND kind='get' AND <live> RETURNING`; every
  later write of the placement is conditional on `status='placing'`; a stuck `placing` (crash) fails `io` after the get
  timeout (expireStale). Cost if wrong: a crashed placement is said failed after 10 minutes though its file may be queued.
- R2 (item 2): staging resumes only the row tied to this get (`remote_requests.upload_id = amiga_uploads.id` for this rid). A copy
  into STASH: still resumes its same-path row (it is that file's row there), and the earlier get is detached from it (its
  upload_id cleared). Cost if wrong: none (an old timed-out get never placed twice).
- R3 (item 4): a settle failure after a get is done is logged (`console.error`) and leaves the move's markers, so the job's
  progress settles it again (settleMovesOfJob, itself guarded the same way). Cost if wrong: a persistent settle error shows as
  a move still running, with the error in the logs, not as a failed get.
- R4 (item 5): settleMove decides under its row locks and clears the markers in that transaction (the claim), commits, then
  removes and records the outcome outside it. A crash between commit and removal keeps the source (the move became a copy).
  Cost if wrong: a crash there leaves the source silently kept -- never removed twice.
- R5 (item 7): Amiga names fold in SQL only, in one helper (`amigaFoldSql`): `translate(lower(x), 'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞ',
  'àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþ')` -- AmigaDOS international folding, whatever the database's collation. Values compared
  are folded by the same SQL. Cost if wrong: none for Latin-1 names (Amiga names are Latin-1).
- R6 (item 8): a `sending` row is moving only while `transfers.active_at` (stamped by every chunk fetch) is within
  LIST_TIMEOUT_MS (60 s) and the board's receiver report is fresh, as amiga_uploads.active_at. Migration 0057.
- R7 (item 9): kept words name the cause the server knows, first match wins: a copied file changed (`<name> changed on the
  Amiga` / `… changed since it was copied`), a copied file's delete refused (`<name> could not be removed`), a file the Amiga
  did not list again (`<name> was not listed again`), an empty drawer STASH: did not get (`<name> is empty and was not
  copied`), a new entry seen in the move's fresh listing or left over in STASH:/LIBRARY: (`something new is in it`); with no
  known cause `something not copied is in it`. Several names: `<n> files`. A LIBRARY: source gone or made again is no "Kept"
  but a removal that could not be done: "it is no longer on the disk" / "it was made again since the copy". Cost if wrong: words.
- R8 (item 10): Clear finished keeps the finished rows of a job that still has a waiting or moving row (so a drawer's count
  holds); a drawer mark counts each job's rows by state plus its relayed gets not yet handed over: `Sending <k> of <n>` with
  k = through + failed + 1, then ` · <f> failed`. Cost if wrong: finished rows of a running job survive one Clear.
- R9 (item 14): the progress says which waiting board is offline (`offline`), the status row adds "— <board> is offline"
  and polls every 15 s until it is back (then every second again). Cost if wrong: a slower update the moment a board returns.
- R10 (item 15): firmware (`s->phase = s->size ? AS_DATA : AS_AWAIT_OK`, amiga_send.c) and Transfer (`if (size == 0)
  finish_file(s)`, rx_proto.c; the upload side: "A resume at the file's size has no raw section") both carry a 0-byte FILE,
  so copies onto a volume and between volumes take empty files. The ordinary Queue (ReceiveDir sends, P7) keeps its
  refusal. Cost if wrong: an empty file fails on the bench with Transfer's words (nothing lost); bench check owed.

---

### Task 1: claim the get before placing (m1, m5)

**Files:** Modify `src/lib/files/net-fetch.ts` (placeFetched, place, relay), `src/lib/remote-requests.ts` (claimGet,
settleGet `onlyFrom`, expireStale for `placing`). Test: `src/lib/files/net-consistency.db.test.ts` (new; DB created with
LC_COLLATE/LC_CTYPE 'C').

**Interfaces:** Produces `claimGet(db, uploadId, now): Promise<RemoteRow | null>`; `settleGet(db, rid, outcome, now, onlyFrom?: string)`.

- [ ] Step 1: tests -- (a) two concurrent `placeFetched` for one relayed upload: one queue row on w2, get done; (b) a throw
  after the queue took the file (releaseStaging mocked to throw once): get done, row queued; (c) a repeated close after the
  first finished: nothing new.
- [ ] Step 2: run, expect (a) 2 rows, (b) get failed `io`.
- [ ] Step 3: implement claim; failure settle only `WHERE status='placing'`; relay settles done before releasing staging
  (release failure swallowed: the sweep takes it); no claim -> release staging only when no get of it is `placing`.
- [ ] Step 4: run green, plus vol-staging/net-fetch db tests. Commit.

### Task 2: staging resume keyed by the get (m2)

**Files:** `src/lib/amiga-uploads.ts` (openRow). Test: net-consistency.db.test.ts.

- [ ] Step 1: tests -- re-run vol-to-vol copy after a timed-out get with a partial staging row: the new get opens a new row,
  offset 0; a re-run copy into STASH: resumes the row and the old get no longer names it; placement settles the new get.
- [ ] Step 2: RED (same id; old get keeps upload_id). Step 3: staging `same` requires the get tied to it; copy: detach
  others (`update remote_requests set upload_id=null where upload_id=same.id and id<>rid`). Step 4: green. Commit.

### Task 3: staging released when its get ends by an error (m3)

**Files:** `src/lib/remote-requests.ts` (answerPiece). Test: net-consistency.db.test.ts.

- [ ] Step 1: test -- get opened (staging receiving, one chunk), then the board's `ERR <rid> io 4:read` via answerPiece:
  the staging row is deleted and its chunks gone. Step 2: RED. Step 3: in answerPiece, a get ending `failed` with an
  upload_id releases a staging row (inline update + chunk delete, no import cycle). Step 4: green. Commit.

### Task 4: a settle failure does not change the get (safe-moves minor)

**Files:** `src/lib/files/net-fetch.ts` (place, fetchProgress). Test: net-consistency.db.test.ts (vi.mock of './net-moves'
with a throw switch on settleMoveOfGet / settleMovesOfJob).

- [ ] Step 1: test -- a move off a volume into STASH:, settleMoveOfGet throws: the get is `done`, the move's marker stays,
  and the next fetchProgress settles it (asks the fresh listing). fetchProgress with settleMovesOfJob throwing still answers.
- [ ] Step 2: RED (get failed io). Step 3: try/catch + console.error in place and fetchProgress. Step 4: green. Commit.

### Task 5: settleMove decides under the lock, removes after (pool 5)

**Files:** `src/lib/files/net-moves.ts`. Test: net-consistency.db.test.ts.

- [ ] Step 1: tests -- (a) a move whose parts are over 24 h old (addWrites' cleanup would delete them under the lock):
  settle completes within 5 s and queues the DELETE … one; (b) two settleMove calls at once queue the deletes once.
- [ ] Step 2: RED ((a) hangs: the cleanup waits on the settle's own row locks). Step 3: transaction returns a decision
  (`null` | `{ kind: 'remove', … }` | `{ kind: 'refused', … }`), clears markers in it; after commit `removeSource` and the
  result rows through `db`. Step 4: green + net-write/vol-staging db. Commit.

### Task 6: Replace in a move within a volume deletes the target's .info

**Files:** `src/lib/files/net-write.ts` (moveWithinVolume). Test: `src/lib/files/net-write.db.test.ts`.

- [ ] Step 1: test -- Work:a (with a.info) moved into Work:D holding a and a.info, Replace: writes are DELETE D/a, DELETE
  D/a.info (icon), RENAME a, RENAME a.info; without a source icon no DELETE of D/a.info. Step 2: RED. Step 3: compute the
  icon first; when replacing, the icon is known and the destination lists `<name>.info`, add the DELETE (icon: true).
  Step 4: green. Commit.

### Task 7: one Amiga fold for remembered listings

**Files:** Create `src/lib/amiga-fold.ts` (`amigaFoldSql(x: SQL | column)`); modify `src/lib/remote-requests.ts`
(latestFor, dropMemory), `src/lib/files/net-fetch.ts` (afterTransferDone). Test: net-consistency.db.test.ts (C database).

- [ ] Step 1: tests with Ä/Ö/Ü/Å/É: a done listing of `Work:Äpfel` dropped by `Work:ÄPFEL` and by `work:äpfel`; under
  `Ü:` dropped by `ü:`; latestFor('Work:ÉTÉ') finds `Work:été`; afterTransferDone on a volume `Ö:` with a row queued on `ö:`
  keeps memory. Step 2: RED. Step 3: implement. Step 4: green. Commit.

### Task 8: transfers.active_at (migration 0057)

**Files:** `src/db/schema/transfers.ts`, `drizzle/0057_*.sql` (pnpm db:generate against the dev DB URL), `src/lib/transfers.ts`
(recordChunk stamps), `src/lib/remote-requests.ts` (boardMoving, copyMoving). Test: net-consistency.db.test.ts.

- [ ] Step 1: tests -- a sending row with active_at 2 min old and a fresh receiver report: copyMoving null, and a waiting
  listing 61 s old times out; a chunk fetch stamps active_at and copyMoving names it. Step 2: RED. Step 3-4. Commit.

### Task 9: kept words tell the truth

**Files:** `src/lib/remote-browse.ts` (keptWords(label, why?), isKeptWords), stash-driver.ts, library-driver.ts, net-moves.ts
(Removal kept why; target.keptWhy), net-fetch.ts (startFetch `moveLeft`; fetchProgress kept why for volumes), manager-rules.ts
(JobWriteView.keptWhy). Tests: manager-rules.test.ts, words.test.ts, ops.db.test.ts, net-write.db.test.ts, net-consistency.

- [ ] Step 1: tests -- volume: a copied file changed -> "Kept Work:Pack: one.txt changed on the Amiga"; a copied file's
  DELETE refused busy -> "… one.txt could not be removed"; new.txt in the fresh listing -> "something new is in it"; an
  empty subdrawer into STASH: -> "Kept Work:Pack: E is empty and was not copied". STASH: a copied file changed -> "Kept
  STASH:/Pack: one.txt changed since it was copied"; LIBRARY: top gone -> "Copied, but the original could not be removed —
  it is no longer on the disk". Step 2: RED. Step 3-4. Commit.

### Task 10: drawer "Sending k of n" from the job's own rows

**Files:** `src/lib/files/net-driver.ts` (withArriving), `src/lib/transfers.ts` (clearFinishedTransfers, clearTransfer).
Test: net-driver.db.test.ts or net-consistency.

- [ ] Step 1: tests -- job of 3 rows into Work:Pack, one failed, one delivered, one queued: mark "Sending 3 of 3 · 1 failed";
  a relayed job with one get still on its way and one row queued: "Waiting"/"Sending 1 of 2" (total 2); Clear finished keeps
  the delivered row of the running job. Step 2: RED. Step 3-4. Commit.

### Task 11: refusal at take time says the real reason

**Files:** remote-requests.ts (takeWaiting: writeBlock words from the device row), remote-browse.ts (writeErrorWords
`readonly` uses text), net-fetch.ts sentFailed readonly text, poll route's failWritesWhenOff reason. Test: remote-requests.db.test.ts.

- [ ] Step 1: tests -- device rx '-' with a waiting MKDIR: failed with "Transfer is not running on A500"; rxProto 3:
  "Transfer 2.5 or newer writes to the Amiga"; firmware 1.22: the firmware words; writes off: "Writing is off in Transfer";
  the job's words carry it. Step 2-4. Commit.

### Task 12: rx=c without rxv clears write_on

**Files:** `src/lib/transfers.ts` (recordSendRx `poll` option), `src/app/api/device/poll/route.ts`. Test:
`src/app/api/device/poll` db test or transfers db test.

- [ ] Step 1: test -- write_on true, recordSendRx(c, no cap, {poll:true}) -> write_on false, browse_on false; a chunk's
  recordSendRx(c) leaves them. Step 2-4. Commit.

### Task 13: a cross-board move names the source board in its DELETE words

**Files:** net-fetch.ts fetchProgress (names by deviceId). Test: net-consistency.db.test.ts -- move w1->w2, removal on w1
times out: words "A500 didn't answer — Refresh to try again" (source), not A1200. Commit.

### Task 14: offline boards slow the status row

**Files:** net-fetch.ts (FetchProgress.offline), manager-rules.ts (jobStatus/fetchStatus words), files-manager.tsx (poll
interval). Tests: net-consistency (offline set when the waiting board's last_seen is stale), manager-rules.test.ts (words),
e2e files-net-writes (the row says offline, then finishes after the board returns). Commit.

### Task 15: empty files onto the Amiga

**Files:** transfers.ts (queueTransfers: `empty` only for rows without dest), net-write.ts (copyOntoVolume keeps empties),
net-fetch.ts (relay words). Tests: net-write.db.test.ts (I-3 test rewritten: the empty file is queued, size 0),
vol-staging/net-consistency (a 0-byte file relayed between volumes), e2e files-net-writes (an empty STASH: file copied onto
Work: arrives with the fake board). Commit.

### Task 16: final review

- [ ] One fresh opus reviewer over the branch; fix Critical/Important RED->GREEN; ledger minors below.
- [ ] `pnpm test`, full `pnpm test:db`, `pnpm exec tsc --noEmit`, e2e specs (desktop + mobile files-net ones).

## Ledger
- Task 1: Ruling: a repeated close of staging already handed on (status deleted, CRC and blob kept) answers ok with the name, not gone -- the RED test showed the board's retry heard `gone` for a file that was delivered -- cost if wrong: none (same CRC, same bytes)
- Task 1: complete (net-consistency item 1 RED 3/4 -> GREEN; net-consistency + vol-staging + net-fetch + remote-requests + amiga-uploads db 102/102)
- Task 2: complete (net-consistency item 2 RED 2/2 -> GREEN; db 106/106)
- Task 3: complete (net-consistency item 3 RED 1/2 -> GREEN; the STASH: copy case passed before, as it should)
- Task 4: Ruling: the get-stays-done half of item 4 was already fixed by Task 1's conditional settle (onlyFrom placing), so its test passed on first run; the RED half was fetchProgress throwing when settleMovesOfJob throws -- cost if wrong: none
- Task 4: complete (net-consistency item 4 RED 1/2 -> GREEN 10/10)
