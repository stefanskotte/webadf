# NET: volumes: browse the Amiga's own disks from Files (phase 1, read-only)

Status: approved in conversation 2026-10-30 (operator, sections 1-4), written for review. Builds on Files
(`2026-10-29-files-manager-design.md`) and Files 2 (`2026-10-29-files-2-design.md`); the protocol it extends is
PaulaNET Phase 4 (`2026-10-16-paulanet-phase4-send-to-amiga-design.md` §2) and protocol 2
(`2026-10-18-amiga-to-web-upload-design.md` §3, §5). Anything not changed here stays as those say.

## 1. Decisions (operator, 2026-10-30)

- V1 **Board folder:** `NET:<board>` lists the Amiga's volumes as folders plus one folder **Queue** (today's send
  queue). Browsing off or the Amiga offline: Queue only, plus one line saying why the volumes are missing.
- V2 **What a volume is:** mounted volumes only, by name (Workbench, Work, RAM Disk, an inserted floppy's name). No
  assigns, no empty drives. Two volumes with one name: the second is shown as `Name (DF1:)`.
- V3 **The wait:** "Reading … from A500…" while a listing comes; listings are remembered on the server for 2 minutes
  (age shown); Reload/Refresh always reads fresh; a copy always reads the file fresh.
- V4 **Opt-in:** one switch in Transfer, all volumes, read-only, default off; only the trusted board's requests are
  answered; Transfer's status line shows what the web app read.
- V5 **Phase 1 = read-only:** Copy from a volume to STASH: or LIBRARY: (drawers included, 64 files / 16 MB per copy,
  4 MB per file), Download, Info. Everything that writes to the Amiga waits for phase 2.
- V6 **Transport:** a request queue on the board, woken by the existing long poll (no new socket, no Amiga-to-internet
  route).
- V7 **Refresh** button in the grid's empty cell (row 3, before Delete), any device; on NET: it bypasses the 2-minute
  memory.

## 2. Transfer 2.3 (protocol 3)

### 2.1 Handshake

- A board with firmware 1.22+ says hello as protocol 3 (`WEBADF 3 <key>`). Transfer 2.3 answers `READY 3 <b>` where
  `<b>` is `1` (browsing on) or `0` (off). Transfer 2.2 and older answer `READY 2`; protocol 2 continues unchanged.
- Transfer 2.3 answers a protocol 1 or 2 hello exactly as 2.2 does.

### 2.2 Commands (board to Transfer)

`<rid>` is the server's request id (1-40 characters of `[A-Za-z0-9_-]`). Paths and names are length-prefixed
(`<len>:<text>`, Latin-1), as in `FILE` and `PUT`.

| Command | Answer |
|---|---|
| `VOLS <rid>` | one `VOL <rid> <len>:<name> <len>:<device> <size> <free> <days>.<mins>.<ticks>` per volume, then `DONE <rid> <count>` |
| `DIR <rid> <len>:<path>` | one `ENT <rid> <d\|f> <size> <prot hex> <days>.<mins>.<ticks> <len>:<name> <len>:<comment>` per entry, then `DONE <rid> <count>` (or `DONE <rid> <count> cut` at 1000 entries) |
| `GET <rid> <len>:<path>` | `GOT <rid> <tag>`, then the file goes up by protocol 2 (`PUT <tag> …`, `TAKE`/`MORE`, `END`) |
| any of them, refused | `ERR <rid> <code> <len>:<text>` |

- **Volumes:** from the DOS list (`LockDosList(LDF_VOLUMES|LDF_READ)`), only volumes with a mounted handler task; the
  device is the handler's device name (`DF0:`, `DH1:`); size and free come from `Info()`, in bytes (0 when unknown).
  Every volume is sent by its plain name, duplicates included (final review ruling, 2026-10-30): the server labels a
  second volume with the same name (case-insensitive), and a volume named `Queue`, as `Name (DF1:)`; Transfer never
  sends nor needs to resolve that form.
- **Paths:** `<Volume>:<drawer>/<file>` as AmigaDOS takes them; empty after the colon = the volume's root. A path
  through a volume the server labelled arrives as the device's path (`DF1:c`, not `Empty (DF1:):c`), which AmigaDOS
  resolves to the volume in that drive.
- **Codes:** `off` (browsing switched off), `notfound`, `notdir`, `isdir` (GET of a drawer), `busy` (object in use),
  `toolarge` (over 4 MB), `denied` (read-protected), `bad` (malformed command), `io` (any other DOS error). The text is
  AmigaDOS's own message (`Fault()`), or a short English one for `off`/`bad`/`toolarge`.
- **Long drawers:** entries are produced only as the connection drains Transfer's 1 KB output buffer: the drawer scan
  pauses while the buffer is full and resumes on the next pass, so memory stays flat. After 1000 entries the scan
  stops with `DONE <rid> 1000 cut`.
- **Order:** one request at a time; a file being received or going up finishes first. A request arriving meanwhile
  waits (Transfer keeps at most one waiting; the board never sends a second).
- **GET:** the file joins Transfer's up-queue at its front; its PUT carries the tag from `GOT`. Resume, the 4 MB limit,
  progress and failures are exactly protocol 2's. The file's `.info` is not added (GET names one file).

### 2.3 Rules

- Requests are answered only on a connection whose hello carried the trusted key, and only while browsing is on;
  otherwise `ERR <rid> off`.
- Reads use shared locks (`ACCESS_READ`) and are released before the answer ends; nothing is written anywhere by these
  commands. Receiving still writes only inside ReceiveDir.
- **The switch:** `ENVARC:webadf/Browse` (`1`/`0`, copied to `ENV:`), a checkbox in the window ("Let the web app
  browse my disks (read-only)"), and a `BROWSE/S` Shell switch (this run; with `SAVE` also stored). Default off.
- **What the owner sees:** the window's status line shows the last request: "Web: listed Work:Programs",
  "Web: listed volumes", "Web: copying Work:a.lha"; from the Shell one line per request.

### 2.4 Testing

- Host tests of the core (`pnpm receive:test`): parsing each command, each refusal code, the drain-paced drawer
  listing (a full buffer pauses and resumes without loss), the 1000 cut, two volumes with one name (both sent plain), off/on.
- Fake-board scenarios (`scenarios.ts`) for VOLS, DIR, GET, and a request waiting behind a file.
- FS-UAE runs on 2.04, 3.1 and 3.2: a drawer of over 1000 entries, two floppies with the same name, browsing off.
- The build pin (`receive.sha256`) is renewed; the driver disk carries Transfer 2.3.

## 3. Firmware 1.22.0

- **Wake:** the poll query gains `reqAck=<n>` (the request cursor last fetched). When the server's `reqVersion`
  differs, the poll answers `req:{v}` (same inequality rule as `xfer`). Firmware without `reqAck` is never sent
  requests.
- **Fetch:** `GET /api/device/req` returns up to 8 waiting requests as protocol lines (`VOLS`, `DIR`, `GET`), listings
  (`VOLS`/`DIR`) before files (`GET`), each oldest first. When requests still wait after a fetch, the server bumps
  `req_version` again in the same transaction, so the board is woken for the rest: the board must ack (`reqAck`) the `v`
  it saw in the poll BEFORE its fetch, never a later one (final review, 2026-10-30). One HTTPS request per `as_step()`
  still holds.
- **Relay:** one request at a time to Transfer, only on a protocol 3 connection. A file moving either way finishes
  first; then requests go before queued downloads (someone is waiting in a browser).
- **Answers:** reply lines are gathered in a 32 KB PSRAM buffer and posted to `POST /api/device/req/<rid>` as
  `{piece, lines, last}` when the answer ends (`DONE`/`ERR`) or the buffer fills (a big drawer arrives in pieces).
- **GET:** `GOT <rid> <tag>` ties the request to the upload that follows; that upload's open body gains
  `"request":"<rid>"`. Nothing else in protocol 2 changes.
- **After GOT (final review, 2026-10-30):** `GOT <rid> <tag>` ends a GET's answer. Afterwards, at any time no other
  request is being answered, Transfer may still send `ERR <rid> io|toolarge|off <len>:<text>` for that already-GOT GET:
  when the file cannot be read or has grown past 4 MB when its turn comes, or when browsing was switched off meanwhile.
  The board routes such a line by its rid and posts it as that request's piece; the server already accepts it. The PUT
  carrying the GOT's tag may come later than other lines.
- **The board answers itself, at once:** `ERR <rid> norx` (Transfer not connected), `ERR <rid> old` (Transfer answered
  `READY 2`), `ERR <rid> timeout` (Transfer silent 30 s in the middle of an answer).
- **Status:** `/api/device/status` gains Transfer's protocol (`2`/`3`) and the browse flag from `READY 3`.
- **Amendments (firmware plan 2026-10-31):**
  - Transfer's protocol and browse flag ride the poll (`&rxv=2|3&browse=0|1`, beside `rx`), as the server reads them; the
    Status bullet above is superseded (ruling F1).
  - A piece closes at 32 KB of JSON or 400 lines; `DC_POST_BODY_MAX` is 32,768 (F2).
  - A PUT from Transfer that crosses a request goes first: Transfer answers no request while its PUT waits for TAKE.
    The 30 s silence clock stands still while an upload is pending or moving (F3); a timeout drops the connection (F4).
  - A dropped connection ends the answer in progress `ERR <rid> norx 35:The connection to Transfer was lost`, and every
    GET answered GOT whose file has not finished fails the same way (piece 1); a GET's upload refused with `NO` fails
    the GET `toolarge` (`NO size`) or `io` (F5).
  - A drop at protocol 3 reconnects after 5 s, so Transfer's switch shows within seconds; requests fetched meanwhile
    wait for it (F8). The wait counts as the engine's work, so no 25 s long poll delays the reconnect (final review I1).
  - While the held request lines are only GETs (a copy), the board fetches once more before it relays each GET and
    merges the new lines; VOLS and DIR go before any GET, so a pane is not kept waiting behind a copy (final review I2,
    amends F9).
- **Testing:** host tests in `test/test_amiga_send.c` (relay, pieces, a request waiting behind a moving file, each
  board-made error, GOT tied to the upload open).
- **Release:** a TEST build on the bench first; released after the A500 bench (§7).

## 4. Server

### 4.1 Data (migration 0053)

- `remote_requests`: id, org_id, device_id, kind (`vols`|`dir`|`get`), amiga_path, status
  (`waiting`|`sent`|`done`|`failed`), error_code, error_text, answer (jsonb: volumes or entries), pieces received,
  cut (bool), copy target (jsonb, GET only: destination path and clash rule), upload_id (GET), created_at, sent_at,
  answered_at.
- `devices.req_version` (integer, default 0), bumped in the same transaction as a new request, and again by a board's
  fetch that leaves requests waiting (§3 Fetch).
- Rows older than 24 h are deleted when a new request is added (no new cron; self-host identical).

### 4.2 Board routes (device auth as today; a board sees only its own requests)

- `GET /api/device/req`: the board's `waiting` requests, oldest first, at most 8, marked `sent`.
- `POST /api/device/req/<rid>`: an answer piece. Pieces arrive in order; the `last` one sets `done` or `failed`.
  Lines are parsed and checked (Latin-1, lengths, numbers); a malformed answer fails the request with `bad`.
- `POST /api/device/upload` (open) accepts `request`: the upload is tied to that GET, and when it closes the file is
  placed at the GET's copy target instead of the "from the Amiga" area.

### 4.3 Paths

- `NET:/<deviceId>/Queue/<transferId>`: the send queue. Old `NET:/<deviceId>/<transferId>` paths and
  `filesHrefForBoard` links go there.
- `NET:/<deviceId>/<Volume>/<drawer>/…`: a volume. The driver turns it into `Volume:drawer/…`; each segment must pass
  `amigaNameProblem` (the volume segment may carry the ` (DF1:)` suffix: the name before it must pass, the device must
  match `[A-Za-z0-9_.-]{1,30}:`). Through a suffixed volume the path sent to Transfer, and the one requests are stored
  and remembered under, is the device's (`DF1:drawer/…`); the pane still shows the label.
- A volume really named `Queue` is shown as `Queue (DH2:)` (its device).

### 4.4 Listing

1. The NET: driver looks for a `done` answer for the same board, kind and path (case-insensitive) younger than 2 minutes;
   if found it lists it, with its age.
2. Otherwise it reuses a `waiting`/`sent` request for that path, or adds one, and answers 202 `pending` (plan ruling P1:
   the list route itself, no request id).
3. The pane asks the same list URL every 500 ms; after 20 s it stops with "A500 didn't answer".
4. Refresh (`fresh`) skips step 1, and replaces a pending request older than 20 s (failed `timeout`) instead of sharing
   it.
- The board must be online, on firmware 1.22+ and reported protocol 3 with browsing on; otherwise the driver answers
  the reason at once without adding a request.

### 4.5 Copy from a volume

- A normal Files operation: drawers are listed first (fresh), the total checked against 64 files / 16 MB and each file
  against 4 MB; then one GET per file, each with its copy target (STASH: folder with the clash rule, or LIBRARY:/a
  collection through the existing Add to library; LIBRARY: refuses non-disk files with the existing reason).
- Each file is placed as its upload closes; the status row follows ("Copying 3 of 12 from A500…").
- A GET not answered within 10 minutes fails "A500 stopped answering"; one failed file does not stop the others; the
  summary reads "Copied 11, 1 failed: <name>: <reason>".
- Download of a volume file = a one-file copy into the STASH: root (the clash rule applies), then the browser download
  of that STASH: file. The copy stays in STASH:, visible, like any other (no hidden area).

### 4.6 Errors shown

| Cause | Pane says |
|---|---|
| browsing off (`off`, or status flag) | Switch on browsing in Transfer on A500 |
| Transfer 2.2 or older (`old`) | Transfer 2.3 or newer is needed on A500 |
| firmware below 1.22 | Firmware 1.22 or newer is needed |
| Transfer not running (`norx`) / board offline | the board card's reason |
| `notfound` | Object not found |
| `timeout`, 20 s with no answer | A500 didn't answer — Refresh to try again |
| others | Transfer's text |

### 4.7 Testing

- Unit: NET: path parsing, the `Queue` and duplicate-name forms, path to Amiga path, answer-line parsing.
- DB: org/board scoping, the 2-minute window and age, reuse of a waiting request, the 24 h cleanup, an upload with
  `request` placed at its target (STASH: and LIBRARY:), a foreign board's answer refused.
- e2e (desktop + mobile): a fake board answering through the device routes: list volumes, open a drawer, Refresh, copy
  to STASH: and LIBRARY:, each error state, Queue still working.

## 5. Files UI

- **NET: root:** each board row says "browsable" or the one missing thing ("browsing off in Transfer", "needs Transfer
  2.3", "needs firmware 1.22", offline).
- **Inside a board:** volumes first, as folders (size column "DH1: · 41 MB free", date = the volume's creation date),
  then **Queue**. When volumes cannot be read: one reason row in their place; Queue still works.
- **Inside a volume:** the usual columns (name, size, protection, date, comment); `.info` follows the Show .info
  switch; the title bar reads `A500 · Work:Programs` plus "read 40 s ago" for a remembered listing; the meta shows the
  volume's free space. A cut listing ends with a row "Only the first 1000 entries are shown".
- **Loading:** the pane keeps its old rows dimmed under "Reading Work:Programs from A500…"; the other pane and
  navigation stay usable (navigating drops the wait).
- **Buttons:** Refresh in the empty cell (row 3, column 5) and Ctrl-R; on the phone sheet too. On a volume: Copy,
  Download, Info, All/None, Parent/Root, Swap, Show .info, Filter… and Refresh work; Move, Delete, Rename, Makedir,
  Protect, Create ADF… and Add to library are disabled with "Read-only for now" (Add to library = Copy to LIBRARY:).
  Drag out of a volume copies; a drop onto a volume is refused.
- **Help:** the `files` topic gains "Browsing the Amiga": what it needs (firmware 1.22, Transfer 2.3 with browsing on),
  the speed, the 2-minute memory, Refresh, read-only. Transfer's README covers the switch and the commands.

## 6. Order of work

1. Server + web against the fake board (inert until a board sends `reqAck`), merged and live.
2. Transfer 2.3 (FS-UAE), pinned build.
3. Firmware 1.22.0 TEST build.
4. A500 bench (§7).
5. Firmware release, driver disk with Transfer 2.3, README screenshots of a NET: volume, HANDOFF.

Each step merges on its own.

## 7. Bench (A500, operator)

1. Switch browsing on in Transfer; NET: shows the board "browsable"; the volumes list.
2. Open Work: and a drawer two levels down; Parent is instant (remembered).
3. Copy a file to STASH:; copy an ADF to LIBRARY:; copy a drawer of a few files.
4. A drawer of over 1000 entries: the cut row shows.
5. Browsing off: the reason row; Queue still sends a file.
6. Quit Transfer during a listing: the pane says why within 30 s.
7. Take a floppy out mid-listing and mid-copy: no requester on the Amiga, an ERR in the pane.
8. One run with only 512 KB of memory.

## 8. Out of scope (phase 2 and later)

- Writing to the Amiga: copy to a volume, Makedir, Delete, Rename, Protect, comments.
- Assigns; devices without a volume; background prefetch of child drawers.
