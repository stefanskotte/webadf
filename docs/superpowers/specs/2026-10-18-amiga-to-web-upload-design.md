# Upload from the Amiga to the web app (design draft, 2026-10-18)

**Status:** draft for the operator's review. U6 is an operator decision (2026-10-18). The other decisions in §1 are
recommendations, and the open questions in §12 are the operator's to rule on before a plan is written.

**Goal:** a file on the Amiga goes into the web app, through the board, over PaulaNET. It is the reverse of Phase 4
(HANDOFF backlog "Upload from the Amiga to the web app", operator 2026-10-16).

**Background:**
- Phase 4 spec `2026-10-16-paulanet-phase4-send-to-amiga-design.md`: Receive, the protocol on TCP 6800, the
  `transfers` queue, and the "Send to Amiga" card on the Upload page.
- HANDOFF 3bt-3bv: Receive, fw 1.14-1.16 (the send engine `amiga_send.c` / `amiga_tcp.c`), the web side, and the A500
  bench. An 880 KB ADF goes down in about 130 s on RLE.
- LZ4 spec `2026-10-18-paulanet-lz4-design.md` and HANDOFF 3bw: our driver variant, which sends LZ4 uploads on a
  68020 or faster.
- Constraints measured today:
  - `PNET_LOCAL_A2B_MAX` caps a frame from the Amiga to the board at 768 bytes (5840d4c; 3bm's 256 was raised for
    Receive's OK lines). A frame from the Amiga carrying bulk TCP data is about 1,514 bytes, and the cap drops it.
  - The SRAM `.bss` budget is fully spent (431,584 B, 3bw). The heap low-water sits at its 20,480 B floor (3bv). The
    lwIP heap (`MEM_SIZE`) is 16 KB. `TCP_WND` is 32 × MSS (46,720 B).
  - The board has one HTTPS connection, shared by the long poll, write-back and the send engine. The send engine makes
    one HTTPS request per `as_step()`.

## 1. User story, success criteria, decisions

**User story:** "I have a file on my Amiga: a program I wrote, a saved game, an ADF I downloaded, or an LHA archive.
I drop it on the Receive window, or I type `Receive SEND DH0:foo.lha`. A moment later it appears in the web app's
*From the Amiga* area, which holds what all my boards uploaded, marked with the board it came from. From there I can
download it to my computer, add it to the library if it is a disk image, send it on to another Amiga, or delete it.
When I am done, I clear the lot."

**Success criteria:**
- On the A500 (68000, RLE uploads), an LHA, a text file and an 880 KB ADF arrive whole. The server checks the CRC
  and the sha256, and the bytes match the Amiga's copy.
- The ADF can be added to the library with one click. It then behaves exactly like one uploaded from a browser
  (dedupe, TOSEC sweep, history).
- If the Amiga is reset mid-file and the same file is sent again, the upload resumes from the last stored chunk.
- No regression in sending to the Amiga, in DF0/DF1 or in the long poll. The heap low-water stays at or above
  today's 20,480 B, and SRAM `.bss` does not grow.
- The upload rate is measured and recorded: bytes per second up, 68000 against 68020+ (LZ4).

| | Decision (recommended) |
|---|---|
| U1 | **Receive gains the upload. No separate program.** The board already holds a connection to Receive on TCP 6800 (Phase 4 D1). Uploads ride that same connection, so the Amiga needs no board address and the board needs no listener. |
| U2 | **Three ways to start an upload, all in the one binary:** drop icons on the Receive window (an AppWindow); **Send…** in the window (an asl requester); and the Shell, `Receive SEND <files>`. An AppIcon on the Workbench desktop is left out of v1 (Q2). |
| U3 | **The board relays, and stages nothing in flash.** Amiga → board: credited TCP stream into two 16 KB PSRAM buffers. Board → server: 16 KB HTTPS POSTs, one per `as_step()`. Server: chunks staged in Postgres, as write-back stages tracks. |
| U4 | **Resumable per file.** The server keeps a partial upload for 24 h. A file sent again, with the same board, path, size and date, continues at the stored offset. |
| U5 | **Limits:** 4 MB per file (= `SEND_FILE_MAX`). One upload in flight per board. The destination area holds at most 500 files or 256 MB per org. Files are kept 30 days (Q4). |
| U6 | **Operator decision (2026-10-18): one destination area for the whole org.** "A 'destination area' on the web app side, where all uploads from wififloppies go -- there should be an option to delete individual files or clear all." One list, *From the Amiga*, collects the uploads from **all** of the org's boards, newest first. Each row shows the board it came from (the board's name, kept even after the board is unpaired). The operator's actions are **Download**, **Delete** (one file) and **Clear all** (with a confirm that gives the count). Recommended additions: **Add to library** (ADF/ADZ/DMS/DMZ/HFE only, never automatic), **Send to an Amiga**, and a filter by board when the org has more than one. |
| U7 | **Receive uploads only to its own board (trust on first use).** The board sends a per-board key in its hello. Receive saves the first key it sees and refuses to upload to a peer with a different one (§6). |
| U8 | **Gates:** firmware **1.17.0** (`UPLOAD_FW`) and Receive protocol **2**. Each side falls back to Phase 4's protocol 1 (download only) when the other is older. |
| U9 | **The local path cap rises to a full frame** (1,514 = `PNET_RING_MTU`). The frame's pbuf is freed in the receive callback before the next frame is input, so lwIP heap use stays at about one frame. This is measured first (§10, step 0). |
| U10 | **LZ4 is transparent.** It runs below TCP, in the driver and the board. Receive and the protocol do not change for it. |

## 2. The Amiga side (Receive 2)

- **One binary, as Phase 4 D6.** The name stays `Receive`, so Install, `C:` and help do not move (Q1). The window
  title becomes "webadf Receive & Send".
- **Window** (gadtools, font-sensitive, fits 640×200):
  - It is registered as an **AppWindow** (workbench.library V36+, inside the 2.04 floor). Icons dropped on it are
    queued for upload. A dropped drawer is walked: each file becomes one item, with its path relative to the drawer
    (`Drawer/sub/file`), up to 64 files per drop. `.info` files are skipped unless the icon itself was dropped.
  - A **Send…** button opens an asl file requester. It takes several files on V38+ (`ASLFR_DoMultiSelect`) and one on
    V37.
  - The **listview shows both directions**: `to web: 34 %`, `to web: done`, `to web: failed: <reason>`, beside
    Phase 4's `receiving NN %`. Long names are cut in the list, as today; the file is never cut.
  - The **status line** adds "Board connected (key AB12)", "Waiting for the board" and "This board's firmware cannot
    receive files (update to 1.17.0)".
- **Workbench start with arguments:** shift-click file icons, then double-click Receive. The project arguments
  (`WBStartup->sm_ArgList`) open the window with those files queued.
- **Shell:** the template becomes `TO/K,SAVE/S,GUI/S,SEND/M,TRUST/S`.
  - `Receive SEND DH0:a.lha DH0:b.txt`:
    - If a Receive is already running (public port `webadf.Receive`), the files are handed to it. The command
      prints the result of each file as it finishes, then returns.
    - Otherwise this run listens on 6800 itself and waits up to 60 s for the board. It sends the files, prints one
      line per file (`a.lha  137323 bytes  OK` or `ERR <reason>`), then exits.
    - The return code is 0 when all files were sent, 5 (WARN) when some were, and 10 (ERROR) when none were.
      Ctrl-C stops it.
  - `TRUST` accepts the board now connected as the trusted one (§6).
- **The upload list is in memory only.** Items still waiting when Receive stops are lost. After a reset the user
  sends again, and the server's resume (U4) skips what it already has.
- **Reading the file:** it is opened with a shared lock and read in 8 KB blocks. The CRC-32 is computed while
  sending, with no extra pass over the file (a pre-pass would double floppy reads). The size, the protection bits,
  the comment and the DateStamp come from `Examine`.
- **Portable core:** `tools/receive/core/rx_proto.c` gains the upload state machine (PUT, TAKE/NO, the credit
  window, END, the outcome). It reads the file through new `rx_fs` callbacks (`open_r`, `read`, `seek`, `close_r`),
  so the POSIX build and the fake board test it all on the Mac.

## 3. The protocol, version 2 (board ↔ Receive, TCP 6800)

Phase 4's framing is kept: ASCII lines ending in LF, Latin-1 names given as `<len>:<bytes>`, and raw bytes only where
stated. Every protocol 1 line stays valid.

**Hello and versions:**
- Board → Amiga: `WEBADF 2 <key>`. `<key>` is 32 hex digits (§6).
  - Receive 1 answers `READY 1` to any `WEBADF` line (rx_proto.c:198). The board then never offers uploads.
  - Receive 2 answers `READY 2`.
- Receive 2 hearing `WEBADF 1` answers `READY 1` and disables uploads ("update the board").

**Upload, Amiga → board** (only after `READY 2`, and only while no FILE from the board is moving):
1. `PUT <tag> <size> <date> <prot hex> <len>:<path> <len>:<comment>` announces a file.
   - `<tag>` is Receive's local number for the item.
   - `<date>` is the DateStamp as `days.mins.ticks`. It serves resume, nothing else.
   - The path follows Phase 4's rules: `/` separates parts, each part is 1-30 bytes, the whole is at most 255 bytes,
     and there is no `:`, `.` or `..`.
2. The board opens the upload on the server (§4). It answers one of:
   - `TAKE <tag> <offset> <credit>`: send bytes from `<offset>` (0, or the resume point) up to the absolute offset
     `<credit>`;
   - `NO <tag> <code> <len>:<text>`: refused. The codes are `size`, `full`, `name`, `offline`, `auth`, `busy` and
     `server`.
3. The Amiga seeks to `<offset>` and sends raw bytes, never past the current credit.
   - The board raises the credit with `MORE <tag> <credit>` each time a 16 KB chunk is stored on the server. The
     window is two chunks (32 KB). The application, not TCP, bounds the board's memory, so lwIP's 46 KB `TCP_WND`
     never matters.
   - `MORE` also carries the progress the window shows.
4. After the last byte the Amiga sends `END <tag> <crc32 hex>`. The CRC covers the whole file, including any part
   sent before a resume, so on resume Receive reads the skipped part once to compute it. It does not send it again.
5. The board stores the last chunk and closes the upload (§4). It answers `DONE <tag> <len>:<name as stored>` or
   `NO <tag> <code> <len>:<text>` (codes as in step 2, plus `crc`).

**Arbitration:**
- The board finishes a file it is sending down before it answers a PUT.
- Between files, a waiting PUT goes before the next download, so each direction takes turns.
- `PING`/`PONG` are unchanged. The board does not ping during a file in either direction, because data counts as
  liveness.
- A connection silent for 75 s is dropped, as today.

**Stops:**
- The Amiga stops a file with `ABORT <tag>`. The board answers `NO <tag> busy <len>:cancelled` and keeps the
  partial upload on the server for resume.
- A dropped connection ends the file on both sides. The server's partial upload stays for 24 h.

## 4. The server

**Tables** (migration 0043):
- `amiga_uploads`, one table for the org's destination area (U6), indexed on `(org_id, created_at)`:
  - who and where: `id`, `org_id`, `device_id` (`on delete set null`), `device_name` (a copy, so a row still names
    its board after the board is unpaired or renamed);
  - the file: `path` (UTF-8, decoded from Latin-1 and cleaned by `cleanAmigaPath`), `size_bytes`, `crc32`,
    `protection`, `comment`, `amiga_date` (text);
  - progress: `status` (`receiving | stored | failed | deleted`), `received_bytes`, `error_code`, `blob_sha256`;
  - times: `created_at`, `stored_at`, `expires_at`;
  - the result: `library_disk_id`, set when the file was added to the library.
- `amiga_upload_chunks`: `(upload_id, offset)` primary key, `data bytea` (≤ 16 KB), on delete cascade. This is the
  `disk_write_tracks` pattern: Vercel functions are stateless and blob stores cannot append, so chunks are staged in
  Postgres.

**Device routes** (`requireDevice`; the org is always the device's, never taken from a body):
- `POST /api/device/upload` with JSON `{size, date, protection, path, comment}` returns `{id, offset}`, or 4xx
  `{code}`.
  - It checks the per-file limit and the org's area limits (U5). Expired rows do not count, per the 3bv I1 lesson. The count and
    the insert happen in one transaction, so two concurrent opens cannot both pass the limit (3bv m8).
  - It reuses a `receiving` row with the same device, path, size and date that has not expired, and returns its
    `received_bytes` as the offset.
- `POST /api/device/upload/<id>?offset=<o>` with a raw body of 1-16,384 bytes:
  - `<o>` equal to `received_bytes` is stored and answered `{received}`;
  - `<o>` below it is a retry of a stored chunk: `{received}`, with nothing written;
  - `<o>` above it is answered 409 `{received}`. The board cannot fill the gap, so it ends the file with `NO …
    server`, and the next PUT resumes.
- `POST /api/device/upload/<id>/close` with `{crc32}`:
  - It reads the chunks in order, then checks the total size and the CRC-32. It computes the sha256 and stores the
    bytes content-addressed under `uploads/<sha256>` through `diskStore`, so local disk and Vercel Blob work alike.
  - It deletes the chunks and sets `stored`.
  - A CRC mismatch is final: the row is marked `failed crc` and its chunks are deleted. The answer is `{name}` or
    409 `{code}`.
  - A 4 MB close reads 256 rows; this is timed against `maxDuration` 60 in the plan.

**User routes** (session org):
- `GET /api/uploads` lists the org's destination area, newest first, with each row's board. An optional `?board=`
  filters it.
- `GET /api/uploads/<id>/file` streams the file with `content-disposition: attachment; filename*=UTF-8''…`,
  `x-content-type-options: nosniff` and `content-type: application/octet-stream`. It is never rendered inline: an
  uploaded `.html` must not become stored XSS.
- `POST /api/uploads/<id>/library`:
  - It puts the bytes at `adf/<sha256>` and calls `registerUploads(orgId, [{sha256, sizeBytes, filename}])`. This
    is the same single code path as the browser upload and URL fetch (ingest-complete.ts).
  - It is offered only for the library's accepted extensions and for sizes up to `MAX_DISK_BYTES`. On success it sets
    `library_disk_id`.
- `POST /api/uploads/<id>/send` queues the file to a board through `queueTransferFromBlob`, so a file can go from one
  Amiga to another.
- `DELETE /api/uploads/<id>` deletes one file.
- `POST /api/uploads/clear` with `{before}` (the newest `created_at` the user saw) deletes every stored or failed
  row of the org up to that time. A file that arrives while the confirm is open is not cleared unseen. A row still
  `receiving` is left alone. The answer gives the count deleted.
- Deleting marks a row `deleted` and drops its chunks at once. The blob goes at the next weekly GC once nothing else
  refers to it, because a library disk or a queued transfer may share it.

**Housekeeping:**
- The existing daily `GET /api/cron/transfers` also:
  - fails `receiving` rows older than 24 h and deletes their chunks;
  - deletes `stored` rows past `expires_at`.
- **`amiga_uploads.blob_sha256` joins `runBlobGc`'s reference list**, while the row is not deleted (the weekly blob GC
  rule).

**Status and card:**
- The board reports nothing new: progress follows from the chunk offsets, as in Phase 4.
- The board's card line adds "2 files from the Amiga" (stored within 24 h). It links to the destination area,
  filtered to that board.
- Help: one topic in `src/lib/help/topics.tsx`, written with the code it describes.

## 5. Firmware 1.17.0

**The local path:**
- `PNET_LOCAL_A2B_MAX` rises to 1,514.
- The amiga_tcp receive callback copies the data into the PSRAM fill buffer, then calls `pbuf_free` and `tcp_recved`
  at once. The credit window (§3) is what bounds the memory.
- Out-of-order segments are limited (`TCP_OOSEQ_MAX_PBUFS`, or by the board refusing them) so they cannot hold the
  16 KB lwIP heap. The plan sets the value from the step 0 measurement.

**The engine:**
- `amiga_send.c` gains the upload phases (`AS_UP_OPEN`, `AS_UP_DATA`, `AS_UP_CLOSE`) beside the send phases, in the
  same pure state machine.
- New `as_ops_t` calls: `upload_open`, `upload_chunk` and `upload_close`. Each is one HTTPS request, so each fits
  the "one HTTPS request per `as_step()`" rule.
- `as_has_work()` is true while an upload is open, so the long poll is skipped. That is what the send engine does
  today, and 3bv's 28 s gap bug is the lesson.

**Memory:**
- **Two 16 KB buffers, both in PSRAM:**
  - the existing send chunk buffer, reused, because one direction moves at a time;
  - one new buffer.

  One fills from TCP while the other is posted.
- The upload state, the PUT line and the board key also live in PSRAM (in the struct `main.c` already places there).
  **SRAM `.bss` +0**, checked against 431,584.

**The board key:**
- 16 random bytes from the RP2350's TRNG, made at first use and kept in `config_store`. It survives re-pairing and
  OTA. A factory reset makes a new one.
- The status report carries the first 4 hex digits (`upKey`), so the web app can show them (§6).

**Failures:**
- An HTTPS failure on a chunk backs off from 1 s to 30 s, as today, while the long poll runs. The credit does not
  move, so the Amiga simply waits.
- After 120 s without progress, the board sends `NO <tag> offline` and keeps nothing. The server's partial upload
  remains for resume.
- A 401 (an unpaired board) gives `NO <tag> auth`.

**Logs:** `up: <tag> open <path> <size> at <offset>`, `up: <tag> stored <bytes> -> <name>` and
`up: <tag> NO <code>`.

## 6. Security

- **Server side:**
  - Device routes authenticate the device token. The org and the board come from the token.
  - The destination area is visible only to members of that org. There is no cross-org lookup by id: every query filters on
    `org_id`.
- **Names:**
  - Cleaned twice, by Receive and by the server (`cleanAmigaPath`).
  - Stored as data and never used as a storage key: blobs are content-addressed.
  - Served only as an attachment with `nosniff`.
- **Caps:** the size is announced in PUT and enforced on the server three times: at open, on every chunk (the total
  can never pass the announced size) and at close. The org's count and byte caps are checked in the open's
  transaction. There is one open upload per board.
- **The Amiga side, which is new:** an upload is the user's file leaving the Amiga.
  - Today any LAN host can connect to 6800 while Receive runs (Phase 4 D9). An impostor that got there first could
    *collect* uploads. So Receive uploads only to its trusted board.
  - The board's hello carries its key. Frames from the board to the Amiga travel the board's local path into Paula
    and never go out by radio, so no other LAN host can see the key.
  - On first contact (no `ENVARC:webadf/BoardKey`), Receive saves the key and shows "Trusted board AB12". The Upload
    page shows the same 4 digits, so the user can compare.
  - A different key turns uploads off with "Another board or computer connected -- not sending". Choosing **Trust
    this board** in the window, or `TRUST` in the Shell, replaces the saved key.
  - Downloads keep Phase 4's accepted risk, unchanged.
- **Nothing is executed** on the server, and an uploaded disk image is parsed only by the existing ingest path, when
  the user asks for it.

## 7. LZ4 and throughput

- Uploads use whatever the driver sends:
  - 68000/010: RLE, the stock rate;
  - 68020+ with our driver variant (`1.1-webadf-lz4`): LZ4, linked within a batch (3bw).
- Neither Receive nor the board's upload code does anything for LZ4. It is already applied below IP.
- The A2B bulk rate has never been measured: Phase 4 moved only acks upward.
  - Step 0 measures it on the A500, and on the A4000D when that bench happens. LZ4 uploads there are still owed
    (3bw).
  - If raw `0x4000` LZ4 uploads misread on the A4000D, switch to `0xC000`, which the board already accepts (3bw). That
    is a driver change, not part of this design.
- An estimate only, to be replaced by the measurement: of the same order as downloads (an 880 KB ADF in 2-3 min on a
  68000). On a 68000, Receive's file reads and the TCP stack are likely to be the limit, as the downloads showed
  (3bw).

## 8. Error handling

| Case | What happens |
|---|---|
| Amiga reset or Receive closed mid-file | The TCP connection drops. The board discards its buffers, and the server keeps a `receiving` row. Sending the same file again (same path, size and date) resumes at the stored offset. After 24 h the cron fails the row and deletes its chunks. |
| Board reboot or power loss mid-file | As above. Receive shows "failed: connection" and offers Retry, which sends a new PUT and resumes. |
| Board cannot reach the server | At open: `NO offline` after the backoff, about 60 s. Mid-file: the Amiga waits; after 120 s `NO offline` and resume later. The window says "waiting for the web app" while the credit is stalled. |
| Server refuses (size, full, name, auth) | `NO <code> <text>`, shown as "failed: <text>". It is final for that item; Retry re-asks the server. |
| CRC mismatch at close | `NO crc`. The server deletes the partial upload, so the next send starts at 0. |
| Board not connected to Receive | The item waits as "waiting for the board". The board connects within 30 s (its idle probe) and holds the connection. The Shell form gives up after 60 s with RC 10. |
| Old board or old Receive | Protocol 1 only. Receive 2 says "update the board"; the card says "Update to 1.17.0 to send files from the Amiga". |
| A download and an upload at once | They take turns per file (§3). |
| Untrusted peer on 6800 | Downloads behave as in Phase 4. Uploads are refused locally and never announced (§6). |

## 9. Self-host parity

- The same routes, tables and cron on both deployments. The staging is Postgres and the blobs go through
  `diskStore`, so the local storage backend works as Vercel Blob does.
- No our-deployment-only dependency is added. The 16 KB chunking is needed on Vercel (4.5 MB body limit) and harmless
  elsewhere, so both use the same sizes (Phase 4 D4's reasoning).
- `/api/cron/transfers` already runs under the self-host scheduler (it is in `vercel.ts`).
- The driver disk carries the new Receive, so the image's bundled disk and its pin change together (3bv F19 pattern).
- docker-smoke gains an upload round trip against the fake board.

## 10. Delivery and testing

One plan, four increments, each testable on its own:

0. **Measure first (TEST build, no product code).**
   - Raise `PNET_LOCAL_A2B_MAX` and add a board-side discard service on a debug port.
   - On the A500, copy a 1 MB file to it with AmiTCP (`tcp`/`nc`, or a 20-line test tool). Record the A2B
     bytes/s, the heap low-water, `local_drops` and the ping during the copy.
   - The cap rise and U9 are confirmed here. The rest of the plan's numbers (window size, OOSEQ) come from it.
   - Bench notes start "TEST build" (the 3bu incident).
1. **Receive 2 and the protocol.**
   - Core host tests:
     - PUT/TAKE/NO/MORE/END/DONE parsing;
     - credit never exceeded;
     - resume CRC over the skipped part;
     - ABORT;
     - a v1 board (`WEBADF 1`) disables uploads;
     - the key's trust-on-first-use, then a mismatch, then TRUST.
   - `fake-board.ts` gains the upload side.
   - Scenarios run on the POSIX build and in FS-UAE on Kickstart 2.04, 3.1 and 3.2: a small file, a 4 MB file, a
     drawer, a resume after the connection is killed, a CRC fault injected by the fake board, a refusal and a v1
     board.
   - The AppWindow drop and multi-select cannot be driven in FS-UAE from here (as **Choose…** was in 3bt), so they
     move to the bench.
2. **Firmware 1.17.0 and the server.**
   - `test_amiga_send.c`:
     - upload phases against fake ops;
     - the arbitration with a waiting download;
     - the backoff and the 120 s give-up;
     - a 409 offset;
     - the key in the hello.
   - Server: vitest and db tests for open/chunk/close, limits under concurrency, resume matching, CRC failure,
     expiry, GC references and org scoping.
   - The board is then proven against FS-UAE and the real A500 with uploads started from the Shell.
3. **Web.**
   - The *From the Amiga* destination area: all of the org's boards, the board on each row, the board filter,
     Download, Delete, Clear all (with its confirm and the `before` guard), Add to library and Send to an Amiga. Also
     the card line, the key digits and help.
   - e2e for the touched areas only, on PORT 3100, against a simulated board.
   - The driver disk is rebuilt and re-pinned, under the rollout rule: never swapped under a running driver.

**A500 bench** (the operator powers the Amiga and types; ask at the end of a turn):
1. Reinstall Receive from the new driver disk. Start it: "Trusted board AB12" matches the Upload page.
2. Drop an LHA, a text file and an 880 KB ADF on the window. All three read "to web: done". The sha256 on the web
   matches `sha256` (or the CRC from Receive's log) on the Amiga. Record the time of each.
3. Add the ADF to the library and mount it in DF0. Delete the text file, then Clear all: the area is empty, and the
   ADF is still in the library.
4. `Receive SEND RAM:x.txt` from a Shell, with Receive's window open (a handoff) and with it closed (a run of its
   own).
5. Reset the Amiga at about 40 % of the ADF, then send it again. The log shows `at <offset>` and the file is whole.
6. Unplug the board's Wi-Fi (or block the server) mid-file: "waiting for the web app", then `NO offline`; send
   again later and it resumes.
7. Send a file down and drop a file up at the same time: both arrive.
8. Point a Mac at the Amiga's 6800 before the board connects: uploads are refused locally.
9. Ping the router during an upload, and read the heap low-water from the log.
10. On the A4000D, when it is available: the same as step 2, with the `lz4 in` counter > 0.

## 11. Not in scope

- An upload list that survives a reset, and automatic uploads (a watched folder, WBStartup).
- Files over 4 MB, hard disk images (HDF) and whole partitions.
- Reading a disk in DF0 *as an ADF* on the Amiga side. The board can already capture what the Amiga writes, but
  turning a physical floppy into an ADF is a separate feature.
- Adding to the library automatically (U6).
- Kickstart 1.3 (Phase 4 D7).

## 12. Open questions for the operator

1. **The program's name.** Keep `Receive` with a `SEND` mode, or rename it (for example `Transfer`) and keep a
   `Receive` alias? *Recommend: keep `Receive`.* Install, `C:`, help and the bench all use the name, and the
   window title already says both directions.
2. **AppIcon on the Workbench desktop.** It is feasible (V36 `AddAppIconA`), but only while Receive runs, and it
   duplicates the AppWindow. *Recommend: not in v1.* Add it later as "iconify to an AppIcon" if users ask.
3. **Trust on first use for the board key (U7).** Is it worth the extra UI, or is the home-LAN risk accepted as in
   Phase 4 D9? *Recommend: keep TOFU.* An upload sends the user's file away, which is a worse outcome than a file
   dropped in, and the key is free to keep secret because it never goes out by radio.
4. **Retention and quota of the destination area.** *Recommend: 30 days, and 500 files / 256 MB per org.* Clear all
   (U6) is the user's own way to empty it; the expiry covers files nobody cleans up. A file worth keeping goes to the
   library or is downloaded.
5. **Per-file cap.** *Recommend: 4 MB, the same as sending.* The chunking would allow more, but Postgres staging and
   the 60 s close bound it, and 4 MB covers ADF, HD ADF, DMS and typical LHA archives. Raise it later if a use case
   appears.
6. **Should ADFs be added to the library automatically?** *Recommend: no, a button.* The operator's wording was
   "optionally offered", and an automatic add would put unwanted disks in the library and run its sweeps.
7. **Drawers.** Walk a dropped drawer and upload its files with their sub-paths (up to 64), or files only?
   *Recommend: walk drawers.* It matches Browse → Send of a folder in Phase 4, and the destination area shows the paths.
8. **Where the destination area sits.** U6 settles that it is one area for the whole org, so it no longer belongs
   under one board's send queue. Should it be its own page or a full-width card on the Upload page? *Recommend: a
   full-width card on the Upload page,* below the two matching cards (cdc6bed). Uploads in both directions then live
   on one page, and the card links to it directly (`/ingest#from-amiga`).
9. **Measure before building (increment 0).** *Recommend: yes.* The A2B bulk rate and the lwIP heap with
   1,514-byte frames are both unmeasured. The heap is at its floor, so a wrong guess here costs the most.
