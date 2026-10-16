# PaulaNET Phase 4: send files from the web app to the Amiga (design, 2026-10-16)

**Status:** the operator approved this design in conversation on 2026-10-16, section by section. This document is for
review before the plan is written.

**Goal:**
- From the web app, send to an Amiga that is online through PaulaNET:
  - files from the user's computer;
  - files or folders from inside a library disk;
  - a whole disk as an `.adf` file.
- They land in a folder the user chose on the Amiga, through a small Amiga program, **`Receive`**.
- `Receive` has a window (set the folder, see the receiving queue) and a Shell form. It is started by hand.
- A file sent while `Receive` is not running waits in a queue and is delivered when it starts.

**Background:**
- Phase 3 spec `2026-10-12-paulanet-phase3-network-setting-design.md` §9 (Phase 4 outline).
- HANDOFF §3bm: fw 1.12.1's local path, so the board and the Amiga reach each other. Frames from the board to the Amiga
  are full size. Frames from the Amiga to the board are capped at 256 bytes (`PNET_LOCAL_A2B_MAX`), which is enough
  for TCP acks and short replies.
- PaulaNET measured 47.5 KB/s (§3bi): an 880 KB ADF takes about 20 s.

## 1. Decisions

| | Decision |
|---|---|
| D1 | **The board connects to the Amiga.** `Receive` listens on TCP port **6800**. The board knows the Amiga's address from its DHCP snooping (`net.amigaIp`, already reported). The Amiga needs no address configured. The Amiga cannot do HTTPS in practice, so the board relays: server → board → Amiga. |
| D2 | **Stream, don't stage.** The board downloads a file in ranged chunks over its existing HTTPS session and forwards each chunk to the Amiga before fetching the next. No PSRAM slot is used, so disk slots and preloads are untouched. |
| D3 | **Queue on the server.** Each send is a row in a per-device queue. Files wait until the receiver is reachable. A user can cancel a waiting file. |
| D4 | **Limits:** 4 MB per file (Vercel's 4.5 MB body limit; self-hosted copies use the same limit, since the two must match). At most 32 waiting files or 16 MB per board. Waiting files expire after 24 h. Finished rows are kept for 7 days. |
| D5 | **Started by hand.** `Receive` runs only while the user has it open. There is no startup entry. |
| D6 | **One binary, two front ends.** Started from Workbench, it opens a window. Started from a Shell, it is a command, unless given `GUI`. |
| D7 | **Floor: Kickstart 2.04 (V37), 68000, no FPU.** intuition, gadtools, asl, dos, icon and bsdsocket only. No MUI, ReAction, ClassAct, BOOPSI classes or third-party libraries. 1.3 is not supported: every TCP/IP stack people run on PaulaNET needs 2.0 or newer. |
| D8 | **Never overwrite; stay inside the folder.** A name already taken becomes `Name_2.ext`, `Name_3.ext`, and so on. `..`, absolute paths and device names are refused. |
| D9 | **Accepted risk:** while `Receive` runs, any LAN host can connect to port 6800 and drop a file into the folder. It cannot overwrite, cannot escape the folder, and nothing is executed. The port is open only while the user runs the program. Pinning `Receive` to the board's address was rejected because DHCP moves it. |
| D10 | **Folder setting** in `ENVARC:webadf/ReceiveDir`, copied to `ENV:webadf/ReceiveDir` on save. The default is `RAM:`. |
| D11 | **Firmware gate:** the feature needs the next firmware minor, **1.14.0** (`XFER_FW`). Older boards are not offered as targets. |

## 2. The protocol (board ↔ `Receive`, TCP 6800)

ASCII lines ending in LF, followed by raw file bytes where stated. Names and comments are ISO-8859-1 bytes,
length-prefixed so they may contain spaces. Version 1.

**Board → Amiga:**
- `WEBADF 1` is the hello. The receiver answers `READY 1`.
- `LIST <n>` is followed by `n` lines of `<id> <size> <len>:<path>`. It replaces the receiver's list of waiting
  files. It is sent after the hello and again whenever the queue changes, including a cancel.
- `FILE <id> <size> <crc32 hex> <protection hex> <len>:<path> <len>:<comment>` announces a file. The receiver checks
  the name and the free space and answers `GO <id>` or `ERR <id> <code> <text>`. After `GO`, exactly `<size>` bytes
  follow. The receiver then answers `OK <id> <len>:<saved path>` or `ERR <id> <code> <text>`.
- `PING` is sent every 30 s when idle. The receiver answers `PONG`. A missing `PONG` for 10 s closes the connection.

**Error codes:** `space`, `crc`, `name`, `write`, `folder` (the folder is missing), `busy`.

**The receiver writes** to `<folder>/<path>.part`. After the CRC matches, it renames the file to the final collision-free
name, then sets the protection bits and the comment. On any failure, or if the connection drops, it deletes the `.part`
file.

**Paths:**
- `/` separates path parts. Each part is at most 30 characters, with no `:` and not `.` or `..`.
- The server cleans names before queueing, and the receiver checks them again (D8).
- The receiver creates missing folders.

## 3. Firmware (1.14.0)

- **The poll response** gains `xfer: { queue: [{id, size, path}], next: {id, size, crc32, protection, path, comment} | null }`.
  It is present only for boards that send `&xfer=1` (fw ≥ 1.14.0).
- **The connection:**
  - When the queue is non-empty, the board is in Network mode and `amigaIp` is known, the board connects to
    `amigaIp:6800` every 5 s until it succeeds.
  - When the queue is empty, it probes every 30 s, so the card can say whether `Receive` is running.
  - It holds the connection open while the receiver answers `PONG`.
- **Sending:**
  - The board reads chunks from `GET /api/device/transfer/<id>?offset=<o>&length=<n>`, with a device token and up to 16 KB
    per chunk, and writes each chunk to the socket before reading the next.
  - Progress (bytes sent) is reported at most every 2 s.
  - The outcome (`OK` with the saved path, or `ERR` with code and text) is reported at once on the status route.
- **Report fields:**
  - `xfer: {receiver: 'connected' | 'refused' | 'unreachable', lastContactAt}`;
  - `xferProgress: {id, bytes}`;
  - `xferDone: [{id, ok, savedAs | code, text}]`.
- **Memory:**
  - Chunks come from the lwIP heap. The TLS pool is never used for the Amiga socket.
  - The heap low-water is checked against 1.13.0 (28,672) before release.
- **Logs:** `xfer: receiver connected <ip>`, `xfer: <id> sent <bytes> -> OK <path>` and `xfer: <id> ERR <code>`.

## 4. Server and web

- **Table `transfers`** (migration 0040):
  - who and where: `id`, `org_id`, `device_id`, `created_by_user_id`;
  - the file: `path`, `size`, `crc32`, `protection`, `comment`, `blob_sha256`;
  - progress: `status` (queued | sending | delivered | failed | cancelled | expired), `error_code`, `error_text`,
    `saved_as`, `bytes_sent`;
  - times: `created_at`, `expires_at`, `finished_at`.
- **Blobs:**
  - Files from the computer and from inside a disk are stored content-addressed under `transfers/<sha256>`.
  - A whole ADF reuses the disk's existing blob.
  - **Rows in `queued` or `sending` join `runBlobGc`'s reference list.**
- **Expiry:** a new daily cron, `GET /api/cron/transfers` (CRON_SECRET, in `vercel.ts`, so the self-host scheduler
  runs it too), marks `queued` rows past `expires_at` as `expired` and deletes rows finished more than 7 days ago. The
  poll also skips expired rows, so a missed run never delivers a stale file.
- **Sources:**
  - **The drop zone on the board's card:** the browser uploads each file (≤ 4 MB) to `POST /api/transfers`, and the
    server stores it, computes its CRC and queues it.
  - **The disk Browse page:** "Send to Amiga" on the selected files or folders. The server reads the disk's current
    version with `src/lib/adffs`. Each file becomes one row with its relative path, protection bits and comment.
  - **The disk row:** "Send .adf to Amiga" for disks that have an ADF; the name is `<disk name>.adf`.
- **Target board:**
  - the org's boards on fw ≥ `XFER_FW`, with a picker when there are several;
  - a board not in Network mode still takes files, and the card says they wait for Network and `Receive`.
- **The card:**
  - the queue: waiting, sending NN %, delivered (saved as …), failed (reason, with Retry) and cancelled, with Cancel
    on waiting files;
  - receiver status: "Receive is running on the Amiga" (contact within 60 s), or "Start Receive on the Amiga" while
    files wait.
- **Help topic** for sending files, written in `src/lib/help/topics.tsx` with the code it describes.

## 5. `Receive` on the Amiga

- **Code:** portable C core in `tools/receive/`:
  - the protocol parser;
  - name cleanup, path confinement and collision names;
  - CRC32;
  - the free-space check through a callback.
- The Amiga-only front ends (Workbench window, Shell) and the bsdsocket glue sit on top of the core.
- **Shell template:** `TO/K,SAVE/S,GUI/S`.
  - `Receive` uses the saved folder;
  - `TO <dir>` sets the folder for this run, and `SAVE` also stores it;
  - output is one line per file, `<path>  <bytes> bytes  OK` or `ERR <reason>`;
  - Ctrl-C stops it.
- **Window:**
  - It uses gadtools, is font-sensitive and fits 640×200.
  - "Save files to:" is a string gadget with **Choose…**, which opens an asl drawer requester (on V37, a file requester
    whose drawer is taken), and **Save**.
  - A status line reads "Listening on port 6800", "No TCP/IP stack running (bsdsocket.library)" or "Folder not found".
  - A listview holds the receiving queue: name, size and state (waiting / receiving NN % / done / failed: reason).
  - The close gadget stops receiving. Waiting files stay queued on the server.
- **Build:**
  - The toolchain is a Docker stage pinned by digest.
  - Its output goes onto the PaulaNET disk by `tools/paulanet-disk/build.sh`, with an icon.
  - The disk's pinned sha256 (`PAULANET_DISK_SHA256`) changes; the image build still fails on a mismatch.
- **`Install`** gains one step: copy `Receive` and `Receive.info` to `SYS:Tools/`, and `Receive` to `C:`. The step is
  safe to run twice.
- The disk's `ReadMe` says how to use `Receive`.

## 6. Delivery

One plan in three increments, each testable on its own:
1. **`Receive` and the protocol.** The core, both front ends and the disk, proven in FS-UAE against a fake board
   (`tools/receive/fake-board.ts`) on the Mac.
2. **Firmware 1.14.0 and the server queue.** The poll fields, the transfer route, the table, the status reports and
   GC. Proven with a real board in front of FS-UAE or the A500, with rows queued by script.
3. **Web sources and the card.** The drop zone, Browse → Send, Send `.adf`, the queue on the card and the help topic.

## 7. Testing

- **The core (host):**
  - protocol parse and replies;
  - collision names;
  - confinement (`..`, `:`, absolute paths, 31-character parts);
  - CRC32 against known vectors;
  - `.part` cleanup on a dropped connection;
  - a no-space refusal.
- **FS-UAE** (bsdsocket emulation, Kickstart 3.1 and 3.2, against the fake board):
  - small and 4 MB files, a folder, a collision, a CRC error, a full volume;
  - closing the window mid-file, then the Shell form;
  - a screenshot of the window at 640×200.
  - **Kickstart 2.04 is built for but not tested:** there is no 2.04 ROM on this machine.
- **Firmware (host):** the line framing, the state machine (connect, list, file, go/err, ok/err, ping) and the chunk
  loop against a fake socket. The TEST build is installed with the Amiga off.
- **Server:**
  - vitest and db tests for queueing, limits (size, count, total), cleaned names, cancel, expiry and GC references;
  - the transfer route's ranges and auth.
- **e2e** for the touched areas only (PORT 3100): drop zone, Browse → Send, Send `.adf`, cancel, and the card's states
  driven by a simulated board.
- **A500 bench** (the operator powers the Amiga and types; ask at the end of a turn):
  1. Reinstall from the new driver disk.
  2. Start `Receive` from its icon, set `DH0:Downloads` and Save.
  3. Send an LHA from the computer, a folder from a disk, and an ADF. All three show as done, and the files are there.
  4. Close `Receive`, send a file (the card shows it waiting), start `Receive` (it arrives).
  5. Cancel a waiting file. It leaves both lists.
  6. Run `Receive TO RAM:` once in a Shell.
  7. Ping the router during an ADF transfer and note the times.

## 8. Not in scope

- Amiga → web app transfers (the local path caps Amiga frames at 256 bytes);
- starting `Receive` automatically;
- Kickstart 1.3;
- sending to several boards at once;
- resuming a half-sent file (a failed file is sent again from the start by Retry).
