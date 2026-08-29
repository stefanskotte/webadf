# adfmfm — Amiga MFM encoder design

**Addendum to `2026-08-23-webadf-design.md`.** That spec remains the binding
authority; this one expands **D15** ("the device consumes pre-encoded Amiga MFM")
into an implementable design. The binary contract it satisfies is defined by
`wifi-floppy/firmware/src/image_loader.c` and documented in `INTEGRATION.md`.

**Scope:** the encoder, the decoder, and the container. Nothing device-facing.
`GET /api/device/image/<sha256>`, the encoded-image cache and device auth on that
route are a separate plan, deliberately — this is a pure-logic problem and mixing
it with an infrastructure one would make both harder to review.

---

## 1. Why the numbers are what they are

Every constant below was measured against Greaseweazle's `amiga.amigados` codec,
which is installed locally at `~/.local/pipx/venvs/greaseweazle/`, not taken from
documentation.

| Constant | Value | Where it comes from |
|---|---|---|
| `BITCELL_CLOCK` | `14 / 7_093_790` s ≈ 1.9736 µs | 14 PAL colour clocks per MFM bitcell. 7,093,790 Hz is the Amiga PAL colour clock. This is what Paula actually does. |
| `TRACK_BITS` | **101,344** | `floor(0.2 / BITCELL_CLOCK)` = 101,339, rounded **up to a multiple of 32**. One 200 ms revolution. |
| `TRACK_BYTES` | **12,668** | `TRACK_BITS / 8`. Already 4-byte aligned, so WFMF never emits a padding byte. |
| `SECTORS` | 11 | Amiga DD. |
| `TRACKS` | 160 | `cylinder * 2 + side`, cylinders 0–79. |
| `ADF_BYTES` | 901,120 | `160 * 11 * 512`. |
| `WFMF_BYTES` | **2,027,536** | `16 + 160 * (4 + 12,668)`. 2.25× the ADF. |

The 32-bit rounding is not cosmetic. `main.c:start_streaming()` computes
`nwords = (bit_count + 31) / 32` and the DMA re-triggers on that word count, so any
`bit_count` that is not a multiple of 32 causes the tail of the last word to be
emitted from whatever is in the SRAM buffer past the payload. At 101,344 bits the
track is exactly 3,167 words and every emitted bit is one we wrote.

### Revolution timing

The firmware clocks 2,000 ns per cell (`floppy_io.h:BITCELL_NS`), not 1,973.6. At
101,344 bits that is a 202.7 ms revolution — about 296 RPM against a nominal 300.
This is within tolerance: the Amiga locks its PLL to sync marks rather than to a
stopwatch, and real drives vary by more. It is a one-line `clkdiv` trim in
`flux_out_program_init` if it ever matters. **The encoder targets the true Amiga
bitcell, not the firmware's rounded one**, because the encoder's output is the thing
that has to match real disks.

---

## 2. Track layout

A track is 12,668 bytes:

| Region | Bytes |
|---|---|
| Post-index gap | 256 |
| 11 sectors × 1,088 | 11,968 |
| Pre-index gap | 444 |

Both gaps are zero bytes before the clock-fill pass, which turns them into `0xAA`.

### Sector — 1,088 bytes

| Field | Raw | Encoded | Note |
|---|---|---|---|
| Sync | — | 4 | `44 89 44 89`, written verbatim |
| Header | 4 | 8 | `[0xFF, trackNo, sectorId, SECTORS - positionInTrack]` |
| Label | 16 | 32 | 16 zero bytes |
| Header checksum | 4 | 8 | over `header ++ label`, big-endian u32 |
| Data checksum | 4 | 8 | over the 512 data bytes, big-endian u32 |
| Data | 512 | 1024 | |
| Trailing gap | 2 | 4 | zero bytes |

Three details are where encoders go wrong. All three are load-bearing:

1. **The odd/even split is applied per field, independently** — not once across the
   whole sector. Header, label, each checksum and the data are each split on their
   own.
2. **The header's fourth byte is `SECTORS - positionInTrack`** — sectors remaining
   to the gap, keyed off *physical position in the track*, not off `sectorId`. For
   an image written in order the two coincide, which is exactly why getting it
   wrong is invisible until it isn't.
3. **The checksum is computed over raw, pre-split bytes**, then folded.

### Sector ordering

Identity: ADF sector *n* of a track becomes `sectorId` *n* at physical position *n*.
Labels are 16 zero bytes — AmigaDOS does not use them.

---

## 3. Primitives

### Odd/even split

```
splitOddEven(v) = [ ...v.map(x => (x >> 1) & 0x55),   // odd bits first
                    ...v.map(x =>  x       & 0x55) ]  // then even
```

Each output byte carries four data bits in the `0x55` lanes and leaves the `0xAA`
lanes empty for clock bits. The split doubles the length in bytes.

### Checksum

```
c = XOR of the big-endian u32 words of the raw field
checksum = (c ^ (c >>> 1)) & 0x55555555
```

The Amiga's real definition is the XOR of the *MFM* longs — the odd halves and even
halves as stored. These are the same thing, and the proof matters because it is the
step most often fudged:

> The odd half of a raw long `v` is `(v >>> 1) & 0x55555555` and the even half is
> `v & 0x55555555`. XOR distributes over the shift, so XOR-ing both halves across
> every long gives `((XOR v) >>> 1 ^ (XOR v)) & 0x55555555`. Grouping is irrelevant
> because XOR is associative and commutative, so it does not matter that the split
> is applied per field.

The checksum covers data bits only. The resulting long is then itself split and
clock-filled like any other field.

### Clock fill

One length-preserving pass over the assembled track, in order:

```
y = 0
for each byte x:
    y = (y << 8) | x
    if (x & 0xAA) == 0:
        y |= ~((y >> 1) | (y << 1)) & 0xAAAA
    y &= 0xFF
    emit y
```

This sets a clock bit exactly where neither the preceding nor the following data bit
is set, which is the MFM rule, and it carries correctly across byte boundaries via
the 16-bit window.

**The sync bytes need no special case.** `0x89 & 0xAA` is non-zero so `0x89` is
skipped outright; `0x44` is processed, but its neighbours already supply every
transition, so the fill is a no-op and `44 89 44 89` survives intact. Verified by
hand and confirmed against the reference's output at byte offset 256.

The pass starts with `y = 0` and does not wrap around from the track's last byte to
its first. This mirrors the reference. It is safe because both ends of the track sit
inside gap, where the neighbouring bytes are `0xAA` either way.

---

## 4. WFMF container

Little-endian throughout, per `image_loader.c`:

```
u32 magic        0x464D4657  ('WFMF')
u32 version      1
u32 track_count  160
u32 reserved     0
per track 0..159:
    u32 bit_count   101344
    u8  payload[12668]     raw MFM, MSB first
```

No padding is ever emitted: 12,668 is a multiple of 4. The reader still handles
padding, because the format permits it and a future track length might need it.

Byte packing is MSB-first, matching the firmware: `start_streaming` assembles words
as `(w << 8) | mfm[i*4+b]` and the PIO shifts left out of the MSB.

---

## 5. Module layout

`src/lib/adfmfm/` — pure TypeScript, no dependencies, `Uint8Array` in and out.

| File | Responsibility |
|---|---|
| `adf.ts` | Validate an ADF and slice it into 160 track buffers |
| `mfm.ts` | `splitOddEven`, `joinOddEven`, `fillClockBits`, `checksum` |
| `track.ts` | `encodeTrack` / `decodeTrack` |
| `wfmf.ts` | Container writer, plus a reader mirroring `image_loader.c` |
| `index.ts` | `encodeDisk` / `decodeDisk` and the constants |
| `README.md` | Points at `image_loader.c` and `INTEGRATION.md` |

```ts
encodeDisk(adf: Uint8Array): Uint8Array          // 901,120 -> 2,027,536
decodeDisk(wfmf: Uint8Array): Uint8Array         // 2,027,536 -> 901,120
encodeTrack(track: Uint8Array, trackNo: number): Uint8Array   // 5,632 -> 12,668
decodeTrack(mfm: Uint8Array): Uint8Array                      // 12,668 -> 5,632
```

`encodeDisk` **rejects** any input that is not exactly 901,120 bytes rather than
padding it. Greaseweazle zero-pads a short track, which is correct for a recovery
tool reading a damaged disk and wrong for us: a truncated ADF in the library is a
bug we want to hear about, not one we want to silently mount.

The code stays procedural and dependency-free so that the spec §13 backlog option —
moving ADF→MFM onto the Pico in C — remains a transliteration rather than a rewrite.
This is a constraint on style only. Nothing about the design is contorted for it.

---

## 6. Validation

`INTEGRATION.md` asks for a round-trip. Round-trip alone proves only that the
encoder and decoder agree with each other, and a symmetric misunderstanding of the
bit split or the checksum passes it cleanly. So the primary oracle is stronger:
**our bytes must equal Greaseweazle's bytes.**

Four layers, hardest first:

1. **Differential against Greaseweazle, all 61 ADFs.** A `pnpm` script — not part of
   the default vitest run — encoding every disk in `adf-archive/` both ways and
   byte-diffing all 9,760 tracks, reporting the first differing offset and the field
   it lands in. Requires the archive and the pipx install, so it is a local gate,
   not a CI one.
2. **Golden fixtures in vitest.** Expected output committed for *synthetic* ADFs —
   all zeros, all `0xFF`, a seeded PRNG, and a realistic bootblock — generated once
   from Greaseweazle. Synthetic keeps disk images out of the repo (spec §14) while
   letting the suite bite with neither the archive nor Greaseweazle present.
3. **Round-trip.** Encode → decode → compare. Synthetic in vitest, all 61 real disks
   in the script.
4. **Firmware constraints.** Magic, version, track count, `bit_count <= 106,496`,
   4-byte alignment, and a TypeScript port of `image_loader.c`'s state machine fed
   randomly-chunked input — which is how that parser was itself tested on the host.

**Every test is mutation-checked.** Flip a checksum bit, swap odd for even, drop the
clock-fill pass, use `sectorId` instead of physical position in the header, truncate
the pre-index gap — each must make a named test fail. Five of the twelve defects
found across plans 1 and 2 were tests that passed while testing nothing; this is the
subsystem where that failure mode is most expensive, because a subtly wrong encoder
looks perfect until an Amiga refuses the disk.

---

## 7. Firmware findings

Two defects found in `wifi-floppy/` while measuring. Neither blocks this work;
both belong to the firmware plan.

1. **Latent buffer overflow.** `image_loader.c` accepts a track payload up to
   `TRACK_SLOT_BYTES` (13,312), but `track_cache.c` copies it into an SRAM buffer of
   `TRACK_MFM_MAX` (13,000) — a 312-byte overflow for any track over 13,000 bytes.
   Our 12,668 stays under both, so it is latent rather than live. The two constants
   should be reconciled.
2. **Revolution timing.** `BITCELL_NS` is 2,000 against a true 1,973.6, giving ~296
   RPM. Accepted; see §1.

---

## 8. Out of scope

- The image endpoint, its cache, and device auth on it — the next plan.
- Write-back. `WPROT` stays asserted; `mfm_decode_track` in the firmware stays a
  stub. `decodeTrack` here is built for round-trip validation, and happens to be the
  server half of write-back if that is ever taken up.
- HD (22-sector) disks. All 61 archive ADFs are 901,120 bytes; nothing in the
  library needs it.
- Extended ADF, DMS, and any other container. `.dms` in the archive is out of scope
  for this and every current plan.
