# PaulaNET LZ4 -- design (2026-10-18)

Status: design agreed with the operator in chat 2026-10-18; this spec awaits review.

## 1. Goal and decisions

Make PaulaNET faster for compressible data by sending LZ4 instead of today's per-frame encodings, in our own
variant of Rob Smith's PaulaNET.device and in the board's firmware (1.16.0), without breaking Rob's stock driver.

Operator decisions (verbatim intent):
- Board -> Amiga: LZ4 on every 68k CPU. Amiga -> board: LZ4 only on a 68020 or faster; RLE below (2026-10-12/17).
- Our own driver variant ships on the driver disk until Rob merges (2026-10-17).
- Two pull requests to github.com/RobSmithDev/PaulaNET: (1) the RLE->MFM fix alone, (2) LZ4 with a table stating per
  CPU type which directions use LZ4. Rob decides; the operator sees both before they are opened (2026-10-17).
- Our own MIT 68000 assembly for LZ4 (feat/lz4-68k), no third-party 68k code (2026-10-13).
- "Check binaries and text files, to see if lz4 does its job" (2026-10-18).
- Bench: A500 (68000) for the board -> Amiga path; the A4000D (68030) for both directions (2026-10-18).

Success: on the A500, text and ADF transfers measurably faster than today's baseline (880 KB ADF in ~130 s,
HANDOFF 3bv); on the A4000D, uploads from the Amiga use LZ4 and arrive intact; Rob's stock driver still works
against firmware 1.16.0 exactly as with 1.15.0; already-compressed files are never slower than today.

## 2. Wire format

Today (Rob's protocol, 0afd5fa; c49bccc): each frame carries a 16-bit size word.
- Board -> Amiga: bit 15 = MFM-encoded payload (what 1.15.0 always sends), clear = raw RLE (never sent since c49bccc,
  it breaks reads). Rob's driver takes the length as `size & 0x7FFF`.
- Amiga -> board: bit 15 = RLE (sent when cylinder-76 `flags` bit 1 is set), clear = MFM.

New, only between parties that both advertised LZ4 (section 3):
- **Bit 14 (`0x4000`) = LZ4 block.** Bits 0-13 are the LZ4 block's length in bytes (max 16,383).
- Board -> Amiga an LZ4 frame is `0xC000 | lz4_len`: the LZ4 bytes are MFM-encoded on the wire (2 x lz4_len),
  exactly as plain frames are, because raw bytes toward the Amiga break its reads (HANDOFF 3bu).
- Amiga -> board an LZ4 frame is `0x4000 | lz4_len`, the LZ4 bytes sent as the driver sends RLE today (raw).
  If the bench shows raw LZ4 upstream misreads the way raw RLE did downstream, the driver MFM-wraps it as `0xC000`
  instead; the board accepts both forms from day one.
- Standard LZ4 block format (lz4 1.9 `LZ4_compress_default` compatible, little-endian offsets). No LZ4 frame
  header, no content checksum: the batch checksum already covers the bytes.
- **Linked within a batch:** a frame's LZ4 matches may reach back into earlier frames *of the same batch* (decoded
  output laid out in one window, every frame at an even offset: after an odd-length frame both sides lay one zero
  pad byte, which is never transmitted, counts toward the 16,128-byte window and its fit checks, and is written as 0
  every batch, since a match may cover it). Never across batches, so a lost batch never poisons the next one.
- **Choice per frame:** the encoder uses LZ4 only when the LZ4 block is smaller than the frame's current encoding
  (board -> Amiga: the raw length, both then MFM-doubled; Amiga -> board: the RLE length). Otherwise the frame goes
  out exactly as today. Incompressible data is never larger or slower than today.

## 3. Capability exchange

- **Board -> driver:** cylinder-76 LiveStatus byte at offset 155 (`reserved`, always 0 today; Rob's Config tool
  never writes it): bit 0 = "the board sends LZ4 to a driver that asks", bit 1 = "the board accepts LZ4 frames".
  Firmware 1.16.0 sets both.
- **Driver -> board:** our driver sets bit `0x10` in `DataHeader.compressed` on every batch it writes, meaning "I
  decode LZ4". The board sends LZ4 only while the most recent batch from the Amiga carried `0x10`; a driver
  restart or a swap back to Rob's driver (no `0x10`) returns the board to MFM-only on the next batch.
- **Driver upload gate:** the driver reads `SysBase->AttnFlags` at open. With `AFF_68020` (or better) and status
  bit 1 set, it sends LZ4 frames; otherwise RLE/MFM exactly as Rob's driver. This is the per-CPU table:

  | CPU | board -> Amiga | Amiga -> board |
  |---|---|---|
  | 68000 / 68010 | LZ4 | RLE |
  | 68020 / 68030 / 68040 / 68060 | LZ4 | LZ4 |
  | Rob's stock driver (any CPU) | MFM | RLE |

## 4. The driver variant

- Source: Rob's PaulaNET at the pinned commit 0afd5fa (redistribution granted 2026-10-12, PERMISSION.md), plus
  our patch, committed under `third-party/paulanet/src/` (Rob's files unchanged) and `tools/paulanet-driver/`
  (patch, build script, pinned toolchain image, expected sha256). The LZ4 code is `m68k/lz4/` from feat/lz4-68k
  (MIT, ours), merged to master with this work.
- Changes, all in `NetDevice/paulanetio.c` and `device.c` plus the LZ4 module:
  - decode `0xC000|len` frames: MFM-decode into a scratch area, then `lz4_decode` into the batch's output with the
    window starting at the batch's first decoded byte (linked mode);
  - encode on 68020+: `lz4_encode_linked` per frame against the batch's earlier frames, table of 1,024 entries
    (4,096 on 68040+), falling back to RLE when not smaller;
  - set `0x10` in `compressed`; read status byte 155;
  - version string `PaulaNET.device <Rob's version>-webadf-lz4`.
- Buffers: a decoded batch is at most 16,128 B and must sit back to back for linked decoding; the variant
  allocates its own decode area rather than resizing Rob's `compressionSpace`.
- Build: the pinned `stefanreinauer/amiga-gcc` image already used by `tools/receive/build.sh`, `-m68000`, so one
  binary runs on every CPU (the 68020 path is chosen at run time). The build is reproducible and checked against a
  committed sha256, like Receive.
- The driver disk (`tools/paulanet-disk/build.sh`) carries the variant instead of Rob's binary; ReadMe names it and
  credits Rob. New disk pin; the current disk becomes `PAULANET_DISK_PREVIOUS` (rollout rule unchanged: never
  swapped under a running driver).

## 5. Firmware 1.16.0

- `pnet_lz4.c/.h`: a C LZ4 block encoder (linked, hash table size a parameter) and a bounds-checked decoder,
  bit-exact with liblz4 for decoding and producing blocks liblz4 decodes. Host-tested against the reference library
  (fuzz, max sizes, incompressible input, back-references into earlier frames, malformed input never writes out of
  bounds).
- Hash table: 4,096 x 16-bit entries (8 KB) in PSRAM, not SRAM: the heap low-water already sits at the 20,480 B
  floor (HANDOFF 3bv). If PSRAM speed makes encoding too slow for a batch (measured on the board), fall back to a
  1,024-entry table in SRAM and record the ratio cost.
- Board -> Amiga packing: `pnet_link_fit` packs by the frames' actual encoded size instead of the 2x bound, so an
  LZ4 batch carries more frames (still <= 20 frames, <= 16,128 B decoded, <= the DF1 buffer on the wire).
- Amiga -> board: `pnet_link_take` accepts `0x4000` and `0xC000` frames, decoding linked within the batch.
- Status byte 155 set; the `0x10` tracking per section 3; counters in the serial `pnet:` lines (frames sent LZ4 /
  MFM, bytes saved, encode time max/avg) so the bench reads the effect directly.

## 6. Testing

- Host (CI): firmware encoder <-> driver decoder and driver encoder <-> firmware decoder, through the same C code the
  driver's asm is checked against (feat/lz4-68k's C model), plus liblz4 as the referee; linked batches; the
  frame-choice rule (never larger than today).
- Driver in the emulator (`tools/receive/uae` harness): the variant against a scripted board with LZ4 batches and
  with MFM-only batches (stock behaviour), on a 68000 and a 68030 configuration.
- Stock-driver regression: Rob's binary against firmware 1.16.0 on the A500 sends and receives as with 1.15.0.
- Bench, A500 (68000), variant driver: send an ADF, an LHA, plain text and HTML files from the web; record bytes on
  the wire (serial counters), time, and the 1.15.0/RLE baseline for each; confirm the LHA is not slower.
- Bench, A4000D (68030): the board moved to it as DF1; the same downloads, plus uploads from the Amiga (ftp or a
  copy to a network share through AmiTCP) with LZ4 counted on the board; files arrive byte-identical.

## 7. Out of scope

- Any change to Rob's protocol beyond bits 14 and `0x10` and status byte 155.
- A run-limited code denser than MFM for the board -> Amiga direction.
- Receive (it talks TCP; it gains from LZ4 transparently).
- Releasing 1.16.0: a TEST build until both benches pass; the release is a separate operator decision.
