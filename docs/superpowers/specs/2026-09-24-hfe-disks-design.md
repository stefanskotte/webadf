# HFE disks: upload, play, and extract — design

**Date:** 2026-09-24
**Status:** design approved in conversation by the operator 2026-09-24 ("that looks correct,
lets do Approach A"); this written spec awaits their review.
**Scope:** HFE **v1** only. **IPF is ruled out** (licensing: the CAPS/SPS library's terms;
operator 2026-09-24). **HD (1.76 MB) is a separate, later increment** (operator 2026-09-24:
"will come later when I have the board").

Research this rests on (with sources): `docs/superpowers/research/2026-09-24-hfe-and-hd-floppies.md`,
summarised in §2. The HANDOFF backlog entry "Support HFE and IPF" is the origin.

---

## 1. What this delivers

An operator can upload an `.hfe` (HxC Floppy Emulator) image of an Amiga DD disk, see it in the
library, mount it on a wifi-floppy board, and play it — including copy-protected titles whose
protection is carried by the flux the board can replay. When the HFE turns out to hold a
standard AmigaDOS disk, the operator can **extract it as an ADF**, which becomes an ordinary,
editable disk.

**What it is not:** HFE v3 (weak bits, variable density), HD disks, IPF, writing to an HFE disk.

---

## 2. Facts this design rests on

- **HFE v1 layout** (HxC spec; FlashFloppy `hfe.c`): 512-byte header with signature `HXCPICFE`,
  track count, sides, track encoding, bitrate, rpm, interface mode, and a track-list offset (in
  512-byte blocks); a track LUT of `{offset (blocks), length (bytes)}`; track data interleaved
  256 bytes per side per 512-byte block; **bits are LSB-first within each byte** — the opposite
  of this repo's MSB-first MFM packing, so every read bit-reverses.
- **HFE v3** (`HXCHFEV3`) adds opcodes in the bitstream (NOP, set index, set bitrate, skip bits,
  random/weak bits). The board plays a fixed 2 µs bitcell deterministically, so weak bits and
  bitrate changes cannot be replayed without a firmware + container change. Out of scope.
- **WFMF v1** (the container the board already streams; `image_loader.c`, `src/lib/adfmfm/wfmf.ts`)
  carries a **per-track bit count**, and the firmware wraps DMA and times INDEX from it
  (`start_streaming`). So tracks of differing length — long-track protections — are carried as
  long as each fits `TRACK_MAX_BYTES` (13,312 bytes = 106,496 bits vs a nominal DD track's
  ~101,344: ~5% headroom). Bitcell duration is fixed per stream (2 µs).
- **The ADF path converts per request:** `/api/device/image/[sha256]` reads the stored ADF blob
  and runs `encodeDisk` → WFMF on each device fetch. HFE follows the same shape.
- **`decodeTrack` exists** (`src/lib/adfmfm/track.ts`, MFM → 5,632 sector bytes) but assumes the
  encoder's own byte alignment; a real HFE capture has sync words at arbitrary bit offsets, so
  extraction needs a **bit-aligned sync search** in front of it.
- **Blast radius of a non-ADF disk** (research §B6): `mount.ts`'s `sizeBytes === ADF_BYTES` gate;
  the image route; `src/lib/adffs` (file browsing, fixed DD geometry); `src/lib/adfmfm` (DD-only
  constants); the four `disk-history` modules (write-back/restore); TOSEC/OpenRetro/Demozoo
  identification (hash an ADF); the ingest page (`accept=".adf,.dsk,.adz,.dms"`). `storage.ts`
  itself is format-agnostic, and `MAX_DISK_BYTES` (2 MiB) already admits a DD HFE.

---

## 3. Decisions

**D1. Store the original HFE; convert per request (Approach A).** The disk's blob is the
uploaded `.hfe` bytes, content-addressed like every other blob. The device image route converts
HFE → WFMF when the board fetches it, exactly as it encodes ADF → WFMF today. One source of
truth; a converter fix ships by deploy, never by re-upload. (Rejected: B — convert once at upload
and store WFMF, which discards the original; C — store both, which buys nothing over A.)

**D2. A disk has a kind: `adf` or `hfe`.** A new `kind` column on `disks` (default `adf`, so every
existing row is unchanged). Every ADF-assuming gate in §2's list branches on it explicitly —
never by sniffing sizes. HFE disks are **always write-protected**: no write-back, no history, no
restore, no file editing. The places that would offer those check `kind` and hide the control
entirely (show-both-values rule: the disk says "Read-only (HFE)", not a missing button).

**D3. Upload accepts HFE v1 Amiga DD only, and says why it refuses anything else.** The ingest
page accepts `.hfe`. The server validates before storing:
- signature `HXCPICFE` → accepted path; `HXCHFEV3` → **refused**: "HFE v3 isn't supported yet —
  it can carry weak-bit and variable-density protections the board can't replay. Save it as HFE
  v1 (e.g. with HxC or Greaseweazle) if the disk doesn't need them."
- `formatrevision` must be 0 (HFE v1). Revision 1 (HFE v2) already uses the opcode stream
  and is refused with the same message as v3.
- `track_encoding`: accept the MFM values (`AMIGA_MFM`, `ISOIBM_MFM`) **and `0xFF`
  (unspecified)**. Only explicit FM encodings (`ISOIBM_FM`, `EMU_FM`) are refused. **MEASURED
  2026-09-24:** Greaseweazle 1.x (`gw convert --format amiga.amigados x.adf x.hfe`) writes
  encoding `0xFF` and interface mode `0xFF`, so a rule requiring an MFM label would have refused
  every Greaseweazle HFE.
- `bitRate`: accept 250 kbit/s **±5%** (238–262). **MEASURED 2026-09-24:** Greaseweazle writes
  the measured rate, `253`, not a nominal 250 or 500. The accepted range is pinned by that
  fixture (§6).
- **"Is this an Amiga disk?" is decided by content, not the header** (the header cannot tell a
  PC 720 KB HFE from an Amiga one: same geometry, same rate, same `0xFF`s). Every Amiga disk has
  a standard AmigaDOS track 0 — Kickstart reads the bootblock through trackdisk — so an HFE whose
  cylinder 0 side 0 yields no Amiga-format sectors 0 and 1 is refused: "Not an Amiga disk: track
  0 has no Amiga boot sectors." (A protected title's other tracks may be non-standard; track 0
  may not.)
- 2 sides; 80–84 cylinders. Cylinders 80–83, when present, are **accepted but not served**
  (the board serves cylinders 0–79, `NUM_TRACKS` = 160), and the upload result says so
  ("cylinders 80–83 present: not served by the board").
- every track's converted bit count must fit `TRACK_MAX_BYTES`; a track that doesn't is refused
  **at upload** with the track number, never at mount time on the Amiga.

**D4. HFE → WFMF conversion is a pure function in `src/lib/hfe/`.** `parseHfe(bytes)` →
per-track, per-side bitstreams (bit-reversed to MSB-first, de-interleaved) with validation errors
as typed exceptions; `hfeToWfmf(bytes)` → the WFMF container via the existing `writeWfmf`, one
WFMF track per (cylinder, side) for cylinders 0–79 in the order the firmware expects
(`NUM_TRACKS` = 160; cylinders 80–83 not served, per D3). Per-track bit counts
are preserved, never padded to nominal.

**D5. Extract as ADF is explicit, and only offered when it is clean.** At upload the server
attempts an AmigaDOS decode: bit-aligned sync search per track, then `decodeTrack`'s header and
data checksum checks, for all 1,760 sectors. The result is stored on the disk as
`extractable: boolean` plus, when false, a short reason (e.g. "track 0: no sync — non-AmigaDOS or
protected"). The disk page shows **"Extract as ADF"** only when extractable; pressing it creates a
new, ordinary `adf` disk (writable per the usual default, browsable, identifiable) in the same
game, labelled as extracted from the HFE. The HFE disk is never modified. When not extractable,
the page says why in one line (e.g. "Not a standard AmigaDOS disk — play only").

**D6. The weak-bit notice.** HFE disks carry a short notice, on the upload result and on the
disk page: "Weak-bit copy protections aren't supported — some protected titles may not load."
Deliberately worded as a limit, not a promise of what does work.

**D7. Identification.** TOSEC/OpenRetro/Demozoo matching runs on ADF bytes and stays that way: an
extracted ADF is identified like any upload. Raw HFE bytes are not matched (the DATs do not list
HFE hashes). The library shows HFE disks with an "HFE" tag.

---

## 4. Units

| Unit | Does | Tested by |
|---|---|---|
| `src/lib/hfe/parse.ts` | header + LUT + de-interleave + LSB→MSB bit reversal; typed refusals (v3, encoding, bitrate, geometry) | vitest against real HFE fixtures (§6) |
| `src/lib/hfe/to-wfmf.ts` | parsed tracks → WFMF (`writeWfmf`), per-track bit counts preserved; too-long track refusal | vitest round-trip (§6) |
| `src/lib/hfe/extract.ts` | bit-aligned sync search → `decodeTrack` → 901,120-byte ADF or a reason | vitest: clean fixture → exact ADF; protected/garbled fixture → reason |
| DB: `disks.kind`, `disks.extractable`, `disks.extract_reason` | migration (guarded ALTER, never `db:push`) | vitest on the gates |
| ingest route + page | accept `.hfe`, validate, store, record kind/extractable | e2e |
| device image route | branch on kind: `encodeDisk` (adf) vs `hfeToWfmf` (hfe) | e2e with a paired simulated device |
| `mount.ts` + every §2 gate | branch on kind; HFE never writable | vitest + e2e |
| disk page / library | "HFE" tag, read-only state, notice, Extract button or reason | e2e |
| extract action | creates the ADF disk in the same game; HFE untouched | e2e |

---

## 5. Order of work

1. `src/lib/hfe` parse + to-wfmf + extract, pure and fully tested (no app changes).
2. Schema (`kind`, `extractable`, `extract_reason`) and every ADF gate made kind-aware, with
   HFE-specific tests proving each gate refuses or branches correctly.
3. Ingest (`.hfe` accepted and validated) and the device image route.
4. UI: tag, read-only state, notice, Extract.
5. Bench acceptance when the operator has the board (§7).

---

## 6. Testing

- **Fixtures from independent tools, never from our own encoder alone** (memory: "fixtures must
  model the real signal's shape"). Produce HFE v1 files from known ADFs with Greaseweazle and/or
  HxC (both on this machine or installable), commit them under `src/lib/hfe/__fixtures__/`, and
  record the exact commands. Include at least: a clean AmigaDOS DD disk; a disk with one damaged
  sector (not extractable, reason names the track); an HFE v3 file (refused); a non-Amiga (PC
  MFM, e.g. `gw convert --format ibm.720`) HFE (refused by the track-0 rule).
- **Round trip:** ADF → (independent tool) → HFE → `hfeToWfmf` → `decodeDisk` must equal the
  original ADF byte-for-byte; and `hfeToWfmf` must pass `firmware-parser.ts` (the firmware
  acceptance mirror).
- **Bit order:** a test that fails if the LSB→MSB reversal is dropped.
- **Extract:** clean fixture → ADF identical to the source; damaged fixture → not extractable
  with the right reason.
- **E2e:** upload `.hfe` → library shows HFE tag + notice; the simulated device fetches WFMF for
  it; Extract creates a browsable ADF; v3 upload refused with the message; an HFE disk offers no
  write/history/edit controls.

---

## 7. Bench acceptance (when the board is available)

1. Mount a clean AmigaDOS HFE: the Amiga boots/reads it like the equivalent ADF.
2. Mount a copy-protected title known to use long tracks (not weak bits): it loads.
3. Mount a title known to use weak bits: it fails the way the notice says; nothing else breaks.
4. Extract a clean HFE as ADF, mount the ADF: identical behaviour.

---

## 8. Out of scope / later

- **HFE v3** (weak bits, bitrate changes): needs a WFMF v2 (per-region timing / multi-revolution
  or weak-bit flags) and firmware PIO changes — its own increment, with the board.
- **HD disks**: separate increment (encode-on-device timing + a PIO drive-ID answer; both need
  bench measurement). HANDOFF records the research.
- **IPF**: ruled out.
- **Writing to HFE disks**: never — an HFE is a preserved original; extract to ADF to edit.
