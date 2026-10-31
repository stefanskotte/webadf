# NET: volumes phase 2 — server and web (writes, step 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Files can change the Amiga's own disks under `NET:/<board>/<Volume>/…` — Copy onto a volume (drawers included), Move in every direction, Makedir, Rename, Delete, Protect and comments — with the whole board-facing contract (protocol 4) exercised by the fake board, and inert until a board reports `rxv=4&write=1`.

**Architecture:** A copy onto a volume is a `transfers` row per file with `amiga_dest` and `on_clash`; the board's queue text carries them as an extended `NEXT` line (which the firmware turns into the extended `FILE`). Every other write is one `remote_requests` row of a new kind (`mkdir|rename|delete|protect|note`), sent to the board as one line through phase 1's request queue and answered through phase 1's pieces (`DEL`, `DONE`, `ERR`). All rows of one Files operation share a job id; the pane follows the job's progress as it follows a copy out today, and moves remove their sources on the server once the copy part has finished.

**Tech Stack:** Next.js 16 (route params are Promises), drizzle-orm on Postgres (`drizzle-kit generate`), zod, vitest (unit + `pnpm test:db`), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-31-net-volumes-writes-design.md` (this plan = its §6 step 1: §4, §1, and the board-facing contract of §3). Phase 1: `docs/superpowers/specs/2026-10-30-net-volumes-design.md`, plan `docs/superpowers/plans/2026-10-30-net-volumes-web.md`.

## Global Constraints

- Writing needs firmware `WRITE_FW = '1.23.0'`, Transfer protocol `WRITE_PROTO = 4`, and the board's last poll saying `write=1` (with `browse=1`).
- Poll query from 1.23: `&rxv=4&browse=0|1&write=0|1` beside `rx=`. `devices.write_on` is set from it and cleared whenever `browse_on` is.
- Queue text for a row with `amiga_dest`: `NEXT <id> <size> <crc hex> <prot hex> <len>:<Vol:drawer/name> <len>:<comment> <keep|replace|skip>`; offered only to a board whose last poll said `rxv=4` and `write=1`.
- Request lines: `MKDIR <rid> <len>:<path>`, `RENAME <rid> <len>:<from> <len>:<to>`, `DELETE <rid> <len>:<path>`, `PROTECT <rid> <len>:<path> <hex>`, `NOTE <rid> <len>:<path> <len>:<comment>`; Latin-1, lengths count characters. Order: VOLS/DIR and these before any GET, each oldest first.
- Answer lines: `DEL <rid> <n>` (progress, alive), `DONE <rid> <n>`, `ERR <rid> <code> <len>:<text>`; new codes `readonly`, `exists`, `wprot`, `full`, `xvol`.
- Transfer outcomes: `{ok:false, code:'skipped', text:''}` → row status `skipped` (not failed); `{ok:false, code:'readonly'|'wprot'|'denied'|'full'|'busy', text}` → failed.
- Limits per copy onto a volume: 64 files, 16 MB, 4 MB a file — and the board's queue (32 files / 16 MB counting what waits) still binds (ruling W5).
- Delete on a NET: volume is always confirmed: "Delete from the Amiga? This cannot be undone."
- Words (verbatim): "The disk is write-protected", "The disk is full", "Protected against deletion", "In use on the Amiga", "Writing is off in Transfer", "Already exists", "Rename works within one volume", "Transfer 2.5 or newer writes to the Amiga", "Board firmware 1.23.0 or newer writes to the Amiga", "Removed <n>, then stopped at <entry>: <reason>", "Deleting <path> on <Board>…", "removed <n> so far".
- Self-host parity: nothing new depends on Vercel-only services; no new cron.
- Commits carry no attribution trailer. Never `git add -A`, never `git stash`. Never touch `wifi-floppy/` or `tools/receive/`.
- e2e only via `PORT=3100 bash scripts/e2e-local.sh <specs> --project=desktop|mobile`, foreground, each run under 9 minutes.
- DB tests: `export TEST_DATABASE_URL=$(bash scripts/dev-db.sh start | tail -1); pnpm test:db <path>`.

## Rulings made while planning (spec silent or refined)

- W1 **`xfer.next` is the queue text's `NEXT` line.** The poll's `xfer` JSON is `{v, ip}` (a 48-byte buffer on old boards); the board learns the next file from `GET /api/device/send/queue`, whose first line it relays as `FILE` + "everything after `NEXT `". So `dest` and `onClash` ride that line, in exactly the extended `FILE` form of spec §2.2. A `LIST` line of such a row carries its absolute path (display only; Transfer 2.4 drops an absolute item silently, and 2.4 never gets one). Cost if wrong: the firmware plan reads two fields from another place.
- W2 **Write capability:** `write_on = (rxv == 4 && browse == 1 && write == 1)`, written with `rx_proto`/`browse_on` on every capability report; a poll whose `rx` is not `c` clears `browse_on` and `write_on` (Transfer gone).
- W3 **Writing switched off fails what waits** (bench §5.7): when a poll says Transfer is connected (`rx=c`) but not writable, the board's queued `amiga_dest` rows and its waiting write requests fail `readonly` ("Writing is off in Transfer"). When Transfer is merely gone (`rx≠c`) they wait (24 h / the 60 s request expiry as today).
- W4 **The clash check for a copy onto a volume reads the destination from memory**: before posting, the pane lists the destination drawer fresh through its pending loop (as P3 does for drawers out); the server then decides clashes against that remembered answer and refuses `conflict` "List the drawer again and retry" when it is missing. `OpRequest` stays unchanged.
- W5 **The board's queue limit binds**: a copy onto a volume is checked against 64 files / 16 MB / 4 MB a file and then against the queue (32 files / 16 MB with what waits) — so 33-64 files are refused with the queue's words. Cost if wrong: raise `SEND_QUEUE_MAX_FILES` for dest rows later.
- W6 **Two columns beyond the spec's three:** `transfers.job_id` (the Files operation the row belongs to, for its progress) and `transfers.move_source` (the Files path a move removes once its rows are delivered). Write requests keep their arguments in `remote_requests.target` (jsonb) and their job id in `fetch_id`: no new remote_requests columns.
- W7 **Moves finish on the server**: a move's source is removed by the server once its copy part ended — every transfer row of that top `delivered` (STASH:/LIBRARY: → volume), every get of that top `done` (volume → STASH:/LIBRARY:). A skipped, failed or expired row keeps the source. The removal is an ordinary `delete` op as the person who made the move.
- W8 **Copy and Move between volumes pass through the STASH: root**: each file is fetched (GET), and on arrival handed to the destination board's queue (`amiga_dest`) and its STASH: row deleted; visible in STASH: only while it moves. A move then deletes the source once the destination row is delivered.
- W9 **The icon**: Delete and Rename add a request for `<name>.info` when the remembered parent listing holds it and it was not itself picked; with no remembered listing the request is added as `icon: true`, whose `notfound` counts as done.
- W10 **Order on the wire**: a job's requests are inserted 1 ms apart, so "oldest first" is the order the job made them (an icon's rename after its object's; a replace's DELETE before its RENAME).
- W11 **A write's request is `waiting` → `sent` → `done|failed`** with `answer = { removed }` (DELETE). A write request taken by a board that cannot write fails `readonly` at take time instead of being sent.
- W12 **The destination's memory**: a finished write request drops the remembered listings of the drawers it changed (its parent; for RENAME also the target's parent; for DELETE of a drawer also the drawer); a delivered/skipped/failed `amiga_dest` row drops its parent drawers' listings once no other active dest row of that board remains under the same volume (a batch, not file by file, so a pane does not re-read between files).
- W13 **"alive" is bounded by recency** (§4.4 minor 1): a listing arriving in pieces is alive only while a piece came within the last 30 s; the copy exemption (minor 2) also counts a board whose Transfer is sending a queue file or receiving an Amiga-side upload (status `sending`/`receiving` with `devices.send_rx_at` within 60 s; the upload chunk route now stamps `send_rx_at` as the send chunk route does).

## Review Focus

1. **Writing switched off between the click and the board** (Transfer's checkbox unticked, an old Transfer started): queued copies and waiting writes must fail `readonly` with "Writing is off in Transfer", never hang. Pinned in Task 3 (`failWritesWhenOff`) and Task 4 (take-time refusal).
2. **A delete of a big drawer that stops half way** (an entry in use): the pane must say "Removed 37, then stopped at Libs/foo.library: In use on the Amiga" and not time out while `DEL` pieces arrive. Pinned in Task 4 (answerPiece DEL/ERR) and Task 7 (jobStatus words).
3. **A move whose copy part did not complete** (one file skipped or failed): its source must stay. Pinned in Task 6.
4. **Latin-1 names with spaces in every new line** (`RENAME r 12:Work:Würfel 13:Work:Würfel 2`): length prefixes count characters and round-trip. Pinned in Task 2.
5. **A board on 1.22 / Transfer 2.4** never receives a dest row or a write request, and the web app says which piece is missing. Pinned in Task 3 (queue text, takeWaiting) and Task 7 (writeBlock words).

---

## File map

| File | Responsibility |
|---|---|
| `src/db/schema/transfers.ts`, `src/db/schema/devices.ts` | `amiga_dest`, `on_clash`, `job_id`, `move_source`; `write_on` |
| `drizzle/0054_*.sql` (generated) | the migration |
| `src/lib/remote-limits.ts` | `WRITE_FW`, `WRITE_PROTO`, `ALIVE_PIECE_MS`, write kinds |
| `src/lib/remote-wire.ts` | write request lines, `DEL`, new codes |
| `src/lib/transfers.ts` | queue text with dest rows, `skipped`, `recordSendRx` write flag, `failWritesWhenOff`, queueing dest rows |
| `src/lib/remote-requests.ts` | write requests: add, take gating, pieces, expiry, memory drop |
| `src/lib/remote-browse.ts` | `writeBlock`, `writeErrorWords`; protocol ≥ 3 browses |
| `src/lib/files/net-driver.ts` | writable volumes, arriving rows, makedir/rename/remove/setMeta/mustRemove/write/within |
| `src/lib/files/net-write.ts` (new) | turning Files ops on a volume into requests and rows (keeps net-driver.ts listing-only) |
| `src/lib/files/net-fetch.ts` | move out of a volume, relay between volumes, job progress |
| `src/lib/files/net-moves.ts` (new) | finishing moves (remove the source once its copy part ended) |
| `src/app/api/device/poll/route.ts`, `.../send/[id]/done/route.ts`, `.../upload/[id]/route.ts` | rxv=4/write, skipped + move settle, upload stamps send_rx_at |
| `src/lib/files/net-rules.ts`, `pane-rules.ts`, `shelf-rules.ts`, `words.ts`, `manager-rules.ts` | client rules and words |
| `src/components/files/files-manager.tsx`, `pane.tsx`, `dialogs.tsx` | buttons, pre-list, job line, delete confirm, reason line, crumbs |
| `src/lib/help/topics.tsx` | "Writing to the Amiga" |
| `e2e/amiga-board.ts`, `e2e/device-helpers.ts`, `e2e/files-net-writes.spec.ts` (new) | fake board answering protocol 4, e2e |

---

### Task 1: Schema, migration, limits

**Files:** Modify `src/db/schema/transfers.ts`, `src/db/schema/devices.ts` (beside `browseOn`), `src/lib/remote-limits.ts`; generate `drizzle/0054_net_writes.sql`; test `src/lib/remote-requests.db.test.ts` (schema case).

**Produces:** `transfers.amigaDest: text | null`, `transfers.onClash: text | null`, `transfers.jobId: text | null` (index `transfers_job_idx`), `transfers.moveSource: text | null`; `devices.writeOn: boolean default false`; constants:

```ts
export const WRITE_FW = '1.23.0';
export const WRITE_PROTO = 4;
export const ALIVE_PIECE_MS = 30_000;        // a listing arriving in pieces is alive while one came this recently (§4.4)
export const WRITE_KINDS = ['mkdir', 'rename', 'delete', 'protect', 'note'] as const;
export type WriteKind = (typeof WRITE_KINDS)[number];
export const DEL_EVERY = 50;                 // Transfer sends DEL <rid> <n> every 50 entries removed
```

- [ ] Step 1: failing schema test: `information_schema.columns` has `transfers.amiga_dest, on_clash, job_id, move_source` and `devices.write_on`.
- [ ] Step 2: run it, FAIL. Step 3: add columns; `pnpm exec drizzle-kit generate --name net_writes`; read the SQL: only `ADD COLUMN`s and one `CREATE INDEX`. Step 4: migrate the test DB as the harness does; PASS. Step 5: commit.

---

### Task 2: Wire lines (pure)

**Files:** `src/lib/remote-wire.ts`, `src/lib/remote-wire.test.ts`, `src/lib/transfers.ts` (`formatQueue`), `src/lib/transfers.test.ts` (or the existing formatQueue test file).

**Produces:**
- `type RemoteKind = 'vols' | 'dir' | 'get' | WriteKind`.
- `requestLine(r: { id; kind; amigaPath; target?: unknown })` — for writes reads `target` as `WriteArgs = { to?: string; protection?: number; comment?: string }`:
  `MKDIR r 9:Work:New\n`, `RENAME r 6:Work:a 6:Work:b\n`, `DELETE r 8:Work:old\n`, `PROTECT r 6:Work:x f\n` (lower hex, no padding), `NOTE r 6:Work:x 2:hi\n`.
- `AnswerLine` gains `{ t: 'del'; count: number }`; `CODES` gains `readonly exists wprot full xvol`.
- `formatQueue(next, rows)`: a `QueueRow` gains optional `dest: string | null; onClash: 'keep'|'replace'|'skip' | null`; NEXT with a dest is `NEXT <id> <size> <crc> <prot> <len>:<dest> <len>:<comment> <mode>`; a LIST line uses `dest ?? path`.

Tests (each its own `it`): every line above incl. `Würfel Spiel` lengths; `DEL r1 50` → `{t:'del',count:50}`; `DEL r1 x` → null; `ERR r1 wprot 5:prot!` ok; `ERR r1 skipped 0:` → null (not a request code); formatQueue with a dest row: exact text; with a dest row in LIST.

- [ ] Steps: failing tests → run FAIL → implement → PASS → commit.

---

### Task 3: Capability, the queue, outcomes

**Files:** `src/lib/transfers.ts`, `src/app/api/device/poll/route.ts`, `src/app/api/device/poll/route.test.ts` (or the db test the poll uses), `src/app/api/device/send/[id]/done/route.ts`, `src/lib/send-ui.ts`, `src/lib/remote-browse.ts`, tests `src/lib/transfers.db.test.ts` (find the existing db test of transfers; else create `src/lib/transfers-writes.db.test.ts`), `src/lib/remote-browse.test.ts`.

**Produces:**
- `recordSendRx(db, deviceId, rx, now, cap?: { proto: number; browse: boolean; write?: boolean })` writes `writeOn = cap.proto >= 4 && cap.browse && !!cap.write`; with `rx !== 'c'` it writes `browseOn: false, writeOn: false`; the throttle counts a change of `write_on` too.
- Poll: `rxv` accepted as `2|3|4`; `write=1` read.
- `boardWritable(d: { rxProto: number | null; browseOn: boolean; writeOn: boolean }): boolean` (pure, in remote-browse.ts) = `rxProto >= 4 && browseOn && writeOn`.
- `failWritesWhenOff(db, deviceId, now)`: queued/sending rows with `amiga_dest` → failed `readonly` "Writing is off in Transfer" (one `sendVersion` bump); waiting write requests → failed `readonly`. Called by the poll after `recordSendRx` when `rx === 'c'` and the report is not writable.
- `sendQueueText(db, deviceId, now)`: rows with `amiga_dest` are left out unless the device is writable (read `rxProto`, `browseOn`, `writeOn` in the same call).
- `TransferStatus` gains `'skipped'`; `finishTransfer` with `code === 'skipped'` sets `status: 'skipped'`; `transferState`/`stateChip` say "Skipped · already on the Amiga"; clear/summaries treat it as finished (counted as delivered in `sendSummaries`? no: its own bucket is not shown — counted nowhere, like cancelled).
- `queueTransfers` `QueueFile` gains `dest?: string; onClash?: 'keep'|'replace'|'skip'`; `a` gains `jobId?: string; moveSource?: (fileIndex) => string | null` → each row's `amigaDest`, `onClash`, `jobId`, `moveSource`. A dest row's `path` is its name (the last part, cleaned) so the Upload page still shows something; its `amigaDest` is the absolute path (each part checked with `amigaNameProblem`, the volume part may be a device `DF1:`).
- `remote-browse.ts`: `browseBlock`/`browseMark` accept `rxProto >= 3`; `writeBlock(b: BrowseInput & { writeOn: boolean }): string | null` — `browseBlock` first, then firmware below `WRITE_FW` → "Board firmware 1.23.0 or newer writes to the Amiga", `rxProto < 4` → "Transfer 2.5 or newer writes to the Amiga", `!writeOn` → "Writing is off in Transfer".

Tests: poll `rx=c&rxv=4&browse=1&write=1` → `rx_proto 4, browse_on, write_on`; then `rx=c&rxv=4&browse=1&write=0` → `write_on false` and a queued dest row failed `readonly`; `rx=u` → both flags false and the dest row (a new one) still queued; queue text for a non-writable board skips a dest row and shows the next plain row; for a writable board shows the extended NEXT; done with `skipped` → status skipped, cursor bumped; `writeBlock` each case; `browseBlock` with `rxProto: 4` → null.

- [ ] Steps: failing tests → FAIL → implement → PASS (also `pnpm vitest run src/lib/device-limits.test.ts`) → commit.

---

### Task 4: Write requests in the store

**Files:** `src/lib/remote-requests.ts`, `src/lib/remote-requests.db.test.ts`.

**Produces:**
- `type WriteReq = { kind: WriteKind; amigaPath: string; args?: WriteArgs; icon?: boolean; label: string }` where `label` is the pane's words for the object (`Work:old`).
- `addWrites(db, { orgId, deviceId, jobId, writes: WriteReq[] }, now): Promise<string[]>` — one transaction, rows `createdAt = now + k ms` (W10), `target = { ...args, icon, label }`, `fetchId = jobId`, one `reqVersion` bump, the 24 h cleanup.
- `takeWaiting`: write kinds are taken only when the device is writable (read in the transaction); a non-writable board's waiting writes are failed `readonly` there (W11). Order unchanged: non-get first, then createdAt.
- `answerPiece` for write kinds: `del` → `answer.removed = count` (a sign of life); `done` → done, `answer.removed = count`; `err` → failed; an `icon` request failed `notfound` is settled `done`. Any other line → bad.
- `expireStale`: write kinds expire as listings do (60 s after their last sign of life, with the copy exemption).
- `dropMemory(db, deviceId, amigaPaths: string[], now)` — remembered `done` dir rows for those paths (case-insensitive) become `status: 'stale'` (latestFor already returns none for it); called by `answerPiece` when a write ends (W12) with `writeTouches(row)`: mkdir/delete/protect/note → parent; delete also the path; rename → both parents.
- `pendingAlive(row, now)`: `pieces > 0 && activeAt within ALIVE_PIECE_MS` (W13), used by the driver's `pendingOf`.
- `copyMoving(db, deviceId, now)` also returns a name for a `sending` transfer or `receiving` amiga upload of the board while `devices.send_rx_at` is within `LIST_TIMEOUT_MS` (W13); `expireStale`'s `noCopy` mirrors it.

Tests: addWrites order and bump; takeWaiting gives the lines in order (DIR, MKDIR, DELETE, then GET) for a writable board; for a non-writable one the writes fail `readonly` and are not returned; DELETE answered `DEL r 50` then `DEL r 100` then `DONE r 137` → done, removed 137, the parent's remembered listing now `none`; `DEL r 37` + `ERR r busy 30:Libs/foo.library: object in use` → failed, removed 37; an icon DELETE answered `ERR notfound` → done; a write sent 61 s ago with no piece → failed timeout; one whose last DEL came 10 s ago is not; a listing whose last piece was 40 s ago is not alive.

- [ ] Steps: failing → FAIL → implement → PASS → commit.

---

### Task 5: The NET: driver writes

**Files:** Create `src/lib/files/net-write.ts`; modify `src/lib/files/net-driver.ts`, `src/lib/files/driver.ts` (`Outcome` gains `job?: { id: string; files: number; writes: number }`), `src/lib/files/ops.ts` (`OpResult` passes `job`; copy/move dispatch to the NET driver for volume destinations), `src/lib/send-targets.ts`/`send-ui.ts` (`SendTarget.writeOn`); test `src/lib/files/net-write.db.test.ts`.

**Produces:**
- Listing of a volume: `writable = writeBlock(...) === null`, `readOnlyReason` = the block words; `net.write: string | null` (same words); arriving rows: active `amiga_dest` rows of the board whose parent is this drawer (file rows, `marks: [transferState text]`), and a drawer row (mark `arriving`) for a dest whose top lies below this drawer and is not listed yet.
- `netDriver.makedir(ctx, dir, name)` → MKDIR `Vol:drawer/name`.
- `netDriver.rename(ctx, source, name)` → RENAME (+ icon, W9).
- `netDriver.remove(ctx, sources)` for volume paths → one DELETE per source (+ icons); queue paths as today.
- `netDriver.setMeta(ctx, sources, { protection?, comment? })` → PROTECT per source / NOTE.
- `netDriver.mustRemove(ctx, sources)` → refuses with the write block for volume sources.
- `netDriver.write(ctx, dir, tops, onClash)` for a volume dir → W4 clash check against the remembered listing; per-copy limits; then `queueTransfers` with `dest`, `onClash` mode (`keep-both`/`ask`→`keep`, `replace`, `skip`), one `jobId`; a keep-both top takes its keep-both name; a skip top is a skipped item; folders bring their files (empty drawers: an MKDIR each, ordered before files — via the same job, W10, since a FILE makes missing drawers anyway only the empty ones need it).
- `netDriver.within(ctx, req)`: move inside one volume → RENAME each (+ icon) with clash handling against the remembered destination (replace = DELETE then RENAME; keep-both = renamed name; skip); copy, or move across volumes/boards → relay (Task 6's `startRelay`).
- Every write outcome returns `{ kind:'done', items, job:{ id, files, writes } }` — items ok mean queued.
- `ops.ts`: a copy/move whose destination is a NET: volume path goes to `crossDevice` (writes via netDriver.write) or `within`; a move into a volume is no longer `NET_MOVE_IN` (that stays for Queue).

Tests (db): each op on a writable board makes the expected request rows (kind, amigaPath, target) and the icon rows; a non-writable board refuses `read_only` with the words; Copy STASH:/In/a.lha → `NET:/b/Work/Tools` with Tools remembered empty → one transfers row `amigaDest 'Work:Tools/a.lha'`, `onClash 'keep'`, job id; with `a.lha` remembered there and `ask` → clashes; `skip` → skipped; `replace` → mode replace; keep-both → `a_2.lha`-style name (whatever `keepBothName` says); no remembered destination → conflict; 65 files / 17 MB / a 5 MB file → too_large; Move within Work: (Work:a → Work:Sub) → RENAME `Work:a`→`Work:Sub/a`; volume listing shows an arriving row.

- [ ] Steps: failing → FAIL → implement → PASS (+ `pnpm vitest run src/lib/files`, `pnpm exec tsc --noEmit`) → commit.

---

### Task 6: Moves and relays finish on the server

**Files:** Create `src/lib/files/net-moves.ts`, `src/lib/files/net-moves.db.test.ts`; modify `src/lib/files/net-fetch.ts` (move allowed; `GetTarget` gains `moveSource?: string; relay?: { deviceId: string; dest: string; onClash: 'keep'|'replace'|'skip'; jobId: string; moveSource?: string }`), `src/lib/remote-requests.ts` (`GetTarget` type), `src/app/api/device/send/[id]/done/route.ts` (after finish: `settleMoves`), `fetchProgress` → job progress (gets, writes, transfers of the id).

**Produces:**
- `startFetch` with `op: 'move'`: `mustRemove` first (write block), each get's target `moveSource` = its top's Files path.
- `startRelay(ctx, req, destBoard, destAmigaDir)`: gets with `target = { dest: 'STASH:', rel: [name], replace: false, library: null, relay }`.
- `place()` for a relay: queue one transfer from the upload's blob (`queueTransfers` with dest, jobId, moveSource) and mark the STASH: upload `deleted`; failure → the get fails with the queue's words.
- `settleMoves(db, { jobId, moveSource })`: when every row of the job with that moveSource (gets and transfers) is finished and all ended `done`/`delivered` → `runOp({orgId, userId}, { op:'delete', sources:[moveSource] })` once (guarded under the device row lock with a `moved` marker: a write request row of the job whose target says `{ moved: moveSource }` — or for a non-NET source, a transfers-row `moveSource` cleared to null after the delete). Called from `placeFetched` (gets) and the done route (transfers).
- `jobProgress(db, orgId, id, now)` = today's `FetchProgress` plus `{ sent: number; skipped: number; writes: { label: string; kind; status; removed: number; reason: string | null }[] }`.

Tests: move STASH:/a.lha → Work: delivered → STASH: row deleted; skipped → kept; a drawer of two files, one failed → kept; move Work:a.lha → STASH: once stored → a DELETE `Work:a.lha` waits; relay Work:x → DF0:x : get stored → a transfers row with amigaDest `DF0:x`, the STASH: row deleted; jobProgress counts each.

- [ ] Steps: failing → FAIL → implement → PASS → commit.

---

### Task 7: Client rules and words (pure)

**Files:** `src/lib/files/net-rules.ts`, `pane-rules.ts`, `shelf-rules.ts`, `words.ts`, `manager-rules.ts`, `view.ts` if needed, and their tests.

**Produces:**
- `netVolumeReason(l)` → `l.readOnlyReason` when a volume is not writable, else null; `acceptsCopies(volume)` = writable; `netReadOnly(l)` false for volumes.
- `filingReason` out of a writable volume allows move.
- `deleteWhere` → `'AMIGA'` for volumes; `deleteText(entries, 'AMIGA')` = "Delete “x” from the Amiga? This cannot be undone." / "Delete 3 items (2 drawers, with everything in them) from the Amiga? This cannot be undone."
- `writeErrorWords(code, text)`: wprot, full, denied ("Protected against deletion"), busy, readonly, exists, xvol, notfound, else text.
- `jobStatus(p, board)`: running — the first running write's "Deleting Work:old on A500…" (+ " — removed 37 so far"), a copy's "Copying 3 of 12 to A500…"; finished — "Deleted Work:old (137)", "Made Work:New", "Renamed Work:a to Work:b", "Protected Work:x", "Comment on Work:x", "Copied 12 to A500", and a stopped delete "Removed 37, then stopped at Libs/foo.library: In use on the Amiga"; failures named.
- `netCrumbs(path, boardName)` for a pane with no listing (§4.4 minor 3).

- [ ] Steps: failing → FAIL → implement → PASS → commit.

---

### Task 8: The manager and pane

**Files:** `src/components/files/files-manager.tsx`, `pane.tsx`, `dialogs.tsx`.

- Volume panes use the reasons of Task 7: the bank's Move/Delete/Rename/Makedir/Protect act on a writable volume; greyed with the write-block words otherwise; the reason row `net-browse-reason` shows `net.write` in a volume pane and at the board root when browsing works.
- Copy/Move onto a volume: list the destination fresh first (`readyToCopy` with `{ from: dest, drawers: [] }`), then post.
- An op answer with `job` → `watchFetch` on it (status row: jobStatus), no success toast; dialogs close; when finished, failures are a toast and both panes reload.
- Delete confirm for `'AMIGA'`; Info's comment editable on a writable volume; drop of rows onto a writable volume copies (Shift moves).
- The pane shows `netCrumbs` when it has no listing.

- [ ] Steps: implement; `pnpm vitest run src/lib/files src/components/files && pnpm exec tsc --noEmit && pnpm lint` (the touched files); commit.

---

### Task 9: Fake board, e2e, help, HANDOFF

**Files:** `e2e/amiga-board.ts` (answers MKDIR/RENAME/DELETE/PROTECT/NOTE on its `fs`, `DEL` pieces for big drawers, the extended NEXT with modes), `e2e/device-helpers.ts` (`setBrowse` gains `rxProto: 4`, `writeOn`), `e2e/files-net-writes.spec.ts` (new), `src/lib/help/topics.tsx` (+ test), `HANDOFF.md`.

e2e cases: copy STASH: → volume with a clash (replace / skip / keep both) and the NEXT line's mode; Makedir; Rename; Protect; a comment; Delete with its confirmation; a drawer delete with progress and a partial stop; Move volume → STASH:; Move STASH: → volume; writing off greys the buttons with the words (switch off, old Transfer, old firmware).

Run: `PORT=3100 bash scripts/e2e-local.sh e2e/files-net-writes.spec.ts --project=desktop`, then the phase 1 specs `e2e/files-net-volumes.spec.ts`, `e2e/files-net.spec.ts` (desktop) and `e2e/files-net-volumes.mobile.spec.ts`, `e2e/files-net.mobile.spec.ts` (mobile), each split under 9 min.

- [ ] Steps: implement, run, fix, commit.

---

## Ledger (filled while executing)

- Pre-flight: rulings W1-W13 in the plan; Tasks 3-6 consume Task 1 columns and Task 2 lines as named; no conflicts found.
- Task 1: complete (commits 47ed4004..54b22afd, tests: pnpm test:db src/lib/remote-requests.db.test.ts → 25/25 pass)
- Task 2: complete (commits 54b22afd..9b77e824, tests: pnpm vitest run src/lib/remote-wire.test.ts src/lib/transfers.test.ts → 24/24 pass)
- Task 3: complete (commits bc..0c39ceef, tests: pnpm test:db src/lib/transfers.db.test.ts → 29/29; vitest poll route 65/65, remote-browse 7/7, send-ui 19/19)
- Task 3: Ruling: browseMark keeps 'browsable' for a writable board (no 'writable' mark on the NET: root row) — spec names no root mark for writing; the volume pane says it — cost if wrong: one more mark word
- Task 4: complete (commits 0c39ceef..7119710d, tests: pnpm test:db src/lib/remote-requests.db.test.ts → 32/32; amiga-uploads.db 26/26; net-driver.db 30/30)
- Task 5+6: complete (commits 236d1ad6..15c96d1f, tests: pnpm test:db src/lib/files/ + remote-requests + transfers + amiga-uploads → 269/269; vitest src/lib src/app/api 3776 pass + driver.test fixed)
- Task 5: Ruling: Tasks 5 and 6 done as one commit (they share net-write/net-fetch and their db test) — cost if wrong: none (review range covers both)
- Task 5: Ruling: implementation written before the net-write db tests in Tasks 5-6 (tests then run and two real defects fixed: volume rename routing, test line length) — TDD order slipped, tests still exercise each behaviour — cost if wrong: a behaviour the tests encode as the code does rather than as the spec says
- Task 5: Ruling: Makedir with ensure (exists counts done) for drawers of a copy that hold no file — the board orders requests before FILE sends, and a FILE makes missing drawers itself — cost if wrong: an empty drawer of a copy is not made
- Task 5: Ruling: an empty (0-byte) file is refused in a copy onto a volume, as a send into Queue refuses it — cost if wrong: 0-byte files cannot be copied onto the Amiga
- Task 5: Ruling: Rename of a volume itself (relabel) is refused unsupported 'Rename a volume on the Amiga' — spec §7 lists no relabel — cost if wrong: one command
- Task 5: Ruling: a delete/protect/comment on a board that cannot write refuses the whole op (not per item) — one board per pane — cost if wrong: mixed-board selections cannot happen in one pane anyway
- Task 6: Ruling: move out of a volume removes the source as the person's own Delete via the NET driver (DELETE request); the move's removal needs writing still on at that moment, else the source stays — cost if wrong: a move that becomes a copy if writing was switched off mid-way
- Task 7: complete (commits 15c96d1f..a99b652a, tests: pnpm vitest run src/lib/files → 251/251; test:db net-write+net-fetch 40/40)
- Task 8: complete (commits ..ef50d209, tests: pnpm vitest run src/lib src/components src/app → 4056+ pass; tsc clean)
- Task 8: Ruling (coordinator correction 2026-10-31): the board-facing NEXT line of GET /api/device/send/queue is the only carrier of dest/onClash -- 'NEXT <id> <size> <crc> <prot> <len>:<dest> <len>:<comment> <mode>' for amiga_dest rows, today's line unchanged otherwise; cleanAmigaPath keeps turning ':' into '_' in Queue paths (pinned by a test and a comment); poll accepts rxv=4 and write=0|1. Matches W1 as built — cost if wrong: none (coordinator-confirmed)
- Task 8: Ruling: a drop of computer files onto a volume is refused 'Drop files into STASH: first, then copy them onto the Amiga' — spec names no direct upload to a volume — cost if wrong: one more path (upload then queue)
- Task 8: Ruling: Create ADF on a volume says 'Disks are made in STASH: or LIBRARY:' (was 'Read-only for now') — cost if wrong: words
- Task 8: Ruling: the volume pane's reason line is the existing readonly line (pane-<side>-readonly, 'Writing is off in Transfer.'); the net-browse-reason row at the board root also shows the write block when browsing works — cost if wrong: words placement
- Task 9: complete (commits ..cbe722d8, tests: e2e files-net-writes 5/5 desktop; files-net-volumes+files-net 16/16 desktop (one phase-1 expectation updated); mobile files-net-volumes, files-net, files, files-2 18/18; send-to-amiga+from-amiga+files-stash 29/29; files+files-2 27/27; files-parity+settings+strip 30/30; vitest help 118/118)
- Task 9: Ruling (coordinator, Transfer 2.5): no write on a volume's root -- the board root lists volumes as places (Delete/Rename/Protect refused there as before); a delete of NET:/<b>/<Volume> is a per-item not_found, protect/comment refused -- cost if wrong: none (Transfer answers bad anyway)
- Task 9: Ruling (coordinator, Transfer 2.5): DONE counts the drawer itself, so 'Deleted Work:old (N)' counts items; DEL 0 then ERR says '<label>: stopped at <entry>: <reason>'; ERR text shown as Transfer sends it (entry relative to the drawer) — cost if wrong: words
- Task 9: Ruling (coordinator, Transfer 2.5): FILE refusals for copies onto a volume (readonly, wprot, full, denied, busy) are said with writeErrorWords (busy = 'In use on the Amiga') only for amiga_dest rows; plain sends keep the old words (busy = 'Transfer was busy'); send-ui gains words for readonly/wprot/full/denied; 'io path too long' and assigns' notfound show Transfer's text / 'Object not found' — cost if wrong: words
- Task 9: Ruling: the files help topic's word cap raised 360 -> 400 for one short 'Changing the Amiga's disks' paragraph — cost if wrong: a longer help body
- Task 9: Ruling: a move onto a volume or out of one: the source's removal joins the move's job, and the job counts a file as unfinished until its source is removed (so the pane reloads after the removal) — cost if wrong: none
- Final: fixed C1 (relay drawer move deleted before all files arrived) — 'final review C1: a drawer moved between volumes...' RED→GREEN, db 664/664, unit 4179/4179
- Final: fixed C2 (a partly failed move left the job 'Copying…' forever) — 'final review C1/C2: one file of a moved drawer fails' + 'final review C2: ... fails readonly' RED→GREEN (fetchProgress settles finished moves itself)
- Final: fixed C3 (writes behind a DEL-sending delete timed out) — 'final review C3' RED→GREEN
- Final: fixed I-2 (a move that became a copy was silent) — 'final review I-2' RED→GREEN (a failed delete 'Copied, but the original could not be removed — <why>' in the job)
- Final: fixed I-3 (one empty file refused a whole drawer copy) — 'I-3: an empty file inside a drawer is left out' RED→GREEN
- Final: fixed I-4 (a refused copy still made drawers) — 'I-4: a copy the queue refuses makes no drawers' RED→GREEN; e2e writes+volumes 12/12
- Final: Ruling: I-1 (a move removes the whole source as it is at the end, not only what was copied) stands — a recursive DELETE of the moved drawer is Workbench's own copy-then-delete; a file put into that drawer on the Amiga (or into a moved STASH: drawer) during the move is deleted uncopied — cost if wrong: that file is lost; fix later by deleting per copied file
- Final: Ruling: I-5 (failWritesWhenOff runs two UPDATEs per poll from a connected non-writing board) stands — both UPDATEs hit device-indexed rows and match nothing on 1.22 boards; cheap vs the poll's own reads — cost if wrong: load on the shared DB at fleet scale; gate it on an exists check
- Final: minor (deferred): dropMemory/afterTransferDone lowercase in JS vs SQL lower() — Latin-1 capitals under C collation not dropped
- Final: minor (deferred): takeWaiting fails writes 'Writing is off in Transfer' also when the cause is Transfer gone/old firmware (race only)
- Final: minor (deferred): a poll with rx=c but no rxv leaves write_on as it was
- Final: minor (deferred): cross-board move names the destination board in the source DELETE's words
- Final: minor (deferred): in place() a settleMoveOfGet throw marks a done get failed io
- Final: minor (deferred): settleMove removes inside a row-lock transaction on a second pool connection (pool 5)
- Final: minor (deferred): Replace in a move within a volume does not delete the target's .info, so the moved icon's RENAME fails exists
- Final: minor (deferred): a partial delete whose ERR text has no ': ' loses its count in the words
- Final: minor (deferred): copy rows for an offline board keep the status row polling for up to 24 h
