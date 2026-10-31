# Safe moves (protocol 5) — server and web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Move removes only what it copied, in every direction: from a volume by one `DELETE … one` per copied file then
per copied drawer (deepest first; `notempty` keeps the drawer and says so), from STASH:/LIBRARY: by removing only the
copied entries (a drawer only once empty); a Move from a volume on protocol 4 is refused before anything is copied.

**Architecture:** The move's second half stays in `net-moves.ts` (`settleMove`), which today removes the whole source
as it is at the end (web ruling I-1). It now builds the list of what was copied from the move's own parts -- the gets
(their Amiga paths and the walk's drawers, `target.moveDrawers`), the queue rows (`transfers.move_item`, the source
entry's rel path) and the Makedirs of empty drawers (`target.moveSource/moveItem`) -- and removes exactly those. The
STASH: and LIBRARY: drivers' `remove(ctx, sources, unchanged)` changes from "all or nothing, exactly as collected" to
"each collected entry still as collected goes; a drawer only once empty; anything kept is said"; crossDevice and the
settle path share it.

**Tech Stack:** Next.js 16, drizzle-orm/Postgres (`drizzle-kit generate`), vitest (`pnpm test`, `pnpm test:db`), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-10-31-net-volumes-writes-design.md` §9 (with §1-§4). Previous plan:
`docs/superpowers/plans/2026-10-31-net-writes-web.md` (rulings W1-W13, ledger).

## Global Constraints

- Poll `rxv=5` accepted and stored as `rx_proto 5`; protocol 5 implies everything protocol 4 does (`>= 4` checks stay).
- `MOVE_PROTO = 5`. Request line `DELETE <rid> <len>:<path> one` (literal trailing ` one`) only for a request whose
  target says `one: true`, and only handed to a board whose `rx_proto >= 5` (else failed at take time, never sent).
- Answer `ERR <rid> notempty <len>:<text>` is a known code; `writeErrorWords('notempty')` = "The drawer is not empty".
- Protocol 4 refusal words (verbatim, dash as the UI writes it): "Move needs Transfer 2.6 — use Copy".
- Kept words: "Kept <label>: something new is in it" (label = `Work:X` for a volume, the Files path for STASH:/LIBRARY:).
- Nothing is removed unless every part of that moved top ended done (W7 kept).
- Commits carry no attribution trailer; never `git add -A`, never `git stash`; never touch `wifi-floppy/` or `tools/receive/`.
- e2e only via `PORT=3100 bash scripts/e2e-local.sh <specs> --project=desktop`, foreground, < 9 min each.
- DB tests: `export TEST_DATABASE_URL=$(bash scripts/dev-db.sh start | tail -1); pnpm test:db <path>`.

## Rulings made while planning

- S1 **Top granularity stays (W7):** a moved top is removed only once every part of it ended done; then per entry. A
  partly failed move still keeps the whole source. Cost if wrong: a failed file's siblings stay in the source (a copy).
- S2 **Within one volume (RENAME) stays allowed on protocol 4:** it copies nothing, so it cannot lose a file; the
  refusal covers moves that copy (volume → STASH:/LIBRARY:/another volume). Cost if wrong: one condition.
- S3 **The source's icon is not removed by a move** unless it was itself picked (it was not copied). Cost if wrong: an
  orphan `X.info` stays beside where `X` was.
- S4 **A `DELETE … one` answered `notfound`** (already gone on the Amiga) counts as done; `notempty` counts as done with
  `kept`. Neither is a failure of the move.
- S5 **`transfers.move_item`** (new column, migration 0056): the source entry's rel path (`Pack/sub/x`, rel[0] the
  top's name as collected) for a STASH:/LIBRARY: → volume move row. Needed to know what was copied after the fact.
- S6 **STASH:/LIBRARY: drawers:** a collected drawer goes only once nothing is left under it; an empty drawer made in
  the source during the move is not one that was collected and stays. Changed files stay (content compared: sha256,
  bits, comment; LIBRARY: also the date when known).
- S7 **The protocol 4 refusal is the server's** (a toast); the pane does not grey Move for it. Cost if wrong: a tooltip.
- S8 **Settle on protocol 4 at the end** (Transfer downgraded mid-move): the removal is not sent; the job says
  "Copied, but the original could not be removed — Move needs Transfer 2.6 — use Copy".

## Review Focus

1. A file saved into the source drawer during a Move survives in every direction, and the move says what was kept --
   Task 3 (volume), Task 4 (STASH:/LIBRARY:), Task 6 (e2e).
2. A board on Transfer 2.5 never receives `DELETE … one` (take-time guard) -- Task 2.
3. A drawer with an empty subdrawer moved off a volume: the empty one is deleted too (it is in moveDrawers), the top
   then goes -- Task 3.
4. A Latin-1 / labelled-volume source (`Empty (DF1:)`): DELETE uses the Amiga path, the label the pane's -- Task 3.
5. A move from STASH: whose drawer gained a file: the copied files leave STASH:, the new one and its drawer stay, the
   item says Kept -- Task 4.

---

### Task 1: Wire, limits, words, poll, migration

**Files:** `src/lib/remote-limits.ts` (`MOVE_PROTO`), `src/lib/remote-wire.ts` (+test), `src/lib/remote-browse.ts`
(`MOVE_OLD_TRANSFER`, `keptWords`, notempty words, +test), `src/lib/files/net-rules.ts` (`isNetWords`),
`src/lib/files/words.ts` (+test), `src/app/api/device/poll/route.ts` (+route test), `src/db/schema/transfers.ts`
(`moveItem`), `src/db/schema/devices.ts` (comment), `drizzle/0056_*.sql`.

**Produces:** `MOVE_PROTO = 5`; `requestLine({kind:'delete', target:{one:true}})` = `DELETE r 8:Work:old one\n`;
`parseAnswerLine` accepts `ERR r notempty 3:abc`; `MOVE_OLD_TRANSFER = 'Move needs Transfer 2.6 — use Copy'`;
`keptWords(label) => \`Kept ${label}: something new is in it\``, `isKeptWords(s)`; `refusalWords('unsupported',
MOVE_OLD_TRANSFER)` = `"Move needs Transfer 2.6 — use Copy."`; `refusalWords('conflict', keptWords('STASH:/P'))` =
`"Kept STASH:/P: something new is in it."`; poll `rxv=5&browse=1&write=1` → rx_proto 5, write_on true.

- [ ] Failing tests (wire line, ERR notempty parse, words, poll rxv=5) → run FAIL → implement → PASS.
- [ ] Add `moveItem: text('move_item')`; `pnpm exec drizzle-kit generate --name move_item`; the SQL is one ADD COLUMN.
- [ ] Commit.

### Task 2: Requests — `one`, kept, take-time guard, move parts

**Files:** `src/lib/remote-requests.ts`, `src/lib/remote-requests.db.test.ts`.

**Produces:** `WriteReq` gains `one?: boolean; move?: { source: string; item?: string }` → target `{ one: true }`,
`{ moveSource, moveItem }`; `WriteTarget` gains `one?, kept?, moveSource?, moveItem?`. `writeLines`: for a `one`
DELETE, `ERR notempty` → done with `answer = { removed: 0, kept: true }`, `ERR notfound` → done. `takeWaiting`: a
waiting `one` DELETE of a board with `rx_proto < 5` fails `proto` with text "Copied, but the original could not be
removed — Move needs Transfer 2.6 — use Copy" and is not returned.

Tests: one-DELETE answered notempty → done, kept; notfound → done; on an rx_proto 4 board it fails and the board
gets nothing; on 5 the line ends ` one`.

- [ ] RED → GREEN → commit.

### Task 3: Moves off a volume remove only what was copied

**Files:** `src/lib/files/net-fetch.ts` (proto refusal in `startFetch`/`volumeToVolume` for moves; `moveDrawers` on
each get of a moved top; Makedirs of a moved top marked as parts), `src/lib/files/net-moves.ts` (parts = gets +
marked mkdirs + rows; volume removal = `one` DELETEs: files, then drawers deepest first; labels in the pane's words;
proto check S8), `src/lib/files/net-fetch.ts` `fetchProgress` (`JobWrite.kept`), `src/lib/files/manager-rules.ts`
`jobStatus` (kept parts) + tests, `src/lib/files/net-write.db.test.ts`.

**Produces:** `GetTarget.moveDrawers?: string[]` (Amiga paths); `JobWrite.kept: boolean`; jobStatus finished line
includes `Kept Work:Pair: something new is in it` for a kept write and never lists it as Deleted.

Tests (db, the existing board w1 set to rx_proto 5): volume → STASH: of drawer `Pair` (a, b, empty `E`): after both
arrive, the writes are `delete Work:Pair/a one`, `delete Work:Pair/b one`, `delete Work:Pair/E one`, `delete
Work:Pair one` in that order (no recursive DELETE); answering `Pair` notempty → progress says kept; volume → volume
same; volume → LIBRARY: a file `game.adf` → one `delete … one`; protocol 4: move from a volume refused with the words,
no get made; copy still allowed; within-volume RENAME still allowed on 4; a settle when the board went to 4 → failed
row with S8 words, nothing sent. Existing move tests updated to the new lines.

- [ ] RED → GREEN → commit.

### Task 4: STASH:/LIBRARY: remove only the copied entries

**Files:** `src/lib/files/stash-driver.ts` (`remove` with `unchanged`), `src/lib/files/library-driver.ts`
(`removeCopied`), `src/lib/files/ops.ts` (crossDevice keeps a Kept detail), `src/lib/files/net-write.ts`
(`moveItem` on rows, move parts on Makedirs), `src/lib/transfers.ts` (`QueueFile.moveItem`), `src/lib/files/net-moves.ts`
(STASH:/LIBRARY: removal from rows), tests `net-write.db.test.ts`, `stash-ops.db.test.ts`, `ops.db.test.ts`.

**Produces:** `remove(ctx, sources, unchanged)` on STASH:/LIBRARY:: each collected entry matched (STASH: by id, else by
rel path, case-insensitive; content as S6) is deleted; collected drawers deepest first only when nothing remains under
them; item `ok` when all went, `{code:'conflict', detail: keptWords(<Files path>)}` when a drawer top kept something,
`REMOVE_FAILED` when a file top changed. settleMove builds `unchanged` from delivered rows (`rel = moveItem`, sha256,
bits, comment) + done marked Makedirs + their ancestors, and records a kept result as a `done` delete row with
`kept` in the job (S4 words).

Tests: STASH: drawer `Pack` (one, two) moved onto a volume; `Pack/new.txt` added before delivery → after delivery
`Pack/new.txt` stays, one/two gone, the job says `Kept STASH:/Pack: something new is in it`; STASH: → LIBRARY: move of a
folder whose new file appeared after the collect (stash seam: insert between collect and remove via the library edit
seam) → the new file stays, item Kept; LIBRARY: → LIBRARY: (between disks) with a file added to the source folder after
the copy edit (ops.db seam) → copied files gone, new one stays, item Kept; the existing "changed original" test holds.

- [ ] RED → GREEN → commit.

### Task 5: Help

**Files:** `src/lib/help/topics.tsx` (+its test word cap): "A Move off a volume needs Transfer 2.6 and removes only
what it copied." Commit.

### Task 6: Fake board and e2e

**Files:** `e2e/amiga-board.ts` (`DELETE … one`: a file, an empty drawer, else `ERR notempty`; `fakeBoardTiming.onRequest`
hook), `e2e/device-helpers.ts` (`rxProto: 5`), `e2e/files-net-writes.spec.ts`.

e2e: existing move test on rxProto 5; a drawer moved Work → STASH: with a file added on the Amiga when the first GET
comes → it survives, the status row says Kept; a STASH: drawer moved onto Work with a file added to it while the queue
is held → it stays in STASH:, Kept; a drawer moved Work → a second volume of the same board with a file added mid-move;
protocol 4: Move from Work refused with the words, nothing deleted, no `one` served.

Run files-net-writes, files-net-volumes, files-net (desktop), plus `pnpm test`, db tests. Commit.

### Task 7: Final whole-branch review (one fresh opus reviewer), fixes RED→GREEN, ledger.

## Ledger (filled while executing)
- Pre-flight: Tasks 2-4 consume Task 1's MOVE_PROTO / words / move_item; Task 3-4 consume Task 2's WriteReq.one/move and the kept answer; no conflicts.
- Ruling: the ledger lives in this plan (as the previous plan's did), not an sdd workspace — cost if wrong: none.
- Task 1: complete (05e42267, tests: vitest poll route + remote-wire + remote-browse + words → 120/120; migration 0056_move_item = one ADD COLUMN)
- Task 2: complete (tests: pnpm test:db src/lib/remote-requests.db.test.ts → 37/37)
- Task 3: complete (tests: pnpm test:db src/lib/files/ + remote-requests + transfers → 264/264; vitest manager-rules 31/31 (kept case RED against the old file first); tsc clean)
- Task 3: Ruling: the copied files' DELETEs go in Amiga-path order (case-insensitive), not get order — gets of one insert share a timestamp, so their order is not the walk's — cost if wrong: none (each is one object)
- Task 3: Ruling: a volume → LIBRARY: move is covered by the same settle path (one test, a disk image) — drawers onto LIBRARY: are refused before anything is asked, as before — cost if wrong: none
