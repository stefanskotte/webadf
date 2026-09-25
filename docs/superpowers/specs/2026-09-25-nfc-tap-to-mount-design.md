# NFC tap-to-mount — design

**Date:** 2026-09-25 · **Status:** approved in conversation, section by section; this document
awaits the operator's review before planning. **Branch:** `feat/nfc-tap-to-mount`.

## 1. What this is for

Hold a tag against the wifi-floppy and the Amiga gets that disk, the way a person would push a
floppy into a drive. Tags are written on request: the operator says "write Turrican II disk 1 to a
tag", Claude runs one command, the operator taps a blank tag, and it is done. There is no web UI
for writing (HANDOFF §4, NFC entry, operator 2026-09-25).

**Success means:**
- A written tag mounts its disk on the board that reads it, within the normal mount time.
- Tapping the disk that is already in the drive does nothing. Tapping another tag swaps disks.
- A tag can only ever mount a disk from the reading board's own library.
- The floppy side is never disturbed: 0 TRACK-MISS while tapping during an Amiga disk read.
- A missing or loose reader never stops the drive from working.

## 2. Decisions taken (operator, 2026-09-25)

| # | Decision | Why |
|---|---|---|
| D1 | **The tag stores the disk ID** (the 36-char `disks.id`), not the SHA-256. | A disk's sha changes on every Amiga save (disk history moves `disks.sha256`, never `disks.id`), so a hash tag would go stale after the first save. The id names exactly one row. |
| D2 | **Tapping a different tag swaps; tapping the mounted disk's own tag is a no-op.** Eject stays in the web UI and the drive chips. | A stray double tap, or a tag left lying near the reader, can never pull a disk out from under a running game. |
| D3 | **Writing goes through the server**: `pnpm nfc:write "<disk>"` → a write request on the device row → carried by the poll → the board writes the next tag it sees → it reports the read-back. | Works whether or not the board is on this Mac's USB. Reuses the poll channel. Keeps the release firmware free of console input. |
| D4 | **The org comes from the board's token, never from the tag.** A foreign or unknown id is answered exactly like the other. | Only the board's own library can be mounted, and the endpoint reveals nothing about other libraries. |

## 3. The hardware (measured on the bench, 2026-09-25)

The module is an **HW-147C with a Si512** (HANDOFF §4 NFC entry has the full record). It is a
PN512-style part: I2C address **0x28**, VersionReg 0x82, RC522-compatible register map, and it
reads tags only after **ControlReg Initiator (0x10)** and the vendor's Type A init
(`PCD_SI512_TypeA_Init`). Both kit tags are **MIFARE Classic 1K** (ATQA 04 00). It shares I2C1
(GP18/GP19, header pins 24/25) with the SSD1306 OLED at 0x3C.

## 4. Firmware

### 4.1 Where the reader runs: core0, inside the display pump's budget

**The I2C bus already has an owner: core0**, the real-time floppy core, which drives the OLED from
`display_pump()` under a per-pass budget (`DISP_BUDGET_MOUNTED` / `DISP_BUDGET_IDLE`). The reader
joins that owner rather than taking the bus from another core. There is no cross-core bus lock.

`nfc_reader.c` is a **step-wise state machine**. One call to `nfc_step()` does at most a small,
fixed number of I2C transfers (target: ≤ 2, about 0.2 ms at 400 kHz), then returns. Waiting for the
chip (the Transceive IRQ, a soft reset) is a state, never a sleep. The main loop calls `nfc_step()`
from the same slot and under the same budget rule as `display_pump()`. The two share the pass: when
the display has work queued, the reader waits for the next pass.

States (sketch): `ABSENT → INIT (vendor Type A init, spread across steps) → IDLE (field on) →
WUPA → WAIT_IRQ → ANTICOLL → SELECT → AUTH (sector 1, key A) → READ blocks 4..6 → REPORT →
COOLDOWN`, with `WRITE` / `READBACK` in place of `READ` while a write is armed. Tag detection runs
about every 250 ms. **A tag is reported only when it ARRIVES**: the same UID staying on the field
triggers nothing until it has been absent for more than 1 s (debounce).

`nfc_probe.c` and its 20 s boot-time tag watch (branch `nfc-identify`) are **deleted**. The only
boot-time work is one presence check at 0x28.

### 4.2 Core0 → core1 handoff

Core1 owns the network. Core0 publishes reader events into a single-slot mailbox with a sequence
counter, the same torn-read-safe pattern `ui_publish`/`ui_snapshot` already use in the other
direction:

- `TAG_READ { uid, diskId }`
- `TAG_NOT_OURS { uid }` (no `WFDK` marker)
- `TAG_UNREADABLE { uid, why }` (auth failed = "locked", CRC bad, or the tag was pulled away)
- `WRITE_DONE { seq, uid, ok, why }`

Core1 publishes the write request to core0 the same way: `{ seq, diskId }`, or none.

Core1 turns `TAG_READ` into `POST /api/device/tap` and shows the answer through `ui_publish`.
All the other events are shown locally.

**A pending tap interrupts the held poll** (amendment, 2026-09-25, found while planning). Core1
spends up to 25 s inside a held poll (`dc_step` → `tls_read`'s wait loop), and a tap cannot be sent
on the same connection until that returns, so a naive design would make a tap take up to 25 s.
Instead:
- `transport_t` gains an optional `interrupted(ctx)` predicate. `tls_read`'s wait loop checks it
  and returns a distinct `TRANSPORT_INTERRUPTED` code.
- The device client installs the predicate only around the poll request. On
  `TRANSPORT_INTERRUPTED` it abandons the connection (it can't be reused mid-response) and
  returns from `dc_step` **without** backoff.
- Core1 then posts the tap. The next poll returns immediately with the new desired disk.
- **Cost:** one fresh TLS handshake (~1.25 s, measured) per tap, instead of up to 25 s of waiting.

### 4.3 Presence and loose leads

- **At boot:** one presence check at 0x28. Absent → state `ABSENT`, one log line, and the board
  runs exactly as today.
- **In `ABSENT`:** a presence check every 5 s. When the chip returns, run `INIT`. Log each change,
  once.
- **Every I2C transfer has a 5 ms timeout.** Three consecutive failures while present → `ABSENT`.
- **Status report:** `nfcReader: "present" | "absent"`, following the show-both-values rule. Older
  firmware omits the field, which the server stores as NULL = unknown.

### 4.4 OLED feedback

For about 3 s after an event, the OLED's detail line shows one of these, through the existing
`ui_publish`:

| Event | OLED line |
|---|---|
| Tap mounted a disk | `Tag: <title>` |
| Tap of the disk already in the drive | `Tag: already in drive` |
| Disk not in this library | `Tag: not in library` |
| Disk's tracks too long for this board | `Tag: tracks too long` |
| Tag without the marker | `Tag: not a disk tag` |
| Tag unreadable or locked | `Tag: unreadable` / `Tag: locked` |
| Board offline | `Tag: offline` |
| Tap ignored (within 1 s of the last) | `Tag: too fast` |
| Write armed | detail `Tap tag to write`, with the disk's title on the TITLE line |
| Write finished | `Tag written` / `Write failed` |

The activity LED blinks once on every tag arrival.

*Amended 2026-09-26 (controller ruling during implementation): the detail line holds 21 characters, so the
original "Tag: too long for board" and "Tap tag to write: <title>" did not fit.*

### 4.5 Tag format v1 (MIFARE Classic 1K, sector 1)

| Block | Bytes |
|---|---|
| 4 | `W F D K` · version `0x01` · length `36` · disk id [0..9] |
| 5 | disk id [10..25] |
| 6 | disk id [26..35] · CRC-16/CCITT-FALSE (big-endian) over bytes from `W` through the id's last byte · 4 × `0x00` |

- Authenticate sector 1 with **key A = FF FF FF FF FF FF** (the factory default), using the chip's
  hardware Crypto1 (`MFAuthent`, command 0x0E).
- **The sector trailer (block 7) is never written**, so tags stay re-writable with default keys.
- **Decode rules:**
  - marker mismatch → `TAG_NOT_OURS`;
  - version ≠ 1, length ≠ 36, id not matching the disk-id shape, or CRC mismatch →
    `TAG_UNREADABLE("bad data")`;
  - auth failure → `TAG_UNREADABLE("locked")`.
- A half-finished write therefore fails its CRC and can never mount the wrong disk.
- NTAG21x is a later addition (pages 4+, no auth); the codec is written so a second layout slots in.

## 5. Server

### 5.1 Schema (one additive migration, applied with guarded `ADD COLUMN IF NOT EXISTS`, not `db:push`)

`devices` gains:
- `nfc_reader text` (`present` / `absent` / NULL)
- `nfc_write_seq integer not null default 0`
- `nfc_write_disk_id text`
- `nfc_write_expires_at timestamptz`
- `nfc_write_result_seq integer`
- `nfc_write_result text` (`ok` / a reason)
- `nfc_write_result_uid text`
- `last_tap_at timestamptz`
- `last_tap_outcome text`

### 5.2 `POST /api/device/tap` (bearer, `requireDevice`)

- **Body:** `{ diskId }`, checked against the stableId shape
  (`^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`). Anything else is
  a 400 before any query. **Verified 2026-09-25:** all 62 live disk ids match, and every disk
  insert (ingest `complete`, `disks/create`, `extract`) builds its id with `stableId`, so the
  pattern holds by construction. A future disk-creation path that doesn't use `stableId` must
  widen this pattern.
- **Rate limit:** a tap within 1 s of this device's `last_tap_at` → `{ outcome: "ignored" }`, with
  no query beyond that read.
- If the device's `desired_disk_id` already equals `diskId` → `already` (no version bump).
- Otherwise `setDesired(orgId, deviceId, diskId)`:
  - ok → `mounting` + `title`;
  - `not_found` → `not_found`;
  - `track_too_long` → `too_long`.
- Records `last_tap_at` / `last_tap_outcome`. Answers 200 with `{ outcome, title? }`. Never 404s
  on a disk, so a foreign id and an unknown one look the same (D4).

### 5.3 The write request, carried by the poll

- `nfc:write` sets `nfc_write_seq = seq + 1`, `nfc_write_disk_id`, and `nfc_write_expires_at =
  now + 2 min`, and clears the result columns.
- **The board carries its own cursor:** the poll request gains `&nfcAck=<seq>`, the last write
  sequence the board has acted on (armed, disarmed or answered). This works like `since`, so no
  ack column is needed.
- **The poll's tick reads `nfc_write_seq`**, and the hold is released while
  `nfc_write_seq > nfcAck`. A wake signal is a cursor, not a flag.
- **The poll response** then carries `nfcWrite: { seq, diskId, title }`. `diskId` is `null` when
  the request was cancelled or has expired, which tells the board to disarm. The key is absent
  when the board is up to date.
- **Cancel:** the command exits on Ctrl-C (or times out) by writing `nfc_write_disk_id = NULL`
  with the seq bumped, so the board disarms on its next poll.

### 5.4 `POST /api/device/tap-write` (bearer)

- **Body:** `{ seq, ok, uid, reason? }`.
- Stored only when `seq` equals the row's current `nfc_write_seq` and no result is recorded yet.
  A stale or duplicate report is acknowledged and ignored.

### 5.5 `pnpm nfc:write "<query>"` (operator tool; reads `.env.local`, talks to the DB directly)

1. Resolves the query against the org's disks (title, disk number, TOSEC name, filename, or a
   literal id). **One match → proceed. Several → print them numbered and exit.** None → say so.
2. Picks the org's device (errors if more than one exists without `--device`). Refuses if
   `nfc_reader` is not `present`, printing what it is.
3. Sets the request, prints `Tap a tag on <device> to write "<title>" (2 min)…`, and polls the
   result columns every second.
4. Prints `written to tag <uid>, read back OK`, or the failure reason, or a timeout (then
   cancels).

## 6. Failure handling (summary)

| Situation | Behaviour |
|---|---|
| No reader or loose lead | Drive unaffected. Reader `ABSENT` with 5 s rechecks. Status reports `absent`. `nfc:write` refuses. |
| Tag pulled away mid-read | `TAG_UNREADABLE`. OLED `Tag: unreadable`. |
| Tag pulled away mid-write | Read-back mismatch → `WRITE_DONE ok=false`. The half-written tag fails its CRC later. Re-run the command. |
| Board offline at tap | `Tag: offline`. The tap is not queued. |
| Tap during an Amiga save | Same as a web mount; the write-back session closes before the swap (§4i). |
| Write request expires | The poll stops carrying it. The board also disarms after 2 min on its own. The command reports the timeout. |
| Foreign or unknown disk id | `not_found`, the same answer for both. |

## 7. Tests

- **Firmware host tests** (`test/`):
  - tag codec: encode, decode, CRC, foreign marker, bad version or length, truncated;
  - the reader state machine against a scripted fake Si512: no tag, tag present, same tag held
    (one report only), tag removed and returned, auth failure, chip vanishing and returning, a
    write with good and bad read-back;
  - **every `nfc_step()` stays within its transfer budget**;
  - mailbox torn-read safety.
- **Server vitest:**
  - `/tap`: each outcome, `already`, rate limit, a foreign disk id answered exactly like an
    unknown one, malformed body;
  - `/tap-write`: current, stale and duplicate seq;
  - the poll includes and excludes `nfcWrite` correctly (expiry, answered);
  - the tick moves on a new request;
  - the `nfc:write` resolver.
- **e2e:** a simulated device (the existing device helpers) taps a disk → desired moves; taps it
  again → `already`; a write round trip through poll → tap-write → result.
- **Bench acceptance (operator + the blue fob and white card):**
  - `nfc:write` a disk to the fob → read back OK;
  - tap it → the disk mounts;
  - tap again → no-op;
  - write the white card with a different disk, tap it → swap;
  - a blank tag → `not a disk tag`;
  - pull the reader's SDA lead → the drive carries on and status says `absent`; reseat it → it
    returns;
  - **tapping during an Amiga disk read → 0 TRACK-MISS**.

## 8. Rollout

1. Server first: migration, endpoints, tool. Older firmware ignores `nfcWrite`.
2. Firmware **1.3.0**, published through the registry. The board currently runs an unpublished
   bench build (`1.2.0+g6b9db28`). **Check before relying on it** that the Update flow accepts a
   target from an unregistered running version. If it doesn't, install once with BOOTSEL.
3. Full e2e alone on the database before merging (memory: parallel runs share one DB).

## 9. Out of scope

NTAG and other tag types; NDEF (phones won't read these tags as links); changing tag keys; any web
UI for tags; mounting a disk from another org; auto-eject on tag removal.
