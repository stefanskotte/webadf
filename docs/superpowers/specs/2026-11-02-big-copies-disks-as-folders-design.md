# Big copies, disks as folders, the up row, panel minors

Date: 2026-11-02. Status: approved by the operator 2026-11-02.

## Why

Pillock, a tester, wanted to copy Monkey Island onto his Amiga the way he thinks of it. He made a drawer called Monkey
in Files (it got its icon automatically), went into it, then copied the disks one by one, expecting folders Disk 1, 2,
3 and 4 to appear inside it. Two things stop that today. The server refuses a disk row as a copy source ("not an entry
on a disk"), and even copying a disk's contents by hand fails, because the board's queue holds 32 files.

Bench 2026-11-02: Monkey Island Disk 1 has more files than the queue holds. Measured over `adf-archive/`: 49 of 61
disks read as files; 24 of those hold more than 32 files, 17 more than 64, 6 more than 128. The largest holds 214 files
and 22 drawers; the most drawers on one disk is 46; none of the eight largest by file count exceeds 750 KB. File count
is what bites, not bytes.

While in that pane the operator also found "up one level" too far from the listing, and five minor defects were left
over from the progress panel.

## Goals

1. A whole disk, and several disks, can be copied onto an Amiga volume in one go.
2. Selecting DSK rows (or a TTL row) and pressing Copy makes folders on the Amiga named as the rows are, holding all of
   each disk's files.
3. Going up a level is a row at the top of the listing, not a button in the title bar.
4. The five progress panel minors are fixed.

## Non-goals

- **No drawer icons on these folders.** Operator's ruling. No Transfer change, no driver disk, no firmware change, no
  release. Consequence, stated to the operator: the folders do not show on Workbench until Show All Files; they do in
  Files and the Shell. Reversal, if wanted later: Transfer must add the icon when the drawer already exists, because a
  file arriving first creates the drawer and `MKDIR ... icon` then answers `exists` with no icon (`rx_proto.c:503-506`).
- **No title folder.** Operator's ruling. A TTL row copies its disks straight into the destination.
- Amiga to web copies keep their limits (see part 1).
- The 4 MB limit per file stays.

## Anti-goals

- A big queue must not be able to stall or wedge a board or Transfer.
- Move must never take a disk out of the library.
- One unreadable disk must not stop the others in a selection.

## Part 1: the queue limit

Each part merges on its own, in this order.

**Numbers (builder's starting point; my call, operator accepted):** `SEND_QUEUE_MAX_FILES` 1,000 and
`SEND_QUEUE_MAX_BYTES` 128 MB (`src/lib/send-limits.ts`). A limit stays because queued rows expire after 24 hours
(`SEND_EXPIRE_MS`): at the slowest speed seen, 2.2 KB/s on a chip-only A600, a day moves about 190 MB, so 128 MB can
finish in time and an unlimited queue might not.

**The second limit:** copies onto a volume also stop at `FETCH_MAX_FILES` 64 / `FETCH_MAX_BYTES` 16 MB in
`net-write.ts:270-271`. That path takes the send limits instead. `net-fetch.ts` (Amiga to web, and the first half of
volume to volume) keeps 64 / 16 MB, because Transfer's own upload queue is `RX_UP_MAX` 64.

**Words:** `refusalWords('queue_full')` (`words.ts:55`) and the tests and e2e that quote it say the new numbers; build
the sentence from the constants so it cannot drift. The Queue meter in `net-driver.ts:95` follows by itself.

**Nothing changes on the board or the Amiga.** `formatQueue` already trims its LIST to the board's 6,144-byte buffer
and always sends NEXT; Transfer keeps the next 32 waiting (`RX_LIST_MAX`) and drops rows that leave the list. The
operator accepts the Transfer window rolling over at 32.

**Corrected in the final review:** the server now lists 32 rows (`.limit(32)`), and Transfer never lists a row for a
volume, because `rx_path_ok` rejects `:` (`tools/receive/core/rx_proto.c:1126-1134`). So a copy onto a volume shows no
waiting rows in Transfer: one receiving row, and done rows piling up to `ROWS_MAX` 96, after which the oldest falls off.
The rollover at 32 applies only to plain sends to the receive folder. Nothing depends on the list: the next file comes
from NEXT.

**The one risk, to measure before anything else in this part:** the server stores every file of a copy (`storeSendBytes`,
then `diskStore.stat` and a CRC per file in `queueTransfers`) inside one request with `maxDuration` 60 s. A 214-file
disk, and four large disks together, must be timed against the real Blob store. Target: under 30 s for the four largest
disks. If it misses:
- first remove the redundant store calls (a `stat` for bytes the server has just stored);
- if that is not enough, the browser sends one request per selected disk, so a selection becomes one job per disk and
  the panel shows several cards. Each request then checks the limits for itself, so a disk that no longer fits is refused
  by name while those already queued stay. Say so to the operator;
- if one 214-file disk alone misses the target, stop and tell the operator: splitting by disk cannot help.

**Check, known limits on the web side:** `listTransfers` caps at 100 rows (`transfers.ts:348`) and is what the Queue
folder shows, newest first. With 1,000 waiting, the Queue listing must still be honest: show the count in its meta and
do not imply the 100 are all of them. Builder's call how, as long as a row is not silently lost from a Cancel or a
count: those must read the table, not the capped list.

## Part 2: disks as folders

**Where it works:** the destination is a directory on a NET: volume (`isNetVolumeDir`), reached by Copy, by the bank's
copy-to, or by drag. Everywhere else a disk or title row as a copy source stays refused, as now: STASH:, another disk,
the board's Queue, LIBRARY: shelves keep their existing behaviour (filing a title between collections is unchanged).
Send .adf on the disk pages is unchanged.

**What arrives:**
- A DSK row becomes one drawer named exactly as the row is (`diskName`: the disk's label, else `Disk n`), holding every
  file and drawer on that disk at the same relative paths, with protection bits and comments as Copy keeps them today.
- `Disk.info` is copied like any other file. The operator asked for all files. Workbench may show it as an icon in the
  folder under Show All Files; check on the bench and report it, do not special-case it.
- A TTL row is its disks: each becomes a drawer directly in the destination, as if every DSK row had been selected.
- A drawer with no files on the disk arrives through the existing `ensure` Makedirs; a disk with no files at all still
  makes its drawer. These never ask for an icon.
- A collection row stays refused as a copy source.

**Selection:** DSK rows share a listing only with each other, and TTL rows with TTL and collection rows. A selection
holding a collection stays refused whole, as `filingReason` does today (`COLLECTIONS_STAY`), so Select all at the
LIBRARY: root cannot copy titles when any collection exists. My call: leave that.

**How much at once (my call):** one Copy takes at most `COPY_MAX_DISKS` disks, refused whole before any image is read,
in words that name the number. The server has no per-disk file count, so it must decode every image to know the total,
and an unbounded Select all would time out rather than refuse. Set from part 1's timing: **8** (the four largest disks stored in 25 s from the
operator's Mac; plan 2026-11-02). No stored file counts, no migration, no browser-driven batching for this.

**Move:** refused for DSK and TTL rows onto a volume, offered nowhere in the UI, and the server refuses it with words.

**Clashes:** a drawer of that name already in the destination gets the usual Replace / Keep both / Skip, per disk.
Replace merges (operator's ruling): files of the same name are overwritten and every other file in the drawer stays, as
Replace on a copied drawer does today. Nothing is deleted first, and mixing two disks in one drawer is the person's
choice. The help text says what Replace does here. Two
disks in one selection with one name (two titles' `Disk 1`) are a clash between themselves: Keep both's naming applies,
or the existing "two sources share a name" refusal if Keep both is not what the flow reaches. Builder's call which,
as long as no file silently overwrites another. Different answers for different disks go as separate requests, as
`clashGroups` does today, so they may show as separate cards. My call: accepted.

**Disks that cannot go, each refused by name while the others still copy:**
- not readable as files: `readVolume` fails (non-DOS, some protected disks, HFE). There is no server-side protection
  detector and none is to be built. A protected disk with a valid filesystem (Gods' Copylock) copies its files like any
  other, and its protection does not come along, as with any file copy;
- a name the Amiga cannot take (`checkName`, 30 characters, no `:` or `/`);
- a file on it over 4 MB, or that cannot be read whole.

Today `crossDevice` refuses the whole operation when one source fails to collect, so this needs per-item results.
A selection over the queue's limits is refused whole, before anything is stored, with the queue-full words.

**Progress:** one job for the operation, in the panel as usual; Cancel the rest works as for any other copy. The card
names the destination.

**Pointers:** `collect` (`library-driver.ts:435`) reaches `locateEntry`, which refuses an empty `names`. Rows are in
`library.ts:160`. Copy and drag gating is in `files-manager.tsx`, `manager-rules.ts`, `shelf-rules.ts`. The source's
top-level name comes from `items[0].rel[0]` in `net-write.ts`. Help text in `src/lib/help/topics.tsx` must change with
the behaviour.

## Part 2b: the up row

**Look (operator's choice from the mock-up):** the first row of the listing's body, name column: the small chip holding
`↑`, then the text `Up one level`, in the muted text colour, not bold. No checkbox, no date, no size.

**Where:** whenever the pane has a parent (`crumbs.length > 1`), on every device: STASH:, LIBRARY: at every level, NET:,
volumes, inside archives. Not at a device root. It shows in an empty folder and with a filter on.

**Behaviour:**
- One click or tap goes up. A double-click goes up one level only (a row opens on double-click elsewhere, so the habit
  will happen here; the second click must not take a second level).
- Not selectable. Select all, counts, shift-range, the arrow keys' row cursor indexes, drag and the Copy source all
  ignore it: selection is by index into `rows`, so it must stay outside that array.
- It is a real control: reachable by Tab and named to a screen reader, finger-sized below `lg`.

**Removed (operator):** the `↑` button in the title bar (`pane.tsx:166`, test id `pane-*-up`). The title bar's comment
says it was the keyboard's and screen reader's way up, so the row now carries that. The left-edge click stays. The
bank's Parent and Root stay: they remain the way up when there is no listing to hold the row (a refused or pending NET:
place). Verify the phone layout still has a way up in that state.

Update `pane.test.ts` and `e2e/files-net-writes.spec.ts:91`.

## Part 3: the panel minors

| Minor | Fix |
|---|---|
| A cancelled move's count includes files whose originals were not removed | `resultWords` says `copied`, not `moved`, for a cancelled move: "Cancelled: 2 of 8 copied; the rest is still in X". |
| Cancel on a plain Queue send takes all of that board's waiting files | Keep the behaviour, since those rows have no job and share one card. The confirmation says so: "Cancels all 12 files waiting for A500". |
| An idle page misses jobs started elsewhere until reload | Ask every 60 s while the page is visible and nothing runs, and at once when the tab becomes visible again. A hidden tab asks nothing. |
| On phones the panel sits above the search overlay | The panel goes under the overlay below `lg` (both are z-30 today). |
| The same result text twice is announced once | The live region announces each result, including an identical one. Builder's call how. |

## Constraints

- Next.js here differs from training data: read `node_modules/next/dist/docs/` before writing route or page code.
- Self-hosting has full parity: nothing here may depend on our deployment. The limits are constants, not env.
- No migration is expected. If one proves necessary, apply it to production before the push.
- e2e: only the specs for touched areas, port 3100, serialised, in runs under 9 minutes. Worktree setup per memory.
- The whole-branch review has caught Criticals every time, and fixes have been worse than findings: review the fixes.

## Done means

- Unit, DB and the touched e2e pass.
- Timing measured and reported for part 1.
- A500 bench, in this order, on production: make `Monkey` with Makedir, go in, Copy Monkey Island Disk 1 (over 32
  files): the drawer `Disk 1` arrives whole, compared with the ADF's file list; Transfer's window shows the receiving row and done rows, with no waiting list; Cancel the
  rest on a second disk leaves exactly what was reported; the four disks from the TTL row arrive as four drawers;
  `Disk.info`'s look on Workbench reported.
- `HANDOFF.md` §4 and its Current order updated; Pillock told, as the operator instructs.

## Left to the builder

Task breakdown, how the title expands to disks, the way a double-click is held to one level, the live region trick, the
Queue listing's wording past 100 rows.
