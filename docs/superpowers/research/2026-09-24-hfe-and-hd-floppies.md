# Research: HFE support and HD (1.76 MB) Amiga floppies for webadf/wifi-floppy

Read-only research. No repo file modified, app not run, no USB touched.

---

## Part A — HFE (HxC Floppy Emulator) images, v1 and v3

### A1. Exact file layout

Source: [HxC2001 official HFE format spec](https://hxc2001.com/floppy_drive_emulator/HFE-file-format.html) (mirrors the PDF "HxC Floppy Emulator HFE File format Rev.3.1 — 05/22/2019"), cross-checked against [FlashFloppy's `src/image/hfe.c`](https://github.com/keirf/FlashFloppy/blob/master/src/image/hfe.c).

**Header (512 bytes, offset 0x000–0x1FF), identical layout for v1/v2 and v3, only the signature and `formatrevision` semantics differ:**

| Offset | Field | Size | Notes |
|---|---|---|---|
| 0x000 | signature | 8 | `"HXCPICFE"` (v1/v2) or `"HXCHFEV3"` (v3) |
| 0x008 | formatrevision | 1 | 0 = HFEv1, 1 = HFEv2; **reset to 0 for HFEv3** |
| 0x009 | number_of_track | 1 | track count |
| 0x00A | number_of_side | 1 | 1 or 2 |
| 0x00B | track_encoding | 1 | ISOIBM_MFM / AMIGA_MFM / ISOIBM_FM / EMU_FM / UNKNOWN_ENCODING |
| 0x00C | bitRate | 2 (LE) | kbit/s, max 1000 |
| 0x00E | floppyRPM | 2 (LE) | not used by the HxC emulator at replay time (informational) |
| 0x010 | floppyinterfacemode | 1 | IBMPC_DD/HD, ATARIST, AMIGA_DD/HD, GENERIC_SHUGART_DD, etc. |
| 0x011 | dnu | 1 | reserved |
| 0x012 | track_list_offset | 2 (LE) | LUT offset, in 512-byte blocks |
| 0x014 | write_allowed | 1 | 0x00 = write-protected, 0xFF = writable |
| 0x015 | single_step | 1 | 0xFF = single step, 0x00 = double step |
| 0x016 | track0s0_altencoding | 1 | 0x00 = track 0 side 0 uses an alternate encoding |
| 0x017 | track0s0_encoding | 1 | that alternate encoding |
| 0x018 | track0s1_altencoding | 1 | same for track 0 side 1 |
| 0x019 | track0s1_encoding | 1 | |

Unused header bytes are conventionally 0xFF; all multi-byte fields are little-endian.

**Track offset LUT** (up to 1024 bytes, located at `track_list_offset * 512`): one entry per track —
`{ offset: u16 LE (in 512-byte blocks), track_len: u16 LE (bitstream length in bytes) }`.

**Track data — interleaved per-side 256-byte block layout:** each track's data is stored as a
sequence of 512-byte blocks; **within each 512-byte block, the first 256 bytes are side 0's data
and the second 256 bytes are side 1's data** for that stretch of the track. Confirmed independently
in FlashFloppy's reader (`hfe.c`): it does
`memcpy(&bc_b[...], &buf[rd->cons*512 + (im->cur_track & 1) * 256], 256)`
i.e. it picks the low bit of the (cyl*2+side)-style track index to choose the first or second
256-byte half of each 512-byte block. Both sides' bitstreams thus advance together, 256 bytes
(2048 bits) at a time.

**Bit order within a byte: LSB first.** Per the spec text: "The bits transmission order to the FDC
is LSb first: Bit0 → Bit1 → … → Bit7 → (next byte)." This is the opposite of the natural
MSB-first byte order most flux/MFM tooling (and webadf's own encoder — see Part B) uses, and any
HFE writer/reader must bit-reverse accordingly.

Sources: [HxC2001 HFE spec](https://hxc2001.com/floppy_drive_emulator/HFE-file-format.html), [HFE spec PDF](https://hxc2001.com/download/floppy_drive_emulator/HxC_Floppy_Emulator_HFE_file_format.pdf), [FlashFloppy hfe.c](https://github.com/keirf/FlashFloppy/blob/master/src/image/hfe.c).

### A2. HFE v3 opcodes

The spec documents 5 opcodes, byte-aligned in the bitstream, using the canonical (spec-page)
MSB-first byte values:

| Opcode | Byte (spec page, canonical) | Meaning |
|---|---|---|
| NOP | `0xF0` | no operation / padding |
| SET INDEX | `0xF1` | emit an index pulse at this point in the stream |
| SET BITRATE | `0xF2 <rate>` | change the cell rate; the following byte gives the new rate (documented as "BB in k-samples/sec" scaling) |
| SKIP BITS | `0xF3 <n>` | skip 0–7 bits, for sub-byte bit alignment |
| RAND | `0xF4` | random/weak-bit placeholder — "side alignment helper" per the spec; used to represent unformatted/weak regions |
| (reserved) | `0xFF` | reserved |

**FlashFloppy's `hfe.c` recognizes the same 5 opcodes**, but internally works with the
LSB-first bitstream already bit-reversed into its own representation, so its source shows the
*bit-reversed* byte patterns and detects them by testing the low nibble:

```
OP_Nop     = 0x0f   // = bit-reverse(0xF0)
OP_Index   = 0x8f   // = bit-reverse(0xF1)
OP_Bitrate = 0x4f   // = bit-reverse(0xF2)
OP_SkipBits= 0xcf   // = bit-reverse(0xF3)
OP_Rand    = 0x2f   // = bit-reverse(0xF4)
```
detected via `(x & 0xf) == 0xf` — i.e. the low nibble carries the "this is an opcode" marker once
you account for the file's LSB-first bit order (0xF0's low 4 *transmission* bits are `1111`,
which land in the low nibble once re-packed MSB-first). This is a UNCONFIRMED point of exact
scaling for the SET BITRATE argument byte's units (the search summary gave "BB in
k-samples/sec" without pinning an exact formula) — verify against the PDF spec directly (§ opcode
table) before implementing a bitrate-change writer.

**FlashFloppy's actual v3 support level:** confirmed it parses all 5 opcodes for *reading/replay*
(NOP, INDEX, BITRATE, SKIPBITS, RAND). Its write-side / creation support was not directly examined
here — Greaseweazle's own HFEv3 *writer* quality is separately reported as weak (`gw convert`
maintainer: "the gw converter is not very good at converting raw dumps to HFEv3, as it gets thrown
off by the random noise and generates too many rate-change opcodes" — [Greaseweazle discussion
#468](https://github.com/keirf/greaseweazle/discussions/468)). A forum report there says a
HFEv3 image *did* work on a Gotek/FlashFloppy setup, but only after round-tripping through HxC's
own tool rather than Greaseweazle's direct SCP→HFEv3 conversion — treat FlashFloppy's real-world
v3 compatibility as UNCONFIRMED beyond "it parses the opcode set."

Sources: [HxC2001 HFE spec](https://hxc2001.com/floppy_drive_emulator/HFE-file-format.html), [FlashFloppy hfe.c](https://github.com/keirf/FlashFloppy/blob/master/src/image/hfe.c), [Greaseweazle discussion #468 "HFEv3 support"](https://github.com/keirf/greaseweazle/discussions/468), [Greaseweazle issue #532 "Convert to HFE: Weak sectors not detected"](https://github.com/keirf/greaseweazle/issues/532).

### A3. How Amiga disks are typically represented in HFE

- **Encoding value:** `AMIGA_MFM` (a distinct `track_encoding` enum value from `ISOIBM_MFM`) — the
  header also carries a separate `floppyinterfacemode` value for `AMIGA_DD`/`AMIGA_HD` (interface
  timing/wiring class), so an Amiga HFE image sets *both* the encoding and the interface mode
  fields to Amiga-flavoured values. UNCONFIRMED: the exact numeric enum values for
  `AMIGA_MFM` / `AMIGA_DD` / `AMIGA_HD` were not pinned down from the pages fetched — get them from
  `hfe_format.h` in `jfdelnero/HxCFloppyEmulator` (`libhxcfe/sources/loaders/hfe_loader/`) before
  writing an encoder against them.
- **Bitrate:** DD Amiga is 250 kbit/s (500 kbit/s **is** the transfer/flux edge rate people
  sometimes quote loosely, but the HFE `bitRate` field for standard Amiga DD is documented
  elsewhere as 250; UNCONFIRMED against the SDK's own Amiga preset — verify numerically in
  `hfe_loader` before trusting either 250 or 500). HD Amiga would double bit density at the same
  bitcell duration by halving RPM rather than doubling bitrate (see Part C).
- **RPM:** 300 for DD (standard 3.5" Amiga drive), 150 for HD — this field is explicitly flagged
  by the HxC spec as *not used by the emulator at replay time*, i.e. it's informational/for other
  tools, not authoritative for playback timing (playback timing instead follows bitrate + bit
  count per the opcode stream for v2/v3, or bitRate alone with implicit revolution length for v1).
- **Track count / sides:** 160 total tracks (80 cyl × 2 sides) same as ADF-derived images.
- **Variable/long track lengths:** the per-track LUT's `track_len` is independent per track, so
  HFE natively supports tracks of different bit lengths (long tracks) without any opcode —
  this is a **structural** feature of v1 already (the LUT alone carries it), unlike WFMF v1 which
  also supports this (see Part B) but only up to a fixed firmware ceiling.
- **Weak bits:** only representable in v2/v3 via the `RAND` opcode (a byte-aligned marker meaning
  "this region reads back different data each revolution" a real emulator can then replay
  as noise); HFE v1 has no way to encode a weak region — it can only store one fixed bit pattern.

Sources: [HxC2001 HFE spec](https://hxc2001.com/floppy_drive_emulator/HFE-file-format.html), general knowledge of the Amiga MFM format cross-checked against this repo's own `src/lib/adfmfm` measurements (Part B).

### A4. Copy protections: HFE v1 vs v3, and what a streaming emulator must do

- **HFE v1** can only preserve: (a) non-standard **sector counts/layout** and (b) **long or short
  tracks** (via the per-track LUT length), because it stores one deterministic bit pattern per
  track with no timing/weak-bit annotations. It **cannot** preserve weak bits or genuine
  variable-density (bitcell-rate-changing) protections — those need per-track re-recording of a
  single frozen bitstream, which necessarily picks one arbitrary "capture" of a weak region.
- **HFE v2/v3** add the opcode stream (`SET BITRATE` for variable density, `RAND` for weak/fuzzy
  bits, `SET INDEX` for non-standard index placement), so a v3 file *can* structurally represent
  the copy-protection classes that defeated v1 — **provided the tool that produced it actually
  used those opcodes** (many SCP→HFEv3 conversions do not, per the Greaseweazle discussion above).
- **What a streaming emulator (like wifi-floppy) must do to replay HFE v3 faithfully:**
  1. Parse the LUT and per-track opcode stream, not just raw bit data.
  2. Support **variable bitcell rate within a track** — i.e., a PIO/DMA path whose bit-clock can
     change mid-stream (today's wifi-floppy PIO has a single fixed `clkdiv` per stream, set once
     at `flux_out_program_init` — see Part B5).
  3. Support **weak bits** — i.e., actually emit non-deterministic flux for `RAND` regions (today's
     wifi-floppy plays back the exact same PSRAM bytes every revolution: fully deterministic,
     so any weak-bit check would read the same value forever and fail the protection check that
     expects randomness).
  4. Support **long/short tracks and non-standard index placement** — this part is *closer* to
     what wifi-floppy already has (per-track bit_count driving DMA wrap — Part B5), modulo the
     firmware's fixed byte ceiling (`TRACK_MAX_BYTES` = 13,312 B = 106,496 bits, vs a nominal DD
     track of 101,344 bits — about 5% of long-track headroom today, likely insufficient for some
     real long-track protections which run notably longer).

---

## Part B — the existing webadf/wifi-floppy flux pipeline (as implemented in the repo)

### B5. The WFMF container, exactly as implemented

**Container format** (`wifi-floppy/firmware/src/image_loader.h` lines 26–34, mirrored in
`src/lib/adfmfm/wfmf.ts` and documented in `wifi-floppy/README.md`):

```
u32 magic   'WFMF' (0x464D4657 LE)
u32 version (1)
u32 track_count
u32 reserved
per track, in order:
    u32 bit_count
    ceil(bit_count/8) bytes of raw MFM, padded up to a 4-byte boundary
```

- `IMAGE_MAGIC = 0x464D4657`, `IMAGE_VERSION = 1` (`image_loader.h`).
- **Per-track bit counts CAN vary** — the parser (`image_loader.c`'s `sink()`, state `S_LEN`)
  reads a fresh `u32 bits` before each track's payload; nothing forces it equal across tracks.
  In practice, today's server-side encoder (`src/lib/adfmfm/wfmf.ts::writeWfmf`) always emits the
  *same* `TRACK_BITS` (101,344) for every one of the 160 tracks — that's a choice of the current
  DD encoder, not a WFMF format constraint.
- **Byte alignment / padding:** each track's payload is padded to a 4-byte boundary
  (`(4 - (payload_bytes & 3)) & 3` bytes of padding) — `image_loader.c`'s `S_PAD` state consumes
  exactly that many pad bytes before the next track's length field. The TS writer notes it never
  actually needs to pad because `TRACK_BYTES` (12,668) is already a multiple of 4, "the reader
  still handles it" for the general case.
- **`TRACK_MAX_BYTES` = 13,312** (`psram_image.h`) — the PSRAM-slot / SRAM-staging ceiling per
  track, i.e. the hard ceiling on `bit_count` is `TRACK_MAX_BYTES * 8` = **106,496 bits**
  (`FIRMWARE_ACCEPT_TRACK_BITS` in `src/lib/adfmfm/constants.ts`). This was reconciled from two
  previously-inconsistent constants (`TRACK_SLOT_BYTES=13312` vs `TRACK_MFM_MAX=13000`) after a
  documented latent buffer-overflow bug (HANDOFF.md "Latent buffer overflow — FIXED").
- **INDEX generation:** `main.c`'s `dma_irq()` handler re-arms the DMA each time it exhausts the
  *current track's own* `track_word_count` (derived from that track's `bit_count` — see
  `start_streaming(mfm, bit_count)`, `nwords = (bit_count + 31) / 32`), and raises a ~2 ms INDEX
  pulse (`INDEX_PULSE_US`) at that wrap. **This means the per-track `bit_count` genuinely controls
  the revolution length / INDEX timing** — a longer track (up to the 106,496-bit ceiling) takes
  proportionally longer to play back and produces a proportionally later INDEX. This is the
  mechanism by which "long tracks" (one class of copy protection) could already be represented in
  WFMF v1 today, bounded by that ~5%-over-nominal ceiling (106,496 vs nominal 101,344 bits).
- **PIO bitcell timing (`floppy.pio` / `main.c`):** `flux_out_program_init()` sets the PIO clock
  divider **once**, from `clock_get_hz(clk_sys) * 2e-6f / 8.0f` — i.e. a single, fixed **2 µs
  bitcell** for the entire stream. There is **no per-track or per-bit timing information anywhere
  in WFMF v1** — no opcode stream, no per-bit duration field, nothing. Consequently:
  - The device **cannot** replay a track whose bitcell duration differs from 2 µs (no
    variable-density support) without a firmware change to reprogram `clkdiv` mid-track and a
    format change to carry where/when to do so.
  - The device **cannot** replay genuine weak bits — playback is byte-for-byte deterministic from
    PSRAM every revolution (confirmed: `start_streaming` just DMAs the same `track_words` buffer
    on every wrap; nothing randomizes it), so a weak-bit check reading a fixed WFMF-encoded track
    would see the same bits every time, defeating the point of a weak-bit protection.
  - The device **can** already replay a track whose *length* (bit_count) differs from nominal, up
    to the ~106k-bit ceiling, at the same fixed 2 µs bitcell — i.e. "long tracks" within that
    headroom, but not "long tracks" that also change density.

Sources (local): `wifi-floppy/firmware/src/image_loader.c`, `image_loader.h`, `wifi-floppy/README.md`, `src/lib/adfmfm/constants.ts`, `src/lib/adfmfm/wfmf.ts`, `wifi-floppy/firmware/src/psram_image.h`, `wifi-floppy/firmware/src/main.c` (`start_streaming`, `dma_irq`), `wifi-floppy/firmware/src/floppy.pio` (`flux_out_program_init`).

### B6. How a disk's bytes are stored and served today — the "assumes ADF" blast radius

The disk blob store (`src/lib/storage.ts`) itself is **format-agnostic** — `diskStore` just
stores/reads/deletes bytes keyed by SHA-256 (`adf/<sha256>`), with no size assertion of its own.
The ADF-shape assumption is enforced **above** storage, in many separate places. Every file below
asserts or hardcodes the 901,120-byte DD ADF shape (`ADF_BYTES = TRACKS(160) * TRACK_DATA_BYTES
(5,632) = 901,120`, from `src/lib/adfmfm/constants.ts`) and would need a "which disk kind is this"
branch to admit HFE or HD:

| File | What it assumes |
|---|---|
| `src/lib/mount.ts` | `setDesired` refuses to mount anything whose `sizeBytes !== ADF_BYTES` — the single biggest gate; a non-ADF disk (HFE flux, or an HD image) is unmountable today |
| `src/app/api/device/image/[sha256]/route.ts` | Calls `encodeDisk(adf)` unconditionally — assumes the stored blob is a raw 901,120-byte ADF that the DD encoder can consume; comments explicitly say this path "should be unreachable" for anything else because `setDesired` already gated it |
| `src/lib/archive/disk-image.ts` (`toAdf`) | Converts `.adz`/`.dms` to a plain ADF; the whole module's contract is "the library stores one thing: a 901,120-byte ADF" |
| `src/lib/archive/dms.ts` | Hardcodes `ADF_BYTES = 901120` and rejects any `.dms` that doesn't decode to exactly that many bytes |
| `src/lib/adffs/constants.ts` / `src/lib/adffs/index.ts` | `BLOCK_COUNT = 1760` (880 KB / 512), `ROOT_BLOCK = 880` fixed (not derived from disk size); `index.ts` returns `{ ok: false, reason: 'not-adf' }` for anything whose length isn't exactly `ADF_BYTES` — the whole filesystem browser (`src/lib/adffs`) assumes an 880 KB DD volume shape |
| `src/lib/adfmfm/adf.ts` (`assertAdf`) | Rejects/pads only around the DD `ADF_BYTES` size |
| `src/lib/adfmfm/index.ts`, `constants.ts` | `encodeDisk`/`decodeDisk` and every encoder constant (`SECTORS=11`, `TRACK_BITS=101344`, gap sizes) are DD-only; HD needs a parallel constant set (`SECTORS=22`, different `TRACK_BITS`, verified independently — see Part C) |
| `src/lib/disk-history/{history,delta,chain,version}.ts` | All assert `image.length === ADF_BYTES`; `delta.ts`'s `SECTORS_PER_DISK = ADF_BYTES / SECTOR_BYTES` (1760) and its snapshot-vs-delta threshold math are DD-sized |
| `src/lib/blob-upload.ts` (`MAX_DISK_BYTES`) | Already anticipates **both** sizes: comment says "An uncompressed Amiga DD floppy is 901,120 bytes and an HD one is 1,802,240; 2 MiB covers both" — the ceiling constant is HD-ready, but nothing downstream of it is |
| `src/lib/ingest.ts` | Presign/upload body-size gate reuses `MAX_DISK_BYTES`, so it wouldn't reject an HD-sized *upload*, but everything after ingest (mount, encode, browse) still would |
| TOSEC/identify pipeline (`src/lib/tosec.ts`, `tosec-dat.ts`, `tosec-sweep.ts`, `tosec-import.ts`, `tosec-apply.ts`, `content-hashes.ts`) | Not directly examined byte-for-byte in this pass, but TOSEC dat entries and CRC/size matching for the Amiga DD archive are built around 901,120-byte images; an HD or HFE disk would not match any TOSEC DD entry by construction (different bytes/size), so identification would need its own path or would simply report "unidentified" — treat the exact mechanics here as **UNCONFIRMED**, worth a follow-up pass focused on `tosec.ts` before implementation |

**Net:** the blast radius of adding a non-ADF disk kind (HD-as-ADF, or HFE-as-flux) is large but
mostly mechanical — `storage.ts` needs no change, but `mount.ts`'s single size gate, the whole of
`src/lib/adffs` (assumes 880 KB DD block geometry), the whole of `src/lib/adfmfm` (DD-only MFM
constants), `disk-history`'s four modules, and the device-image route all encode "disk == exactly
901,120 bytes" as a load-bearing assumption. HANDOFF.md's own HD section (see below) already
identifies most of this list independently and reaches the same conclusion: "The 901,120-byte
checks... become 'one of two valid sizes'."

---

## Part C — HD (1.76 MB) Amiga floppies

### C7. Amiga HD geometry and timing — verifying the HANDOFF claim

**HANDOFF.md's claim** (line ~2078): "an Amiga HD disk is 22 sectors per track against DD's 11,
and the drive spins at 150 rpm rather than 300, so the SAME 2 µs bitcells and the same
500 kbit/s cover a revolution twice as long," with an explicit self-correction rejecting an
earlier "1 µs bitcell" claim as self-contradictory (1 µs would be 1 Mbit/s, "which Paula cannot
take").

**Verification:**
- Greaseweazle's own Amiga disk definitions (`diskdefs_amiga.cfg`,
  [keirf/greaseweazle](https://github.com/keirf/greaseweazle/blob/master/src/greaseweazle/data/diskdefs_amiga.cfg))
  define:
  ```
  disk amigados
      cyls = 80
      heads = 2
      tracks * amiga.amigados
          secs = 11
      end
  end

  disk amigados_hd
      cyls = 80
      heads = 2
      tracks * amiga.amigados
          secs = 22
      end
  end
  ```
  i.e. **HD differs from DD only in `secs = 22` vs `secs = 11`**, inheriting the *same*
  `amiga.amigados` track/bitcell template for both — Greaseweazle does not encode a separate
  bitrate for the HD variant, consistent with HANDOFF's "same bitcell rate" claim, since the
  format-level definition has nothing HD-specific to change (RPM is a property of the physical
  drive spinning the disk, not of the track's bit encoding). I could **not** fetch the base
  `track amiga.amigados` template's own `rate=`/`rpm=` line through the tools available in this
  session (GitHub's rendered/raw views were not extractable beyond the top-level disk stanzas), so
  the *exact* numeric rate line as GW writes it is **UNCONFIRMED** — but the structural fact that
  HD reuses the DD track template unmodified except for `secs` independently corroborates
  HANDOFF's "same 2 µs bitcell" claim rather than contradicting it.
- Standard Amiga DD 500 kbit/s and 2 µs (2,000 ns) bitcell is well-established (and independently
  confirmed inside this repo: `src/lib/adfmfm/constants.ts` derives `TRACK_BITS` from "14 PAL
  colour clocks per bitcell (7,093,790 Hz)", and HANDOFF.md's own defect log states
  `BITCELL_NS` = 2,000 ns vs "a true Amiga bitcell of 1,973.6 ns" — i.e. this repo's own
  measured/verified DD bitcell is ~2 µs, matching Paula's 500 kbit/s MFM rate). HD, at 150 rpm
  (half of DD's 300 rpm) and the same bitcell duration, therefore fits **twice as many bits** in
  one (now twice-as-long) revolution — this is arithmetically consistent (double the sectors, same
  bits/sector layout, same bit rate, half the rpm ⇒ same bits/mm on the media, same "500 kbit/s"
  data rate delivered to Paula) — self-consistent with HANDOFF's claim and with `MAX_DISK_BYTES`'s
  comment elsewhere in the repo giving HD as exactly `1,802,240` bytes
  (= 22 × 512 × 160 = 1,802,240, i.e. 1.76 MiB in the conventional-for-floppies "1 MB = 1000×1024
  bytes" marketing sense).
- **MFM bytes per track / gap sizes for HD:** HANDOFF.md itself only ballparks this — "160 tracks
  x ~25,000 bytes is ~4.0 MB per image" for an HD *flux* image (i.e. ~25 KB/track vs DD's measured
  12,668 bytes/track, roughly double as expected for 22 vs 11 sectors) — and flags explicitly that
  `SECTORS`, `TRACK_BITS`, and the gap constants "all assume DD... the HD set needs verifying the
  same way [as DD, i.e. against Greaseweazle byte-diff] rather than derived by doubling." **This
  remains UNCONFIRMED / not yet measured** — no HD-specific `adfmfm` constants exist in the repo
  today (confirmed by reading `src/lib/adfmfm/constants.ts` in full — only DD constants are
  defined), and the adfmfm README explicitly states "No write-back, and no HD (22-sector)
  support."

Sources: [Greaseweazle `diskdefs_amiga.cfg`](https://github.com/keirf/greaseweazle/blob/master/src/greaseweazle/data/diskdefs_amiga.cfg); local: `HANDOFF.md` (lines ~2075–2143, ~4914), `src/lib/adfmfm/constants.ts`, `src/lib/blob-upload.ts`, `src/lib/adfmfm/README.md`.

### C8. How an Amiga identifies an HD drive; Kickstart support

- **Drive-ID protocol:** with the drive selected (`/SEL`) and the **motor held off**, the Amiga
  clocks a 32-bit ID serially out of `/RDY` — pull `/SELx` low, sample `/RDY`, raise `/SELx`
  again, 32 times, MSB first. Confirmed by two independent sources:
  - [`keirf/amiga-stuff` issue #58 "Incorrect floppy drive IDs"](https://github.com/keirf/amiga-stuff/issues/58),
    which gives the canonical ID table from the Amiga Hardware Reference Manual and documents two
    real ATK-tool bugs (a shift-by-one that reported HD drives as `0x55555555` instead of
    `0xAAAAAAAA`, and a later bit-inversion regression) — i.e. this exact area is one where
    real-world implementations have historically gotten the bit order/polarity wrong, which is
    itself a useful risk flag for this repo's own future implementation.
  - Local repo's own `wifi-floppy/firmware/src/dskchg.c` comment, independently: "the Amiga
    clocks a 32-bit ID off /RDY... 33 selects in ~141 µs, each held 1–4 µs" (measured on real
    hardware 2026-09-15, per HANDOFF §4d).
- **The 4 canonical ID values** (Amiga Hardware Reference Manual, via the amiga-stuff issue):

  | ID | Meaning |
  |---|---|
  | `0x00000000` | no drive present (all-low: `/RDY` never asserted) |
  | `0xFFFFFFFF` | standard Amiga 3.5" DD drive |
  | `0xAAAAAAAA` | 3.5" **HD** drive |
  | `0x55555555` | 5.25" drive |

  This **confirms** the operator's HANDOFF note ("DD and HD drives answer with different
  patterns") and specifically confirms `0xAAAAAAAA` as the HD pattern (not `0xFFFFFFFF`, which is
  DD) — matching what the task description asked to verify.
- **How Gotek/FlashFloppy reports HD for Amiga:** **UNCONFIRMED** in this pass — I did not find
  and read FlashFloppy's own drive-ID-answering code (it would live near `src/floppy.c` per this
  repo's own `dskchg.c` comment pointing at FlashFloppy as its behavioural model); this is worth a
  direct follow-up read of FlashFloppy's Amiga-interface source before implementing an HD ID
  answer.
- **Kickstart version for HD support:** WebSearch did not surface an authoritative primary-source
  page pinning "3.0" as the exact version where `trackdisk.device` gained native HD support (the
  `amigadev.elowar.com` Hardware Reference Manual mirror returned an expired-TLS error and could
  not be fetched in this session). What was found: a documented third-party "TrackdiskHD" patch
  exists specifically because **Kickstart 1.3's** `trackdisk.device` did **not** natively support
  HD (it needed patching to read/write both DD and HD-formatted disks), which is consistent with —
  but does not by itself prove — the operator's belief that native support arrived at 3.0. **Mark
  the "Kickstart 3.0+" claim as UNCONFIRMED from this pass**; it is plausible and consistent with
  everything found, but not independently pinned to a primary source here. Recommend either a
  targeted re-fetch of the AmigaOS/trackdisk documentation wiki
  ([wiki.amigaos.net/wiki/Trackdisk_Device](https://wiki.amigaos.net/wiki/Trackdisk_Device), which
  a search returned but was not fetched in this pass) or accepting the operator's existing ruling
  (HANDOFF.md already logs this as "OPERATOR RULING 2026-09-14: HD requires Kickstart 3.0 or
  later" — i.e. it's a decision already made, not an open question, unless new evidence overturns
  it).

Sources: [`keirf/amiga-stuff` issue #58](https://github.com/keirf/amiga-stuff/issues/58); local `wifi-floppy/firmware/src/dskchg.c`; local `HANDOFF.md`.

### C9. Does the existing firmware already answer the drive ID?

**No.** `grep -n "drive.?id"` across `wifi-floppy/firmware/src` finds exactly one hit, and it is a
comment explaining that the ID answer was **deliberately removed**:

> `wifi-floppy/firmware/src/dskchg.c`, lines 16–22:
> "NO AMIGA DRIVE-ID ANSWER, deliberately. This file used to clock ID_3_5_DD out on /RDY from the
> SEL0 interrupt, on the assumption that DF0's ID is ignored. Measured 2026-09-15 (HANDOFF §4d):
> Kickstart reads DF0's ID at power-on — 33 selects in ~141 us, each held 1-4 us — the interrupt
> caught 0 of them, and the Amiga then never selected DF0 again. With no ID answer, /RDY released
> through the read, it boots, reads and writes. Answering it would need something as fast as the
> select; nothing measured needs it."

So today the board answers **nothing** on the ID shift (relies on the Amiga tolerating a
missing/timed-out ID read and proceeding to treat DF0 as present anyway, which was measured to
work for plain DD operation). **Where an HD ID would have to be produced:** the same place the old,
removed code lived — a handler fast enough to catch a `/SEL0` interrupt within the 1–4 µs window
each of the 32 pulses holds, which the firmware's own measurement says a normal GPIO interrupt
(latency observed elsewhere in this codebase to be tens of µs, e.g. the DIR-sampling defect fixed
via a dedicated `step_dir` PIO program) **cannot** meet — this almost certainly needs a dedicated
PIO state machine (mirroring how `step_dir`/`sel_mtr`/`status_gate` already offload other
sub-microsecond-timing bus behaviours to PIO in `floppy.pio`), not a C-level GPIO ISR. This is
architecturally the same class of problem `floppy.pio`'s existing state machines already solve,
which is a strong hint for where the implementation should live, but no such PIO program exists
yet for drive-ID answering.

Source (local): `wifi-floppy/firmware/src/dskchg.c` (comment block), `wifi-floppy/firmware/src/floppy.pio`.

### C10. Rough CPU cost of encoding one HD track (22 sectors) on RP2350 @ 150 MHz — ESTIMATE ONLY, NOT MEASURED

Reasoning, bottom-up, using this repo's own measured DD numbers as the baseline:

- One HD track's MFM output is ~25,000 bytes (HANDOFF's own estimate, doubling DD's measured
  12,668 bytes for 22 vs 11 sectors — internally consistent with the geometry in Part C7).
- The encode work per output byte, per this repo's own `src/lib/adfmfm` design notes and the
  mutation-matrix description in its README, is roughly: (a) an odd/even bit split per 32-bit
  field, (b) MFM clock-bit insertion (`fillClockBits`, a small per-bit/per-byte state machine that
  looks at the previous bit), and (c) a per-sector (not per-byte) XOR-fold checksum over the raw
  pre-split bytes. (a) and (b) are the dominant O(bytes) costs; (c) is O(bytes) too but only run
  once per sector's header+data, so it's the same order of magnitude, not an added multiplier.
- Treating (a)+(b)+(c) together as roughly **20–30 simple integer/bit instructions per output
  byte** (generous, unoptimized-C estimate — a table-driven clock-bit fill or SIMD-style
  word-at-a-time approach could easily beat this by 5–10×, but the goal here is an upper-bound
  order of magnitude, not a best case):
  - 25,000 bytes × ~25 instructions/byte ≈ **625,000 instructions**.
  - RP2350's Cortex-M33 at 150 MHz, treated as roughly 1 instruction/cycle for this kind of
    integer/bit-twiddling code (optimistic — some instructions are multi-cycle, but M33 is
    single-issue so this is a reasonable rough ceiling, not a floor):
    625,000 cycles / 150,000,000 Hz ≈ **~4 ms**.
- **Order of magnitude: low single-digit milliseconds per HD track (~1–10 ms), clearly labelled as
  an unmeasured estimate.** This is squarely in the danger zone HANDOFF.md itself already flags:
  "Core0 answers a seek in 1 ms median against ~15 ms of head settle... encoding 22 sectors
  (checksums plus odd/even split) has to fit inside that margin, or be done ahead of the seek." A
  ~4 ms estimate would consume roughly a quarter to a third of that 15 ms settle budget if done
  synchronously on seek — plausible but tight, and the actual number could easily be 2–3× higher
  or lower depending on how the C port is written (unrolled tables vs a naive bit loop). **This
  must be measured on real hardware (or at minimum cycle-counted on the target toolchain) before
  any HD-as-ADF-with-on-device-encoding design is finalized** — it is not something this research
  pass can responsibly pin down further without instrumented code to run.

---

## Open questions / risks

1. **HFE v3 opcode encoding for a webadf *encoder* (not just a decoder)** — the exact SET BITRATE
   argument-byte scaling, and the precise numeric `track_encoding`/`floppyinterfacemode` enum
   values for `AMIGA_MFM`/`AMIGA_DD`/`AMIGA_HD`, need pulling from `hfe_format.h` in
   `jfdelnero/HxCFloppyEmulator` directly (not reachable as clean structured text through the
   tools available this session) before any encoder is written.
2. **WFMF's current design cannot carry HFE's most valuable v3 features (weak bits, variable
   density) without a real format + firmware change** — playback today is fully deterministic
   (same PSRAM bytes every revolution) and single-bitcell-rate for the whole stream. Serving an
   HFE-derived image as WFMF v1 today would silently drop weak-bit and variable-density
   protections even though the *source* HFE file preserved them — this is a real risk for the
   "which copy protections survive" framing of the feature, not just a nice-to-have.
3. **"Long tracks" partially already work** — WFMF v1's per-track `bit_count` already drives DMA
   wrap/INDEX timing, giving ~5% headroom over nominal (106,496 vs 101,344 bits) at the fixed 2 µs
   bitcell — worth confirming whether that headroom is enough for real long-track protections
   before assuming a firmware change is required for that specific class.
4. **HD's Kickstart-3.0-requirement and FlashFloppy's HD-ID-answering approach are both
   UNCONFIRMED from primary sources in this pass** (network access to the Hardware Reference
   Manual mirror failed; FlashFloppy's own Amiga-ID-answering source was not read). Both are
   currently resting on the operator's own prior ruling (HANDOFF.md) plus indirect corroboration,
   not a freshly-verified primary source — worth a short follow-up fetch before either is treated
   as settled for a spec.
5. **Answering an HD drive ID needs PIO-level timing**, not a GPIO interrupt — the firmware
   already removed a GPIO-interrupt-based ID answer for being too slow (HANDOFF §4d measurement:
   0 of 33 selects caught), and general GPIO-ISR latency problems are a repeat theme in this
   codebase (e.g. the DIR-sampling defect that motivated `step_dir`'s PIO program). Any HD-ID
   design should budget for a new PIO state machine from the start, not attempt a C-level ISR
   first only to hit the same wall again.
6. **The CPU-cost estimate for on-device HD encoding (Part C10) is unmeasured** and could be wrong
   by a factor of several in either direction; it is the single most decision-relevant unknown for
   the "HD images held on device as ADF, encoded on demand" design the operator already ruled
   in favour of (HANDOFF §, "OPERATOR RULING 2026-09-14").
7. **TOSEC/identify pipeline behavior for non-DD-ADF disks was not directly traced** in this pass
   (Part B6's table flags this) — a short follow-up read of `src/lib/tosec.ts` and
   `src/lib/tosec-dat.ts` would close that gap before implementation.
