# Write-back and disk history — design

**Date:** 2026-09-18
**Status:** approved in conversation 2026-09-18; this document awaits the operator's review.
**Supersedes:** the "write-back and layered disks" backlog entry in `HANDOFF.md`, and the
layered-disk backlog in `2026-08-29-device-plane-disk-change-design.md` §5.

## 0. Where this starts from

Measured on hardware before this design was written:

- The board captures a real Amiga write whole: 34 of 34 track writes decoded `0x7ff ALL bad 0`
  (HANDOFF §4d). Captures are decoded, logged and **discarded**; `WRITE_BACK_IMPLEMENTED` is 0.
- The bus is gated on SEL0 (HANDOFF §4e), so a write captured by the board is DF0's. Without
  that, a DF1 write would be applied to DF0's image. That was a prerequisite, and it is done.
- `psram_image_mark_dirty()` / `next_dirty()` / `clear_dirty()` exist on the board, but nothing
  calls them.
- The firmware has an MFM **decoder** (`mfm.c`) and no encoder. The server's encoder
  (`src/lib/adfmfm`) was written without dependencies so that it could be ported, and its golden
  tracks are asserted byte-identical to Greaseweazle's output.
- When a poll names the digest that is already mounted, `device_client.c` skips the fetch and
  just applies `writeProtected` (`dc_complete_transition`). So bumping the poll version for a
  flag-only change costs one poll, not a re-download. **HANDOFF's "propagate a write-protect
  flip" entry says the opposite, and it is out of date.**

## 1. Decisions, and what was known when they were taken

| # | Decision | Why |
|---|---|---|
| D1 | **A point in a disk's history is an idle-bounded session**: it closes after 3 s with no writes, and at eject. | One Amiga save is many track writes (data, directory, bitmap). A version per track write would fill the timeline with half-written disks that AmigaDOS would call corrupt. A version per mount could not undo one bad save within a long session. |
| D2 | **Rewind adds a version; it never deletes history.** | A mistaken rewind can then be undone. History only grows. |
| D3 | **Offline: keep accepting writes and upload them on reconnect.** Losing power while offline loses the unsent writes, and the operator accepts that as force majeure. | Write-protecting while offline would make saves fail on the Amiga at every Wi-Fi hiccup. |
| D4 | **Storage: a sector change log, plus the current version stored as an ordinary blob.** | Storing changes only would have forced every reader of a disk to be rewritten. A full copy per session would record nothing about *what* changed. Keeping both leaves every existing reader untouched, while the history stays small and legible. |
| D5 | **A partial or corrupt capture is rejected, not applied.** | The stored copy keeps its previous contents; AmigaDOS reads the old data back. This is safer than serving damage, and every rejection is logged. |
| D6 | **The board re-encodes a written track** in the standard format, and never serves the Amiga's raw bitstream. | Every served track then stays in the one format the pipeline has been proven on. |
| D7 | **An eject never discards writes.** The board flushes and closes the session before it releases a disk, and holds the disk while it is offline. | It follows from D3. |
| D8 | **A cloud icon on the OLED shows sync state** (requested by the operator). | It answers "can I switch off now?". See §3.2. |

## 2. Piece 1 — the board applies a write

The service loop in `main.c` already turns a finished capture into a decoded track and logs it.
With the build flag `WF_WRITE_BACK=ON`:

1. **Accept only a whole, clean track.** All 11 sectors must decode with good checksums, and the
   track number the sectors carry must match the track sampled when WGATE asserted
   (`write_track`). Anything else is logged (`write: trk N rejected: <reason>`) and never applied.
2. **Re-encode.** The 11 decoded sectors are encoded as a standard MFM track by a C port of
   `src/lib/adfmfm`'s track encoder (new: `mfm_encode_track()` in `mfm.c`). Constants are the
   encoder spec's: 101,344 bits per track, 1,088 MFM bytes per sector, gaps as encoded by the
   server.
3. **Apply.** Write the track into the **active** PSRAM slot and mark it dirty
   (`psram_image_mark_dirty`). If the head is still on that track, the new track must be served from
   the next revolution. **This is new behaviour:** today the streamer reloads only when the
   head moves, so applying a write must also re-trigger `start_streaming` for the current
   track.
4. **WPROT** then follows only the server's per-disk flag
   (`!mounted || c.mounted_write_protected`). Every disk still defaults to write-protected in
   the database.

Without `WF_WRITE_BACK`, behaviour is exactly as today: WPROT is always asserted.

**Piece 1 is shippable alone** behind the flag: writes survive until eject, then are lost. The
flag is removed in piece 2.

**Done when:**
- The C encoder reproduces the golden tracks byte for byte (host).
- A capture fixture → decode → re-encode → PSRAM round trip is lossless (host).
- On hardware: `Copy` a file to DF0, then `dir` and `type` of the file both work, served from
  the board.

## 3. Piece 2 — upload, sessions and server history

### 3.1 Board: the uploader

Core1's poll loop gains an uploader beside `dc_step()`. For each dirty track, in track order,
with one request in flight at a time:

1. Clear the track's dirty flag, **then** read it from PSRAM. A write that lands mid-upload
   marks it dirty again, and it is re-sent.
2. Decode the track to 5,632 bytes. If the sector checksums fail (the read overlapped core0
   rewriting it), put the dirty flag back and retry. Never send a damaged track.
3. `POST /api/device/write?disk=<diskId>&mount=<mountedVersion>&track=<0-159>&seq=<n>`, with
   the body `application/octet-stream` of exactly 5,632 bytes. `seq` starts at 1 per mount and
   increments per upload.

**Closing the session.** When no write has been captured for 3 s and nothing is dirty:
- The board decodes all 160 tracks from PSRAM and computes the sha-256 of the 901,120-byte
  image.
- It sends `POST /api/device/write/close?disk=..&mount=..&seq=<last>&sha256=<its hash>`.
- On a 200, the response carries the new digest, and the board sets `mounted_sha256` to it.
  **There is no re-fetch:** the board already holds those bytes. This keeps later polls (a
  flag flip, a reboot) recognising the disk as current.

**Eject and swap (D7).** When the poll asks for a different disk, or for none, the board first
drains dirty tracks and closes the session. Only then does it transition. While offline it keeps
the current disk mounted, and the requested change waits.

Failures back off using the existing `dc_backoff` capped exponential with jitter.

### 3.2 Board: the cloud icon (D8)

Shown only when the mounted disk is **writable**. On a write-protected disk the padlock already
occupies that spot, and it explains why there is nothing to sync. Three states, all drawn, in one
footprint so that neighbouring text never shifts:

| State | Glyph | Meaning |
|---|---|---|
| synced | plain cloud | nothing unsent; safe to power off |
| pending | cloud + up-arrow | from the first unsent write until the close is acknowledged |
| offline with pending | cloud + strike | writes exist only on the board; do not power off |

The state is a pure function of (writable, dirty-or-open-session, online), host-tested in
`display.c`'s suite. The test asserts that **all three states light pixels and that all three
differ.** That is the rule from the "show both values of a state" lesson: a test that only
checks one state passes a broken icon.

**Unverified assumption:** the board takes its 5 V from the Amiga's floppy connector, so
switching the Amiga off also switches the board off. If so, the cloud answers "can I switch the
Amiga off?". If the board has its own supply, it answers "can I unplug the board?". Confirm on
the bench.

### 3.3 Server: the write API

Both endpoints use device bearer auth (`requireDevice`); an unknown or cross-org token gets 404.

`POST /api/device/write`:
- **409 `not_mounted`** unless `devices.mountedDiskId = disk` and
  `devices.mountedVersion = mount`.
- **409 `write_protected`** if the disk's `write_protected` is true. The board re-asserts WPROT
  and logs it.
- **Idempotent** on `(device, mount, seq)`: a `seq` at or below the last one applied returns 200
  and changes nothing.
- Otherwise the server diffs the 11 sectors against the **current** version (the head blob plus
  staged sectors) and stages only the sectors that differ.

`POST /api/device/write/close`:
- The server builds the new image (the head plus staged sectors) and hashes it.
- **If the hash matches the board's:**
  - It stores a blob via `diskStore` (for a new digest) and an entitlement row for the disk's
    org.
  - It creates a `disk_versions` row and moves the staged sectors into `disk_version_sectors`.
  - It repoints `disks.sha256`, `devices.mountedSha256` and `devices.desiredSha256`, all in one
    transaction. It does **not** bump `desiredVersion`.
  - It returns `{ sha256 }`.
- **If the hashes differ:** the server's image wins. It logs the mismatch with both digests to
  `devices.lastError`, commits the version anyway, bumps `desiredVersion` so the board
  re-downloads, and returns 409 `mismatch`.
- A close with nothing staged is a no-op that returns the current digest.

### 3.4 Server: storage

```
disk_versions
  id            text pk
  disk_id       text  -> disks.id (cascade)
  org_id        text
  seq           integer          -- 1, 2, 3 ... per disk
  parent_sha256 text             -- the image this version was applied to
  sha256        text             -- the image it produced
  source        text             -- 'amiga' | 'browser' | 'rewind'
  device_id     text null        -- for 'amiga'
  user_id       text null        -- for 'browser' / 'rewind'
  rewind_of     text null        -- the version restored, for 'rewind'
  sector_count  integer
  created_at    timestamptz
  unique (disk_id, seq)

disk_version_sectors
  version_id text -> disk_versions.id (cascade)
  sector     integer   -- 0..1759 (track * 11 + sector)
  data       bytea     -- 512 bytes
  primary key (version_id, sector)

disk_write_sessions                -- one open session per (device, mount)
  device_id  text
  mount      integer
  disk_id    text
  last_seq   integer             -- the idempotence key's high-water mark
  opened_at  timestamptz
  primary key (device_id, mount)

disk_write_staging                 -- sectors that differ from the head, not yet a version
  device_id  text
  mount      integer
  sector     integer
  data       bytea
  primary key (device_id, mount, sector)   -- a later upload of a sector replaces it
```

- **The original image stays shared (dedupe).** The first version's `parent_sha256` is the
  disk's original digest, and that blob remains the shared, cross-tenant one. Written images are
  new blobs.
- **Building an image** (`materialise(diskId, versionSeq)`): start from the disk's original
  image, then apply the sectors of versions 1…n in order. Pure and host-testable. Cached
  in-process by `(disk, seq)`.
- **Old versions' blobs are only a cache.** Every version can be rebuilt, so deleting a
  non-head version's blob loses nothing. Wiring this into blob GC is out of scope here.
- **Disk identity is untouched.** `games`, the TOSEC match and titles stay attached to the disk.
  A written disk's new digest has no match, and it must **not** be reported as a new
  unrecognised disk. The sweeper and the `/admin/scan` coverage rate must skip blobs that
  are head images of written disks (the same rule as for user-authored disks, HANDOFF §3q).
- `mergeDuplicates` must learn `disk_versions` as a holder of a disk. The rule since
  collections: anything new that references a game or disk id belongs in its statement list.

### 3.5 Browser edits and live write-protect

- **Browser edits join the history.** `applyDiskEdit` (`src/lib/disk-write.ts`) diffs the old
  and new images sector by sector and records a `browser` version in the same transaction as
  the repoint. The existing refusal to edit a mounted disk (D-W-4) stays, so the board and the
  browser never write one disk concurrently.
- **Write-protect applies live.** `PATCH /api/disks/[id]` with `writeProtected` bumps
  `desiredVersion` for every device whose `desiredDiskId` is that disk. The digest is unchanged,
  so the board takes the no-op path and applies the flag to WPROT. HANDOFF's entry on this is
  corrected to match.

**Piece 2 is done when:**
- The host, vitest and e2e suites below are green.
- The whole of §6's hardware acceptance passes, with `WF_WRITE_BACK` removed and write-back on
  in the normal build.

## 4. Piece 3 — the time machine UI

A **History** panel on the disk page lists versions newest first. Each entry shows:
- when it happened;
- its source ("Amiga: *board name*", "Edited in browser", "Restored to version N");
- **what changed as files**: added, changed or removed, from comparing the two versions' trees
  with `src/lib/adffs`'s reader. A disk with no readable filesystem falls back to
  "N sectors on tracks …".

Each version has two actions:
- **Browse:** the existing file browser, read-only, on the materialised version.
- **Restore:** creates a `rewind` version whose sectors turn the current image into the target
  one, repoints, and bumps `desiredVersion`. **Refused while the disk is mounted or desired by a
  device**, with an "Eject to restore" button beside the refusal.

A scrubber-style control is deferred until the list has been used.

## 5. Error handling, summarised

| Where | Failure | Behaviour |
|---|---|---|
| board | partial or corrupt capture | rejected, logged, stored copy unchanged (D5) |
| board | upload read overlaps a rewrite | checksum fails → dirty flag restored → retried |
| board | offline | writes queue in PSRAM; struck cloud shown; eject waits (D3, D7) |
| board | 409 `write_protected` | WPROT re-asserted, logged |
| board | 409 `not_mounted` | logged; the dirty set is kept and the next poll reconciles |
| board | loses power with unsent writes | those writes are lost (accepted, D3) |
| server | repeated `seq` | 200, no change |
| server | close hash mismatch | server image wins, logged, board re-downloads |
| server | restore or edit of a mounted disk | refused, with an eject offered |

## 6. Testing

- **Host (C):**
  - `mfm_encode_track` against the golden tracks, byte for byte.
  - capture → decode → re-encode → decode round trip, including the bit-shifted and
    truncated-end capture shapes already in `test_flux_bits.c`.
  - The uploader state machine against `transport_fake`: seq numbering, the 3 s close,
    flush-before-eject, offline hold, retry after a 5xx, re-assert WPROT on 409.
  - The three cloud states.
- **Server (vitest):**
  - `materialise`, the sector diff, and rewind producing exactly the target image.
  - Repeated uploads are no-ops; the hash mismatch path; staging isolation per (device, mount).
- **e2e:**
  - Drive the device write API with a real device token: upload, close, then
    `/api/device/image/<new sha>` serves the new image.
  - The History panel lists the version; Restore works and is refused while mounted.
  - The live write-protect bump.
- **Hardware acceptance (piece 2):**
  1. `Copy` a file to DF0; the cloud goes pending, then synced.
  2. Eject and remount: the file is present.
  3. Power-cycle the board: the file is present.
  4. Restore the previous version: the file is gone.
  5. The same save with Wi-Fi off: the struck cloud shows; after reconnect, everything uploads
     and the file is present on the server.

## 7. Delivery

Three plans, each ending in something usable:

1. **Board applies writes:** §2. Behind `WF_WRITE_BACK`.
2. **Upload, sessions, server history, live write-protect, cloud icon:** §3. Removes the flag.
3. **Time machine UI:** §4.

## 8. Out of scope

- Writing to a DF1 role (the board is DF0 only, HANDOFF §4e).
- Formatting and HD disks: a full-disk write is expected to work through the same path, but it
  is not an acceptance criterion here.
- Blob GC of non-head version blobs.
- A scrubber UI.
- Sharing one disk's history across orgs. History belongs to the org's disk row.
