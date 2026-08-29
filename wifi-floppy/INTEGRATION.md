# wifi-gotek → webadf integration brief

Context for picking this up in the webadf repo. The firmware side is written;
what's missing is the server side, which should live in webadf so the catalogue
and the emulator share one source of truth for the ADF library.

## What already exists

* `firmware/` — RP2350 firmware for a Pimoroni Pico Plus 2 W (PIM726).
  Never compiled; expect SDK API fixes on the first build.
* `hardware/` — routed 2-layer KiCad PCB, Gerber exporter, SVG renderer.
  Boards are ordered from JLCPCB.

The emulator is **not** a streaming client. The whole disk is pulled into
PSRAM in one transfer at mount, and the floppy bus is served entirely from RAM
after that. There is no code path that fetches a track mid-operation — this was
deliberate, so a WiFi hiccup can never stall the bus mid-track.

## The contract webadf has to satisfy

One endpoint, one bulk response.

    GET /image/<id>  ->  200, application/octet-stream

    u32  magic        0x464D4657  ('WFMF', little-endian)
    u32  version      1
    u32  track_count  160
    u32  reserved     0
    per track, in order (cyl*2+side, 0..159):
        u32  bit_count            MFM bits in this track (~101,600)
        u8[] payload              ceil(bit_count/8) bytes, raw MFM, MSB first
        u8[] padding              zeroes, up to a 4-byte boundary

Constraints the firmware enforces, so violating them fails the load:

* `bit_count` must not exceed `TRACK_SLOT_BYTES * 8` (13312 * 8 = 106,496).
  A real Amiga track is ~101,600 bits / ~12,700 bytes, so there is headroom,
  but an over-long track is rejected rather than truncated.
* Wrong magic or version aborts the load.
* A short or interrupted body leaves the image incomplete and no disk is
  presented — the firmware retries rather than mounting half a disk.
* Idle timeout is 4 s between TCP chunks (not a total deadline), so a slow
  link is fine but a stalled one gives up.

Reference implementation of the parser: `firmware/src/image_loader.c`. It was
tested on the host against randomly-chunked input at real track sizes.

## Server-side encoding

Encoding happens on the server, deliberately — the Pico stores pre-encoded MFM
and does no encoding work. The encoder must turn an 880 KB ADF into Amiga
track-format MFM:

* 11 sectors per track, 512 data bytes each.
* Per sector: sync (0x4489 twice), info long (format / track / sector /
  sectors-to-gap), 16-byte sector label, header checksum, data checksum,
  then 512 bytes of data.
* Amiga MFM uses odd/even bit splitting — odd bits of the block first, then
  even bits — with clock bits filled so the MFM rules hold across boundaries.
* Track gap after the last sector to pad out to the full revolution.

Validate the encoder by round-tripping: encode an ADF, decode it back, compare
byte-for-byte against the source. Checking against a known-good tool's output
for the same ADF is worth doing too — the checksum and bit-split details are
where these go wrong, and a subtly wrong encoder will look fine until the
Amiga refuses to read a disk.

## Integration decisions still open

1. **Disk identity.** `<id>` should be whatever webadf already uses to
   identify a disk (row id, content hash, path) — do not invent a parallel
   numbering scheme for the emulator.

2. **Which disk is mounted.** The firmware currently hardcodes
   `image_load(0)` in `main.c`. In a catalogue this needs a selection
   mechanism — most likely a "mount" action in the webadf UI that sets a
   current-disk pointer, with the Pico requesting that pointer at boot. If so
   the endpoint becomes something like `GET /current` (returning the id, or
   the image directly) and `main.c` changes accordingly. Decide this before
   writing the endpoint.

3. **Caching encoded images.** Encoding is deterministic, so a disk always
   yields the same ~2 MB blob. Encode on first mount and cache it beside the
   ADF keyed by the same identity; pre-encoding the whole library would
   roughly triple its size for disks that may never be mounted.

4. **Write-back.** Not implemented on either side. The firmware has the
   plumbing — PSRAM tracks carry a `TRK_DIRTY` state and
   `psram_image_next_dirty()` exists — but nothing calls it, and
   `http_post_track()` is a stub. Decide whether webadf should accept
   modified tracks at all, or whether disks stay read-only. `WPROT` is
   asserted by default in the firmware until this is settled.

## Suggested layout in webadf

Keep the emulator-facing code separate from the catalogue UI so the firmware
contract is easy to find and version:

    webadf/
      <existing catalogue app>
      adfmfm/          encoder + tests (round-trip test lives here)
      gotek/           the /image/<id> endpoint and mount-pointer logic
      firmware/        this firmware tree, moved in
      hardware/        PCB, Gerbers, generators

Moving `firmware/` and `hardware/` into the same repo is what keeps the
protocol honest: the blob format is defined in `image_loader.c` and consumed
by the encoder, and having both under one history means they cannot drift
apart silently.
