# NET: volumes, phase 2: write to the Amiga's own disks from Files

Status: approved in conversation 2026-10-31 (operator, sections 1-4), written for review. Builds on phase 1
(`2026-10-30-net-volumes-design.md`, protocol 3, firmware 1.22.0, Transfer 2.3/2.4) and Send to Amiga
(`2026-10-16-paulanet-phase4-send-to-amiga-design.md` §2, the `FILE` command). Anything not changed here stays as those
say.

## 1. Decisions (operator, 2026-10-31)

- W1 **Scope:** the full set -- Copy onto a volume (drawers included), Move, Makedir, Rename, Delete, Protect, comments.
- W2 **Opt-in:** a second switch in Transfer, "Let the web app change my disks", default off, usable only while
  browsing is on. Phase 1's read-only switch is unchanged; writing is a deliberate second step.
- W3 **Delete:** always confirmed in the web app for a NET: volume ("Delete from the Amiga? This cannot be undone."),
  whatever "ask before deleting" says. Drawers are deleted with their contents. Nothing is forced: a file whose
  protection refuses deletion is reported, not unprotected.
- W4 **Where:** no limits -- every mounted volume, the boot volume included. AmigaDOS's own refusals (write-protected
  disk, protection bits, disk full, object in use) come back as clear errors.
- W5 **Foundation:** a copy onto a volume travels as Send to Amiga does (a `transfers` row, the board relays `FILE`,
  resume/CRC/progress as today), with an absolute destination and a clash mode. Everything else is a one-line request
  through phase 1's request queue.
- W6 **Name clashes:** the Files setting that exists (ask / replace / skip / keep both) applies to NET: as to the other
  devices.

## 2. Transfer 2.5 (protocol 4)

### 2.1 Handshake

- A board with firmware 1.23+ says hello as protocol 4 (`WEBADF 4 <key>`). Transfer 2.5 answers
  `READY 4 <b> <w>`: `<b>` browsing on (`1`/`0`), `<w>` writing on (`1`/`0`); `<w>` is `1` only when `<b>` is `1`.
- Transfer 2.5 answers a protocol 1, 2 or 3 hello exactly as 2.4 does. Transfer 2.4 and older answer a protocol 4
  hello `READY 3 <b>` (or older); the board then treats the connection as that protocol (no writes).

### 2.2 Copy onto a volume: `FILE`, extended

On a protocol 4 connection, `FILE` may carry an absolute destination and a clash mode:

```
FILE <id> <size> <crc32 hex> <protection hex> <len>:<Vol:drawer/name> <len>:<comment> <keep|replace|skip>
```

- **Absolute path:** one volume or device name (1-30 characters, no `/` or `:`), a colon, then parts as in phase 4
  (each 1-30 characters, no `:`, not `.` or `..`; an empty path after the colon is refused for `FILE`, which names a
  file). A relative path (no colon) with no mode is today's `FILE`: it lands inside ReceiveDir, unchanged.
- **Modes:** `keep` -- an existing name gets the collision-free name as today (`name.1`); `replace` -- the old file is
  deleted only after the CRC of the new one matched, then the temporary file is renamed over it; if the old file
  cannot be deleted (protection, in use) the new one is removed and the answer is `ERR <id> denied|busy`, the old file
  stays; `skip` -- if the name exists when `FILE` arrives Transfer answers `SKIP <id>` and no bytes follow (the board
  sends none).
- Missing drawers on the way are created (as today). Writing goes through `.webadf-rx` in the target drawer, then
  rename, protection, comment -- as today.
- **Writing off:** an absolute `FILE` while `<w>` is `0` is answered `ERR <id> readonly <len>:<text>`.
- **New error codes for `FILE`:** `readonly`, `wprot` (the disk is write-protected), `denied`, `full` (as `space`
  today; `space` stays for relative paths).

### 2.3 Request commands (board to Transfer)

Through phase 1's request flow (`<rid>`, one at a time, length-prefixed Latin-1 paths), answered `DONE <rid> <n>` or
`ERR <rid> <code> <len>:<text>`:

| Command | AmigaDOS | `<n>` in `DONE` |
|---|---|---|
| `MKDIR <rid> <len>:<path>` | `CreateDir` (one level; the parent must exist) | 1 |
| `RENAME <rid> <len>:<from> <len>:<to>` | `Rename` (same volume; also Move within a volume) | 1 |
| `DELETE <rid> <len>:<path>` | `DeleteFile`; a drawer is emptied depth-first first | entries removed |
| `PROTECT <rid> <len>:<path> <hex>` | `SetProtection` | 1 |
| `NOTE <rid> <len>:<path> <len>:<comment>` | `SetComment` (0-79 characters) | 1 |

- **Deleting a drawer:** Transfer walks it depth-first with one lock per level (memory stays flat with depth), sends
  `DEL <rid> <n>` after every 50 entries removed, and stops at the first refusal: `ERR <rid> <code> <len>:<text>`
  where the text names the entry (`Libs/foo.library: object in use`), preceded by a `DEL <rid> <n>` with the count
  removed so far. `DELETE` removes exactly the path it names; the icon rule is the server's (§4.1).
- **Codes:** phase 1's (`notfound`, `notdir`, `busy`, `denied`, `bad`, `io`) plus `readonly` (writing off), `exists`
  (MKDIR/RENAME target exists), `wprot`, `full`, `xvol` (RENAME across volumes). The text is `Fault()`'s, or short
  English for `readonly`/`bad`/`xvol`.
- **Requesters:** every write runs with `pr_WindowPtr = -1` (as phase 1's reads), so a write-protected or missing disk
  gives an error, never a requester on the Amiga.
- **Status line:** "Web: copied to Work:Tools/x", "Web: deleted Work:old (37)", "Web: made Work:New", "Web: renamed
  Work:a to Work:b", "Web: protected Work:x", "Web: comment on Work:x"; the Shell form prints one line each.

### 2.4 The switch

- `ENVARC:webadf/Write` (`1`/`0`, copied to `ENV:`), a second checkbox in the window under the browse one ("Let the web
  app change my disks"), disabled while browsing is off; a `WRITE/S` Shell switch (this run; with `SAVE` also stored).
  Default off. Unticking browsing also unticks writing.
- A change of either switch drops the connection so the board hears the new `READY` (as phase 1's switch does).

### 2.5 Deferred minors fixed here (from Transfer 2.4)

- A failed malloc while queuing a drawer to send says so ("not enough memory: N files not queued").
- The hand-off's message names the actual cause (full / no memory / name not allowed).
- `rx_upq_init` frees what a non-empty queue holds.

### 2.6 Testing

- Host tests (`pnpm receive:test`): parsing each new command and the extended `FILE`; each refusal code; absolute-path
  checks (a volume required; `.`, `..`, empty parts, over-long parts refused); `replace` leaving the old file on a
  failed delete; `skip`; recursive delete pacing (`DEL` every 50, the partial count before an `ERR`); the write switch
  (off -> `readonly`, browse off -> write off); out of memory mid-delete.
- Fake-board scenarios (`scenarios.ts`) for each command, `FILE` with each mode, a write while off.
- FS-UAE on 2.04, 3.1 and 3.2: a write-protected ADF (`wprot`, no requester), a full disk (`full`), a file with the
  d-bit off, replacing an open file, deleting a drawer of 300 files, a rename across drawers and one across volumes
  (`xvol`).
- The build pin (`receive.sha256`) is renewed; the driver disk carries Transfer 2.5.

## 3. Firmware 1.23.0

- **Hello:** `WEBADF 4 <key>`; `READY 4 <b> <w>` is parsed; `READY 3`/`READY 2` keep today's behaviour.
- **Poll:** the write flag rides beside `rxv` and `browse` (`&rxv=4&browse=1&write=1`).
- **Requests:** `/api/device/req` may return `MKDIR`, `RENAME`, `DELETE`, `PROTECT`, `NOTE` lines; the board checks
  them as it checks phase 1's (rid, length-prefixed paths) and relays them in phase 1's order: listings and these
  one-line writes before any `GET`. Answers are posted as phase 1's pieces; `DEL <rid> <n>` lines are gathered like
  `ENT` lines (a piece closes at 32 KB or 400 lines, or after 10 s, as AS_PIECE_MS).
- **Silence clock:** a `DEL` line restarts the 30 s clock, as an `ENT` line does.
- **Transfers:** the poll's `xfer.next` gains `dest` (the absolute path) and `onClash` (`keep|replace|skip`) for a row
  that has them; the board sends the extended `FILE` only on a protocol 4 connection with `<w>` `1`, and otherwise fails
  the row `readonly` without sending. `SKIP <id>` is reported to the server as the row's outcome `skipped`.
- **Deferred minor folded in:** a host test of `amiga_tcp.c`'s ack accounting (acked when read, the 48 KB ring).
- A board on 1.22 never receives these requests or rows: the server offers them only to a board that reported
  `write=1`.

## 4. Server and web

### 4.1 Files' NET driver

`netDriver` gains, for paths on a volume, the optional methods Files already calls on other devices: `write`,
`remove`, `makedir`, `rename`, `setMeta`, `within`. The grid's buttons (Copy, Move, Makedir, Rename, Protect, Delete,
the comment in Info) work on NET: volumes with no new layout. Queue keeps its own behaviour.

- **Copy onto a volume:** the server first reads the destination drawer fresh (a `DIR` request; Pending while it
  comes) so the clash dialog works as on other devices; then it queues one `transfers` row per file, in the order the
  copy walked them, with new columns `amiga_dest` (the absolute path) and `on_clash` (`keep|replace|skip`; "ask" has
  been answered by then). Limits per copy and per file as phase 1's reads: 64 files, 16 MB, 4 MB a file. The destination
  pane shows the files as arriving rows with the board's progress (as STASH: shows uploads); a finished copy drops the
  destination drawer's 2-minute memory.
- **Makedir, Rename, Delete, Protect, comment:** one `remote_requests` row each, with the new kinds `mkdir`, `rename`,
  `delete`, `protect`, `note`. The pane shows "Deleting Work:old on A500…" (and "removed N so far" from `DEL` pieces)
  until `DONE`/`ERR`; Delete and Rename take the object's icon along as Workbench does (a `<name>.info` beside it is
  deleted or renamed too, as its own request, when it exists and was not itself selected); the affected drawer's memory (and the parent's, for Rename and Makedir) is dropped. A delete
  counts as alive while `DEL` pieces arrive (the phase 1 expiry otherwise applies).
- **Move:** within one volume = `RENAME` (a move between two drawers of one volume included). From a volume to STASH:
  or LIBRARY: = copy (GET), then `DELETE` of each source once its copy is stored (`mustRemove` first checks the write
  switch). Onto a volume from STASH:/LIBRARY: = the copy's rows, and each source is removed only after its row ended
  `done` (the existing two-step move). Between two volumes = copy (GET then `FILE`) then `DELETE`.
- **Delete confirmation:** always shown for NET: volume paths, with the names and how many drawers; the words above
  (W3).
- **Results:** each refusal code has words in `words.ts` ("The disk is write-protected", "The disk is full", "Protected
  against deletion", "In use on the Amiga", "Writing is off in Transfer", "Already exists", "Rename works within one
  volume"). A partly done delete says "Removed 37, then stopped at Libs/foo.library: in use".

### 4.2 When writing is off

The pane's reason line (phase 1's `net-browse-reason`) names the missing thing, and the write buttons are greyed with
the same words as their tooltip: "Writing is off in Transfer", "Transfer 2.5 or newer writes to the Amiga", "Board
firmware 1.23.0 or newer writes to the Amiga". Reading works as in phase 1.

### 4.3 Status

`devices` gains `write_on` (from the poll's `write=`), cleared as `browse_on` is when Transfer goes away. Self-hosting:
nothing here depends on our deployment.

### 4.4 Deferred minors folded in (from phase 1)

- `alive` for a piece-arriving request is bounded by recency (a piece within the last 30 s), not only by the expiry.
- An Amiga-side upload blocking Transfer counts in the copy exemption as a copy does.
- A NET: pane opened straight onto a pending or failed listing shows its crumbs.

### 4.5 Testing

- Unit/db tests of the driver methods: each operation, each clash answer, the limits, Move in each direction, a
  delete's partial result, the reason line for each off state, `write_on` from the poll.
- e2e against the fake board (`amiga-board.ts` answers the new kinds and the extended `FILE`): copy STASH: -> a volume
  with a clash (ask -> replace / skip / keep both), Makedir, Rename, Protect, a comment, Delete with its confirmation, a
  drawer delete with progress and a partial stop, Move volume -> STASH: and STASH: -> volume, writing off greys the
  buttons, an old Transfer and old firmware.

## 5. Bench (A500, operator or via the PiKVM)

1. Tick writing in Transfer; NET: shows the volume writable.
2. Copy a STASH: drawer into Work:; Transfer's status line; the files' CRC on the Amiga matches.
3. Makedir, Rename (across drawers), Protect, a comment: each seen with `list` on the Amiga.
4. Delete a drawer of about 200 files; the progress shows.
5. Copy to a write-protected floppy: the error in the pane, no requester on the Amiga.
6. Replace a library that is in use: the old one stays, the pane says why.
7. Untick writing mid-session: the buttons grey within about 30 s, and queued writes fail `readonly`.

## 6. Delivery (each step merges on its own)

1. Server and web against the fake board (inert until a board reports `write=1`), migration for `transfers.amiga_dest`,
   `transfers.on_clash`, `devices.write_on`.
2. Transfer 2.5 (protocol 4, FS-UAE), pinned build.
3. Firmware 1.23.0 TEST build.
4. A500 bench (§5).
5. Firmware release, driver disk with Transfer 2.5, HANDOFF.

## 7. Out of scope

- A local copy between two volumes on one Amiga (it goes up and down; a `COPY` command can come later).
- Setting a file's date; assigns; devices without a volume; formatting a disk.
- Undo or a Trashcan.
