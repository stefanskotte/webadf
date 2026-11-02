# Big copies, disks as folders, up row, panel minors: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copy whole disks onto an Amiga volume as folders named like their rows, with a roomy queue, an up row in the listing, and the five panel minors fixed.

**Architecture:** Server and web only. Queue limits are constants; a new `disks-as-folders.ts` turns DSK and TTL sources into per-disk `IncomingTop`s for the existing `copyOntoVolume`; the pane gains a row outside its `rows` array.

**Tech Stack:** Next.js (read `node_modules/next/dist/docs/` before route or page code), TypeScript, Drizzle, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-02-big-copies-disks-as-folders-design.md` (read it; its rulings bind).

## Measured before planning (2026-11-02, from the operator's Mac to the real Blob store, 12 at a time)

| Copy | `storeSendBytes` | second `stat` pass (`queueTransfers`) |
|---|---|---|
| Largest disk, 214 files | 8.8 s | 3.4 s |
| Four largest, 719 files, 2.7 MB | 25.4 s | 11.8 s |
| The same, already stored | 24.6 s | 11.7 s |

So: remove the second pass when the bytes are in hand (37 s becomes 25 s, target under 30 s met); no per-disk requests are needed; `COPY_MAX_DISKS` is **8**. Task 1's hosted check re-measures from Vercel.

## Global Constraints

- `SEND_QUEUE_MAX_FILES = 1000`, `SEND_QUEUE_MAX_BYTES = 128 * 1024 * 1024`, `SEND_FILE_MAX` unchanged, `COPY_MAX_DISKS = 8`.
- `net-fetch.ts` keeps `FETCH_MAX_FILES` 64 / `FETCH_MAX_BYTES` 16 MB (Amiga to web, Transfer's `RX_UP_MAX`).
- No firmware, Transfer or driver disk change. No drawer icons on disk folders: never send `drawerIcon` from this path. No title folder. No migration expected.
- Up row text exactly `Up one level`; chip holds `↑`.
- Repo rules for every implementer: stage explicit paths; **no `git stash` in any form, for any reason** (use `git show <sha>:<path>`); e2e only as `PORT=3100 pnpm e2e <specs>`, serialised, each invocation under 9 minutes, in the foreground, never ending your turn while one runs; never kill by pattern, only your own PID. Work in `.claude/worktrees/big-copies`. Do not push or merge: the controller does.
- `src/lib/help/topics.tsx` changes with the behaviour it describes.
- Self-hosting parity: constants, not env; nothing Vercel-only.

## Review Focus

1. **A selection where nothing can go** (every disk unreadable, or all Skip): no job, no empty card, and words saying why, never "done". Test in Task 2.
2. **A copy over the limit with a part-full queue:** refused before any store write, with the queue-full words. Test in Task 1.
3. **Up row with a filter on, in an empty folder, under any sort:** stays first and goes up; a filter matching nothing still shows it. Test in Task 4.
4. **A disk label the Amiga cannot take** (`Foo: Bar`, 31+ characters): that disk refused by name, others go. Test in Task 2.
5. **Clash on one disk of a title's four:** the three others are not lost or doubled when the answer comes back. Test in Task 3.

---

## Part 1 (merges alone)

### Task 1: Raise the queue limits

**Files:**
- Modify: `src/lib/send-limits.ts`, `src/lib/transfers.ts:143-193`, `src/lib/files/net-write.ts:237,270-271`, `src/lib/files/words.ts:55`, `src/lib/files/net-driver.ts:87-95`, `src/lib/help/topics.tsx`
- Test: `src/lib/transfers.db.test.ts`, `src/lib/files/net-write.db.test.ts`, `src/lib/files/words.test.ts`, `src/lib/files/net-send.test.ts`, `src/lib/files/net-rules.test.ts`; `e2e/files-net.spec.ts:248`

**Interfaces:**
- Produces: the constants above; `queueFullWords(): string` exported from `send-limits.ts` returning exactly `The board's queue holds 1,000 files / 128 MB; wait for it to empty or cancel some.`, built from the constants.

- [ ] **Step 1: Write failing tests:**
  - `words.test`: `refusalWords('queue_full')` equals that sentence; `net-send.test` likewise.
  - `net-write.db.test` `copies 65 files`: a copy of 65 files onto a volume is queued as 65 rows; `the limits` case changes to `SEND_QUEUE_MAX_FILES + 1` files, refused `queue_full`.
  - `net-write.db.test` `over the limit with a part-full queue`: queue already holding `SEND_QUEUE_MAX_FILES - 1` rows, copy of 2 in-memory files: `queue_full`, and a spy on `diskStore.put` was never called.
  - `transfers.db.test` `no second stat`: `queueTransfers` with `bytes` on every file calls `diskStore.stat` zero times; without `bytes` it still answers `no_blob` for an absent sha.
  - `net-driver` test: a Queue listing with 150 waiting rows has meta containing `150 waiting` and `newest 100 shown`; `cancelQueueSends` cancels all 150.
- [ ] **Step 2: Run** `pnpm vitest run src/lib/files/words.test.ts src/lib/files/net-send.test.ts` and `pnpm vitest run --config vitest.db.config.mts src/lib/transfers.db.test.ts src/lib/files/net-write.db.test.ts`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.**
  - Constants and `queueFullWords()`; `words.ts` calls it. `net-write.ts` stops using `FETCH_MAX_*`; its doc comment follows.
  - In `copyOntoVolume`, after `files` is built and before `storeSendBytes`: `queueLoad`, and `refuse('queue_full', 409)` when the copy cannot fit. The transaction's check stays for the race.
  - In `queueTransfers`, a file with `bytes` takes its size from them and skips `stat`.
  - The existing tests that fill the queue use the constants rather than literals. `e2e/files-net.spec.ts:248` must not upload 1,000 files: seed the rows through its existing DB helper, or import the words and fill with 4 MB rows if that is what the spec does.
- [ ] **Step 4: Run** the Step 2 commands, then `PORT=3100 pnpm e2e e2e/files-net.spec.ts e2e/send-to-amiga.spec.ts --project=desktop`. Expected: PASS.
- [ ] **Step 5: Commit** explicit paths: `Queue limit 1,000 files / 128 MB; copies onto a volume use it; a big copy is refused before it stores anything`.

**Controller after Task 1:** review, merge to master, push, then re-measure a four-disk store from a Vercel function if the deployed path shows it (a 200-file STASH: drawer copy works too), and report.

---

## Part 2 (merges alone)

### Task 2: Server: DSK and TTL sources onto a volume

**Files:**
- Create: `src/lib/files/disks-as-folders.ts`, `src/lib/files/disks-as-folders.db.test.ts`
- Modify: `src/lib/files/ops.ts:79-93` (one call after the `shelfDest` check), `src/lib/files/library-driver.ts` (export `walk`), `src/lib/files/library.ts` (export `diskName`), `src/lib/remote-limits.ts`

**Interfaces:**
- Produces:
  - `COPY_MAX_DISKS = 8` in `remote-limits.ts`.
  - `DISKS_STAY_IN_LIBRARY = 'Disks stay in the library: use Copy.'` in `shelf-rules.ts`.
  - `copyDisksOntoVolume(ctx: OpCtx, req: CopyMove, dest: FsPath): Promise<Outcome | null>`: null unless `dest` is a volume directory (`isNetVolumeDir`) and at least one source is a DSK row (`placeInLibrary` level `disk`, empty `names`) or a TTL row (level `title`).
- Consumes: `copyOntoVolume(ctx, dir, tops, onClash)`, `loadDisk`, `walk`, `checkName`, `itemResult`.

Behaviour:
- A source that is neither row kind, mixed in: `refuse('unsupported', 400, ...)`, whole.
- `req.op === 'move'`: `refuse('unsupported', 400, DISKS_STAY_IN_LIBRARY)`.
- A TTL expands to its local disks in `diskNo` order, each then a source in its own right under its disk path (`lib(...prefix, gameId, diskId)`).
- More than `COPY_MAX_DISKS` after expansion: `refuse('too_large', 413, 'at most 8 disks at a time')`, built from the constant, before any image is read.
- For each disk, per item (an unreadable one never stops the others): `loadDisk`; no filesystem or unreadable: refusal `unsupported` with `<name> cannot be read as files`; `checkName(name)`; `walk(d.bytes, entry, [name, ...], out)` over the root's children, with a first item `{ rel: [name], kind: 'dir', ... }`; any file over `SEND_FILE_MAX` refuses that disk `<name>: <file> is over 4 MB`. A `Refused` from `walk` is that disk's refusal. A store failure (`BlobUnavailableError`) is that disk's refusal too.
- The readable disks go to `copyOntoVolume` as tops; its items are merged with the refused ones, in source order. All refused: `{ kind: 'done', items, written: [] }` with no `job`. Clashes: returned as they are, `source` being the disk path.

- [ ] **Step 1: Write failing DB tests** (`disks-as-folders.db.test.ts`, fixtures as `net-write.db.test.ts` builds a board and remembered listing, with real ADFs from `library.db.test.ts`'s builder):
  - `a DSK row makes a drawer`: transfers rows' `amigaDest` all start `Work:Monkey/Disk 1/`, one per file on the ADF, with nested paths; no `remote_requests` row has `args.drawerIcon`.
  - `an empty disk still makes its drawer`: one `mkdir` request, `ensure` true, for `Work:Monkey/Disk 1`.
  - `a TTL row is its disks`: a two-disk title gives rows under `Disk 1/` and `Disk 2/` and none under the title's name; items' sources are the two disk paths.
  - `move is refused` with `DISKS_STAY_IN_LIBRARY`; the disk still exists.
  - `nine disks` refused `too_large`, `at most 8 disks at a time`; `loadDisk` not reached (spy `diskStore.read`).
  - `one unreadable disk`: non-DOS and good disk: good one queued, bad item `ok: false` naming it.
  - `nothing can go`: all unreadable: no `job`, no rows, every item refused.
  - `a label the Amiga cannot take`: `Foo: Bar` refused by name; the other goes.
  - `a clash`: `Disk 1` in the remembered listing and `onClash: 'ask'`: `clashes[0].source` is the disk path, nothing queued; `replace` then gives rows with `onClash` `replace` and no delete request.
  - `two disks share a name`: refused `name_exists`.
  - `a disk row onto STASH:` still answers the refusal it does today (`copyDisksOntoVolume` returns null).
- [ ] **Step 2: Run** `pnpm vitest run --config vitest.db.config.mts src/lib/files/disks-as-folders.db.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the module and the `ops.ts` call. Titles filed onto a shelf are unchanged: the call goes after `shelfDest`.
- [ ] **Step 4: Run** Step 2's command plus `src/lib/files/ops.db.test.ts src/lib/files/net-write.db.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** explicit paths: `A DSK or TTL row copied onto a volume arrives as a drawer per disk`.

### Task 3: Files UI: offer it, say it, help

**Files:**
- Modify: `src/lib/files/shelf-rules.ts`, `src/components/files/files-manager.tsx:733` (`transferReason`) and `:767-768` (`copyTo`, `moveTo`), the drag path at `:1344`, `src/components/files/copy-to-picker.tsx`, `src/lib/help/topics.tsx`
- Test: `src/lib/files/shelf-rules.test.ts`, `src/components/files/copy-to-picker.test.ts`; Create: `e2e/files-disks-as-folders.spec.ts`

**Interfaces:**
- Consumes: `DISKS_STAY_IN_LIBRARY`, Task 2's server behaviour.
- Produces: `diskCopyReason(op: 'copy' | 'move', picked: FsEntry[], dst: Listing | null): string | null | undefined` in `shelf-rules.ts`: undefined unless `dst` is a NET: volume and every picked row is `title` or `disk`; else `op === 'move'` gives `DISKS_STAY_IN_LIBRARY`; an unwritable volume gives its reason; null otherwise. `transferReason` asks it first, after `outOfNet`.

- [ ] **Step 1: Write failing tests:** `shelf-rules.test`: the five answers of `diskCopyReason`, including a selection holding a collection (undefined, so `COLLECTIONS_STAY` still answers). `copy-to-picker.test`: DSK rows offer writable volume directories and not STASH:. e2e, on the fake board `e2e/files-net-writes.spec.ts` uses, desktop and mobile:
  - `four disks in Monkey`: Makedir `Monkey`, enter it in one pane, go to a title's disk list in the other, select two DSK rows, Copy: the destination shows `Disk 1` and `Disk 2` arriving; the panel shows one card.
  - `Copy from a TTL row` likewise; `Move` is disabled on DSK rows with `DISKS_STAY_IN_LIBRARY` as its title.
  - `a clash on one of a title's disks`: answer Replace: every disk queued exactly once (count rows per `amigaDest` from the API).
- [ ] **Step 2: Run** `pnpm vitest run src/lib/files/shelf-rules.test.ts src/components/files/copy-to-picker.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Rows at the title level must be draggable to a volume and reach Copy. Read `clashGroups` first: when the clash answer comes back it must send what the clash named, and not re-send a TTL whose other disks have already gone. If the server's first answer on a clash queued nothing (it does: clashes return before queueing), re-sending the original sources with the answer is correct, and the test proves it. Help: the topic for Files copies says a disk or title copies as folders named like the rows, no icons until Show All Files, Replace leaves other files in the folder, at most 8 disks at a time.
- [ ] **Step 4: Run** Step 2's command, then `PORT=3100 pnpm e2e e2e/files-disks-as-folders.spec.ts e2e/files-net-writes.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** explicit paths: `Files offers Copy on DSK and TTL rows onto a volume; help says what arrives`.

### Task 4: The up row

**Files:**
- Modify: `src/components/files/pane.tsx:125,166-169,171,304,404`, `src/lib/help/topics.tsx` if it names the title bar's arrow
- Test: `src/components/files/pane.test.ts:135-137,223`, `e2e/files-net-writes.spec.ts:91`, `e2e/files.spec.ts`

**Interfaces:**
- Produces: test id `pane-<side>-up-row`. `pane-<side>-up` no longer exists.

- [ ] **Step 1: Write failing tests:** `pane.test`: with a parent, the first `tbody` row has `up-row`, a `button` named `Up one level`, the chip `↑`, no checkbox; at a root none; `pane-left-up` absent; with `entries: []` it is still rendered above `Nothing here.`; with a filter matching nothing it is still rendered. e2e in `files.spec.ts` (desktop, mobile): click goes up one level; a real double-click (`dblclick`) from two levels down lands exactly one level up; Select all leaves it unselected and the count unchanged; ArrowDown from the top lands on the first real row; Tab reaches the control and Enter goes up.
- [ ] **Step 2: Run** `pnpm vitest run src/components/files/pane.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** A `<tr>` before `rows.map`, outside `rows`, no `aria-selected`, its name cell holding a `<button>` with the same chip classes as `glyphOf`'s and the muted colour; finger-sized below `lg` (`max-lg:min-h-11`). `onClick={(ev) => { if (ev.detail > 1) return; p.onNavigate(parent.path); }}`, and the row keeps a stable React key so the second click of a double-click lands on the same element; if the e2e shows it is replaced on navigation, hold it with a timestamp guard instead (ignore a click within 500 ms of the last go-up). Remove the title bar's button and fix the comment at `:171`. The left-edge strip and the bank's Parent and Root stay. Verify on the phone layout that a refused NET: place still has Parent reachable; if not, say so to the controller.
- [ ] **Step 4: Run** Step 2's command, then `PORT=3100 pnpm e2e e2e/files.spec.ts e2e/files-net-writes.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** explicit paths: `Files: an Up one level row heads the listing; the title bar's arrow goes`.

**Controller after Task 4:** review the part, merge, push, A500 bench per the spec's "Done means".

---

## Part 3 (merges alone)

### Task 5: Panel minors

**Files:**
- Modify: `src/lib/files/job-view.ts:152,204-211`, `src/lib/files/jobs-client.ts:9-12,61-68,103-113`, `src/components/shell/transfers-panel.tsx:87`
- Test: `src/lib/files/job-view.test.ts`, `src/lib/files/jobs-client.test.ts`, `e2e/transfers-panel.spec.ts`

**Interfaces:**
- Produces: `IDLE_POLL_MS = 60_000` in `jobs-client.ts`.

- [ ] **Step 1: Write failing tests:**
  - `job-view.test`: a cancelled move, `done 2 of 8`, source `STASH:/x`: `resultWords` is `Cancelled: 2 of 8 copied; the rest is still in STASH:/x`.
  - `job-view.test`: `confirmWords` of a `QUEUE_JOB` job with 12 waiting on `A500` is `Cancels all 12 files waiting for A500. What has arrived stays.`, and with 1 is `Cancels the 1 file waiting for A500. What has arrived stays.`; other kinds unchanged.
  - `jobs-client.test`: `nextDelay([], { visible: true, tracking: false, failed: false })` is `IDLE_POLL_MS`; hidden stays null; running stays as now. After `onVisibility` with visible true a tick runs.
  - `jobs-client.test`: two jobs finishing with identical `resultWords`: `state.announce` differs between the two (a trailing U+00A0 toggled), and reads the same to the eye.
  - `e2e/transfers-panel.spec.ts`, mobile project: with a card showing and search open, `document.elementFromPoint` at the panel's centre is not inside the panel.
- [ ] **Step 2: Run** `pnpm vitest run src/lib/files/job-view.test.ts src/lib/files/jobs-client.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The verb change, the words, `nextDelay` returning `IDLE_POLL_MS` where it returned null while visible, the toggled space, and `max-lg:z-20` on the panel. Check nothing else on a phone page then covers the panel (the tab bar is z-40 and the panel sits above it by offset). Update any test or e2e that quotes `moved` for a cancelled move or asserts idle silence, keeping the spec's rule that nothing polls while hidden.
- [ ] **Step 4: Run** Step 2's command, then `PORT=3100 pnpm e2e e2e/transfers-panel.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit** explicit paths: `Panel: cancelled moves say copied, Queue cancel says it takes all, idle pages look every 60 s, under the phone search, repeats announced`.

---

**Controller at the end:** whole-branch review of each part before its merge and of the fixes after; unit, DB and touched e2e green; update `HANDOFF.md` §4 Current order, memory; relay every finding and ruling to the operator; tell the operator what to pass to Pillock.
