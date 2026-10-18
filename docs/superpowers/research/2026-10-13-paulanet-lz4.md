# PaulaNET: LZ4 next to RLE -- measurements and a DRAFT protocol proposal (2026-10-13)

Branch `research/paulanet-lz4`. Background: HANDOFF backlog "LZ4 as an alternative to RLE for PaulaNET payloads"
(operator 2026-10-12; Rob has agreed to add LZ4 to his driver), Phase 2 results in HANDOFF 3bi (47.5 KB/s ftp of a
/dev/urandom file, A500 7.09 MHz 68000). Tools: `tools/lz4-measure/` (`build.sh`, `build.sh 68k`, `model.py`).

Every number below is tagged **[measured]** (host run or vamos cycle count, reproducible with the tools) or
**[estimate]** (arithmetic or judgement on top of measured inputs).

## 1. What the protocol does today (read from the code)

- Compression is **per frame**, not per batch. A batch payload is `PacketsHeader {count, flags}` (MFM, 4 B), then per
  frame `CompressionHeader {size, original size}` (MFM, 8 B) and `size` bytes of RLE **sent as raw bytes** (not MFM),
  padded to even. So "RLE" today mostly means "raw bytes instead of MFM"; on IP traffic it shrinks almost nothing.
- Bit 15 of `size` means RLE toward the board but MFM toward the Amiga (`pnet_frame.h`). Frames are <= 1,518 B, so
  bits 11-14 of `size` are free.
- Rob's tree already has **experimental per-frame LZ4**: `lz4Compress` in `Pico/PaulaNET/rleCompression.cpp` (1,024-
  entry table) and a C `lz4Decompress` in `NetDevice/paulanetio.c`, both commented out. **Both use a big-endian match
  offset, which is not the LZ4 block format** (the format says little-endian). Standard LZ4 would let both sides use
  the reference library and existing 68k decoders; see the proposal.
- `PacketsHeader.flags` toward the Amiga already carries Rob's `DEVICESTATUS_CANSEND/CANRECEIVE` (1, 2, 128); toward
  the board it is 0 (rfu). `DataHeader.compressed` from the driver is `0x42`; Rob's Pico reads only `& 3` and
  `& 0x40`.

## 2. The corpus [measured inputs, synthetic framing]

No packet capture: `tcpdump` needs root here. `corpus.py` takes **real application bytes produced locally from our own
traffic** and frames them the way a stack does (seq/ack advancing, IP ID counting, real IP/TCP/UDP checksums, TCP
timestamps, MSS 1,448, 1,514-byte data frames). Types (dn = to the Amiga, up = to the board):

| type | dir | content |
|---|---|---|
| dl-ftp-random / ul-ftp-random | dn / up | 256 KB `random.Random(1)` (stands for .lha/.zip/.gif, and for the Phase 2 test file) |
| dl-ftp-text / ul-ftp-text | dn / up | first 256 KB of this repo's HANDOFF.md (English markdown) |
| dl-ftp-source | dn | 256 KB of `wifi-floppy/firmware/src/*.c` |
| dl-ftp-adf | dn | first 256 KB of the Workbench 3.1 ADF from `adf-archive/` (`ADF=`; not committed) |
| dl-http | dn | real responses of a local `python http.server` (directory listing + 3 `design/*.html`), 40.6 KB |
| dl-dns / ul-dns | dn / up | real DNS queries/answers for 12 names via the LAN resolver 172.16.10.1 |
| dl-ping, dl-arp-dhcp | dn | ICMP echo replies (BSD layout); ARP requests and DHCP OFFER/ACK (synthetic) |
| ul-acks / dl-acks | up / dn | the pure ACKs of the transfers (ul: 5 per batch; dl: 1 per batch) |

Batching uses the real rules: to the Amiga `pnet_link_fit` (<= 20 frames, RLE-bound payload <= 16,128); to the board
Rob's `paulaNetAddPacket` (8,192 budget, 14-byte worst case, closes below 1,518 free). Sparse types are one batch per
frame. The batches are fixed by today's RLE and reused for every codec. The RLE is `pnet_rle_encode` itself.

## 3. Sizes: wire bytes as % of the frame bytes, all batches [measured]

Wire = 4 + per frame (8 + data, even). `lz4` = liblz4 1.10.0 fast, per frame; `hc9` = LZ4 HC 9 per frame;
`lz4p` = our 68000 prototype (below), per frame; `linkf` / `link9` = LZ4 fast / HC 9 per frame **linked** (a frame
may refer back into the earlier frames of its batch), each frame min(LZ4, RLE). Median per batch in the full output.

| type | dir | batches | RLE | lz4 | hc9 | lz4p | **linkf** | link9 | one block/batch (HC 9) |
|---|---|---|---|---|---|---|---|---|---|
| dl-ftp-random | dn | 19 | 101.4 | 101.0 | 101.0 | 101.0 | **98.7** | 98.7 | 98.3 |
| dl-ftp-text | dn | 19 | 101.1 | 85.9 | 84.0 | 87.1 | **71.3** | 62.9 | 62.3 |
| dl-ftp-source | dn | 19 | 95.8 | 71.8 | 68.7 | 72.6 | **57.0** | 49.6 | 48.9 |
| dl-ftp-adf | dn | 19 | 84.3 | 73.6 | 71.9 | 74.2 | **66.9** | 62.2 | 61.6 |
| dl-http | dn | 3 | 96.7 | 60.1 | 57.3 | 60.6 | **41.4** | 35.7 | 35.0 |
| dl-dns | dn | 12 | 110.5 | 97.8 | 96.7 | 98.3 | 97.5 | 96.7 | 98.3 |
| dl-ping / dl-acks | dn | 50 / 182 | 114.3 / 121.2 | 112.2 / 118.2 | same | same | same | same | 114.3 / 121.2 |
| dl-arp-dhcp | dn | 50 | 56.4 | 64.3 | 62.2 | 56.4 | 56.4 | 56.4 | 63.9 |
| ul-ftp-text | up | 37 | 101.1 | 85.9 | 84.0 | 87.1 | 75.7 | 68.7 | 68.2 |
| ul-ftp-random | up | 37 | 101.4 | 101.0 | 101.0 | 101.0 | 99.0 | 99.0 | 98.6 |
| ul-acks | up | 73 | 116.4 | 113.3 | 113.3 | 113.3 | 69.9 | 67.6 | 59.7 |
| ul-http-req / ul-dns | up | 4 / 12 | 105.4 / 114.4 | 101.7 / 115.8 | | 101.7 / 114.4 | 102.3 / 114.4 | | |

Findings: (1) per-frame LZ4 saves 14-40 % on text/source/HTML, nothing on random or tiny frames; (2) **linking frames
within a batch roughly doubles the gain** (text 71 % vs 86 %, HTML 41 % vs 60 %, ACK batches 70 % vs 113 %) and is as
good as one block per batch while keeping the per-frame layout; (3) the board's LZ4 state size matters for linked mode:
text `linkf` is 71.3 % with a 16 KB hash table, 78.9 % with 4 KB, 90.3 % with 1 KB (`LZ4_MEMORY_USAGE` 14/12/10);
HC needs ~256 KB of state, too much for the RP2350's SRAM. Host encode speed [measured, M-series Mac]: LZ4 fast
~1.3 us/KB, linked fast ~1.4 us/KB, HC 9 ~6 us/KB. **RP2350 encode [estimate]:** 50-100x slower than the host,
i.e. ~70-140 us/KB, 1-2.5 ms for a full 16 KB batch, against ~260 ms that batch spends on the wire -- negligible.

## 4. 68000 cost [measured in vamos unless marked]

`tools/lz4-measure/m68k/build.sh`, the `tools/netloop/cycles.sh` method: vamos (Musashi tables, no chip-RAM wait
states, no DMA contention, no interrupts; 68020 table assumes cache hits), cycles for REPS passes minus the empty loop,
per frame byte, on the first 64 frames (F) or 8 whole batches (B) of each type. Every codec's output is checked
against the raw bytes first (VERIFY: PASS on all files). Cycles per frame byte:

| codec | dl-ftp-text | dl-ftp-source | dl-http | dl-ftp-adf | dl-ftp-random | ul-acks |
|---|---|---|---|---|---|---|
| **decode**: Carré `lz4_fastest.asm`, frames | 20.0 | 19.9 | 18.8 | 18.1 | 13.6 | 23.6 |
| same, whole-batch blocks (= linked) | 22.8 | 21.5 | 18.6 | 19.3 | 13.5 | 21.7 |
| Carré `lz4_normal.asm` (180 B of code) | 30.4 | 29.3 | 29.6 | 30.5 | 30.4 | 38.5 |
| reference `LZ4_decompress_safe` (gcc -O2) | 58.4 | 58.0 | 48.0 | 44.8 | 23.8* | 46.7 |
| our RLE decode, asm (`pnet_asm.S`) | 11.5 | 15.1 | 14.7 | 15.2 | 11.2 | 32.7 |
| **encode**: reference `LZ4_compress_fast` (gcc -O2, 4 KB table) | 636 | 559 | 469 | 534 | 223 | 825 |
| our prototype `lz4p.asm` (1 KB table) | 242 | 215 | 177 | 199 | 80 | 228 |
| its C model `lz4p.c` (gcc -O2) | 392 | 343 | 283 | 327 | 129 | 368 |
| our RLE encode, asm | 41 | 44 | 44 | 42 | 41 | 64 |

So on a 7.09 MHz 68000: **LZ4 decode ~300-510 KB/s** (fastest; 230 KB/s normal); **LZ4 encode ~29-87 KB/s with our
asm prototype**, 11-31 KB/s with the compiled reference. On the 68020 table (14.19 MHz) decode is ~0.6x the cycles.
*Caveat [measured]: libnix `memcpy` calls `exec CopyMem`, which vamos runs natively in Python at zero cycles, so any
C codec that copies through memcpy/memset is undercounted (the reference LZ4 decoder's copies, and our C RLE decode,
which came out at 5-6 c/B; omitted above). This also applies to the C rows of `tools/netloop/cycles.sh`. The asm rows
and `lz4p.c` do not call memcpy. Real A500 [estimate]: 0-15 % slower than vamos (chip RAM contention under a hires
Workbench).

### Survey and licences (operator bar: MIT / BSD / zlib / PD only; the code must also be embeddable in Rob's
"all rights reserved" driver with no condition beyond keeping a notice)

| code | what | licence | usable |
|---|---|---|---|
| Arnaud Carré, [lz4-68k](https://github.com/arnaud-carre/lz4-68k) @773f8a0 | 68k LZ4 block **decoders** (smallest 72 B, normal 180 B, fastest 3,722 B) | MIT (2021) | yes (keep the notice). No bounds checks |
| [lz4/lz4](https://github.com/lz4/lz4) v1.10.0 `lib/` | reference compressor/decoder (board side; host) | BSD-2-Clause | yes |
| [L-Packer](https://github.com/arnaud-carre/L-Packer), [execram](https://github.com/going-digital/execram) | host-side exe packers with Carré-style depackers | not checked | not needed |
| SGDK LZ4W (Mega Drive) | word-aligned LZ4 *variant*, 550-950 KB/s decode | different format | no (not LZ4) |
| [Bumbershoot](https://bumbershootsoft.wordpress.com/2025/07/12/lz4-decompression-on-the-68000/) blog decoders | 68000 decoder in a blog post | none stated | no |
| Rob's `lz4Compress` / `lz4Decompress` | C, big-endian offsets | all rights reserved (his) | his to use |
| **a fast 68k LZ4 compressor** (operator mention) | -- | -- | **not found**: GitHub, EAB, Aminet and pouet searches turned up only decoders and host-side packers. Need the link. |

No third-party 68k LZ4 **compressor** that passes the bar was found, so the encoder is ours (`lz4p`, MIT).

## 5. Verdict per direction and CPU [estimate, arithmetic in `tools/lz4-measure/model.py`]

Model per KB of frame bytes: T = O + r x 16.384 ms + D, with 16 us per wire byte (8 cells of 2 us), r the wire ratio
(section 3), D the codec time (section 4), and O = 2.82 ms calibrated so random data with RLE gives the measured
47.5 KB/s.

**Download (board compresses, Amiga decodes with lz4_fastest), 68000 7.09 MHz:**

| type | RLE | linked LZ4 fast (board) | link9 (upper bound) | per KB: wire time saved vs extra decode |
|---|---|---|---|---|
| random | 47.5 KB/s | 47.8 (+1 %) | 47.8 | 0.44 ms vs 0.33 ms |
| text | 47.5 | **56.2 (+18 %)** | 60.9 | 4.88 ms vs 1.63 ms |
| C source | 48.3 | **65.5 (+36 %)** | 71.2 | 6.36 vs 0.92 |
| ADF | 53.1 | 60.4 (+14 %) | 63.3 | 2.85 vs 0.59 |
| HTML | 48.1 | **81.4 (+69 %)** | 88.1 | 9.06 vs 0.56 |

Decoding pays on every CPU, the 68000 included: the extra decode is 7-30 % of the wire time it saves on compressible
data (68020 @14: 0.2-0.6 ms per KB). On incompressible data it is a wash, hence the 1/16 threshold below.

**Upload (the Amiga compresses):** per KB of text the wire saves 2.3 ms (per frame) or 4.2 ms (linked). Our asm
prototype costs **29 ms more than asm RLE on a 68000**, 6.5 ms on a 68020 @14, ~1.8 ms on a 68030 @50, ~0.6 ms on a
68060 @50. Break-even on a 68000 needs a whole LZ4 encoder at <= 57-70 cycles/byte, i.e. barely more than the 41 c/B
of our asm *RLE* encoder; even a well-tuned own encoder (est. 130-160 c/B) is 2x off. Uplink traffic during downloads
is ACKs, which per-frame LZ4 cannot shrink at all. So:

- **68000 (7 MHz) and 68020 (14 MHz): download-only.** Decode LZ4, keep RLE upward.
- **68030 >= 40 MHz, 68040, 68060, 080: both ways** pays for compressible uploads (+~10-30 % on text uploads) and
  never costs much on random data thanks to the encoder's skip acceleration (80 c/B, 0.27 ms per KB on a 68030 @50).
- The choice is the **driver's**, from `AttnFlags` (AFF_68040 or better; a tooltype to force it on a fast 030). The
  board does not need to know the CPU.

## 6. Recommendation

- **Decoder:** Arnaud Carré's `lz4_fastest.asm` (MIT, measured 13.5-23 c/B, 300-510 KB/s on the 68000). Ship it with
  its notice; add a destination-end guard (it has none, and the batch checksum is only a 16-bit XOR) -- that is ~1 c/B
  [estimate]. An own decoder could reach ~12-18 c/B [estimate: long copies when parities match, Carré's token jump
  table idea], a 10-25 % gain; not worth doing first.
- **Compressor (Amiga side, 68040+ only):** our own, from `lz4p.asm` (MIT). Prototype measured 80-242 c/B, 2.6x the
  compiled reference. Tuning plan [estimate 130-160 c/B on text]: rolling 32-bit window while the step is 1 (no odd-
  address re-read), `cmpm.l` match extension when both pointers are even, table and buffers in fast RAM, 4,096-entry
  table on 040+. Design kept: 16-bit position table never cleared (stale entries only cost a compare), LZ4 skip
  strength 6, backward extension, max offset = the batch (<= 16 KB, far under 65,535), give-up when the block would
  not beat the cap.
- **Board:** reference liblz4 (BSD-2), `LZ4_compress_fast_continue` over the batch (linked), acceleration 1, state
  size to be decided against SRAM: 16 KB gives text 71 %, 4 KB 79 % (heap low-water is 32 KB with a 20 KB floor, so 16
  KB probably goes to PSRAM or replaces another buffer).
- **Module for Rob:** the 68k code becomes one self-contained module: Motorola-syntax `.asm` for vasm/Devpac (`-Faout` for bebbo's gcc is
  what `m68k/build.sh` uses; `-Fhunk` for VBCC-style links is vasm's standard output, not tried here), register-call entry points
  documented in the header (`lz4p_encode`: a0 src, a1 dst, a2 table, d0 n, d1 cap -> d0 size or 0; all else saved)
  plus a stack-call `_name` wrapper, no NetLoop/webadf includes, MIT so he can embed it in his all-rights-reserved
  driver keeping only the notice. The same bar applies to anything third-party we put in it (Carré's decoder: MIT, ok).
- **Verification (as tools/netloop does for RLE):** bit-exact against a C model under vamos (done for the prototype:
  `lz4bench ... VERIFY` compares `lz4p.asm` with `lz4p.c` byte for byte and decodes every block with
  `LZ4_decompress_safe`); the host checks the C model's output decodes with the reference liblz4 on the whole corpus
  (done, 1,796 frames). Before release add: random frames of every length 1..1,518 at every src/dst alignment, an
  over-read test with the input at the top of RAM, and the odd-address trace check of `tools/netloop/build.sh`.

## 7. DRAFT protocol proposal -- to discuss with Rob, nothing agreed

1. **Format:** standard LZ4 **block** format (little-endian offsets, last 5 bytes literals, last match >= 12 bytes
   from the end). No frame format, no checksum (the batch checksum stays).
2. **Board advertises** in the cylinder-76 record: a capability byte the board owns. Option A: `LiveStatus.reserved`
   (offset 155, today 0): bit 0 = "I can send LZ4", bit 1 = "I accept LZ4 from the Amiga". Option B: new
   `PaulaNETSettings.flags` bits 2/3 (but `flags` is also the config tool's setting, so the tool must preserve them).
   Old drivers ignore both.
3. **Driver signals** in every batch it writes: `DataHeader.compressed` bit 4 (`0x10`, alongside `0x42`) = "this
   driver decodes linked LZ4". It is in every write, empty batches included, so the board learns it on the first
   exchange and forgets it when a batch arrives without it. The board sends LZ4 only while the last batch carried it.
   No CPU class is sent: the driver alone decides whether it compresses (section 5).
4. **Per frame:** `CompressionHeader.size` bit 14 (`0x4000`) = LZ4 block; bits 0-13 = the exact block length; the
   wire pads it to even as today. Bit 15 keeps its direction-dependent "compressed" meaning (toward the Amiga 0, toward
   the board 1), so LZ4 is `0x4000 | len` to the Amiga and `0xC000 | len` to the board.
5. **Linked:** LZ4 frames may copy from every earlier frame of the same batch (whatever its codec), so the decoder
   writes the batch's frames back to back into one buffer and delivers each from there. Frames never refer across
   batches (a retried batch decodes alone).
6. **Fallback, board:** per frame, LZ4 only if the driver signalled it and the block is <= 15/16 of the RLE size;
   otherwise RLE exactly as today. Old drivers therefore get today's bytes.
7. **Fallback, driver:** compresses with LZ4 only if bit 1 of the capability byte is set and its CPU class qualifies;
   per frame, only if the block beats its cap (`lz4p` returns 0 otherwise), else RLE.
8. **Sizes:** packing rules stay as today (board: RLE bound, <= 20 frames, payload <= 16,128; driver: 8,192 budget
   with the RLE worst case). A frame's LZ4 is used only when smaller than its RLE, so no bound grows: the driver's
   16,640-byte read and the 16,128 cap hold. The decoded batch stays <= 16,128 B, inside the driver's 16,640-byte
   `compressionSpace`, which linked decoding needs.

**Open questions for Rob:** (a) capability byte in `LiveStatus.reserved` or bits in `flags`? (b) is `0x10` in
`DataHeader.compressed` free in all his tools (config tool included)? (c) can `compressionSpace` hold a whole decoded
batch back to back (linked mode), and is a 3.7 KB decoder acceptable in the driver? (d) his experimental LZ4 uses
big-endian offsets -- OK to move to the standard? (e) does his Pico firmware want the same bits (both boards stay
interchangeable)? (f) how fast is his C `rleCompress` on a 68000? If it is far above our asm RLE encoder's 41 c/B, an
asm RLE encoder is the cheapest upload win on a 68000, independent of LZ4.

## 8. Not done / limits

- No capture of real A500 traffic; the framing is synthetic (section 2). The live parts (DNS answers) vary per run.
- The throughput model is serial and assumes O constant; per-batch overheads are folded into O. To be checked on the
  bench (the backlog's measure-first step), with the busy-poll effect.
- RP2350 encode time and the tuned-encoder figures are estimates; no board code was written.
- The prototype encoder is verified on 64 frames per type and 8 batches per type only.
