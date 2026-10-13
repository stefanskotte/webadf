# lz4_68k: LZ4 block decoder and encoder for the plain 68000

A self-contained module, written for webadf and offered to RobSmithDev's PaulaNET Amiga driver.

- `lz4_68k.asm` holds a checked decoder and a greedy encoder for the standard LZ4 **block** format.
  The encoder has a linked variant. It is Motorola syntax for vasm/Devpac.
- `lz4_68k.h` documents the register contract and declares the C entries.
- `lz4_68k.c` is the portable C reference model of the encoder. The asm output is bit-exact with it.
- `test.sh` and `test/` hold the tests and the cycle bench.

The directory needs no webadf or NetLoop headers. The bench reuses `tools/lz4-measure` from the
repository: the corpus and Carré's decoder, which is the baseline.

It is written from the LZ4 block format description (lz4/lz4, `doc/lz4_Block_format.md`). The
decoder's fast path uses the technique of Arnaud Carré's `lz4_fastest`
([lz4-68k](https://github.com/arnaud-carre/lz4-68k), MIT): a token jump table into unrolled copy
blocks. No code was copied from it or from any other implementation.

The reference liblz4 (BSD-2) is used only on the host and in the tests, to verify the format.
Carré's `lz4_fastest` is run only as the benchmark baseline. It is fetched by
`tools/lz4-measure/fetch.sh` and is not part of this module.

## Format

The format is the standard LZ4 block, with no frame header and no checksum:

- offsets are little-endian;
- the last 5 bytes are literals;
- the last match starts at least 12 bytes before the end.

Blocks from liblz4 decode here. Blocks from here decode with liblz4's `LZ4_decompress_safe`, or
with `LZ4_decompress_safe_usingDict` for a linked block.

**Linked blocks.** A frame's matches may reach back into earlier frames of the same batch. Those
frames sit directly before it in the same buffer. Both sides get the start of that buffer as the
*window*.

## API (register call; every register not carrying the result is preserved)

| entry | in | out |
|---|---|---|
| `lz4_decode` | a0 src, d0.l src length, a1 dst, a2 dst_end (hard limit), a3 window start | d0.l = decoded length, or -1 |
| `lz4_encode` | a0 src, d0.l n (0..65535), a1 dst, d1.l cap, a2 table, d2.l table entries | d0.l = block size, or 0 if it would exceed cap |
| `lz4_encode_linked` | as `lz4_encode`, plus a3 = window start (a3 <= a0) | as `lz4_encode` |

C entries use stack arguments (m68k-amigaos gcc, vbcc) and return the result in d0:

```c
long          lz4_decode(const void *src, unsigned long srclen, void *dst, void *dst_end, const void *window);
unsigned long lz4_encode(const void *src, unsigned long n, void *dst, unsigned long cap,
                         uint16_t *table, unsigned long entries);
unsigned long lz4_encode_linked(const void *src, unsigned long n, void *dst, unsigned long cap,
                                uint16_t *table, unsigned long entries, const void *window);
```

### Decoder guarantees

- It never writes outside `[dst, dst_end)`.
- It never reads src outside `[src, src + len)`.
- It never copies a match from outside `[window, current output)` (unless built with
  `LZ4_68K_UNCHECKED_READS`, below).
- It returns -1 for:
  - a malformed or truncated block;
  - an offset of 0;
  - a match reaching below the window;
  - output that would pass dst_end;
  - `dst_end < dst` or `window > dst` (checked once at entry).
- It accepts any structurally valid block. It does not enforce the encoder-side end rules. An empty
  src gives -1, and the one-byte block `00` decodes to 0 bytes.
- For a plain block, pass `window = dst`. For a linked frame, pass `window = the batch buffer's
  start` and `dst = the place right after the earlier frames`.
- src must not overlap the window/dst area.
- A window below $10000 sends the whole block through the slow checked loop. That is the only
  way a match source could wrap below address 0, and the fast path does not test for it.

### The unchecked-reads build

`vasmm68k_mot -DLZ4_68K_UNCHECKED_READS=1` drops the fast path's two match-source checks: the
window and offset 0. The default is 0, which is checked.

- Writes still stay inside `[dst, dst_end)`, and src is still never read past its end.
- A malformed block may make it copy from memory below the window, or from not-yet-written
  output. It then returns a length instead of -1.
- Valid blocks decode exactly as in the checked build.
- It is about 1-2.5 c/B faster on compressible data (see the table).

### Encoder

- The output is greedy, LZ4-"fast"-shaped, and decodable by liblz4. It is not byte-identical to
  liblz4.
- The cap is exact. The result is the size if the block fits in `cap`, else 0. Nothing is ever
  written at or past `dst + cap`.
- n must be at most 65,535. The linked variant needs `window <= src` and
  `(src - window) + n <= 65536`. Outside that, the result is 0 (checked once at entry).

### Buffers, alignment and tables

- **Buffers:** any address, odd or even, for src, dst and window. No word or long access ever
  lands on an odd address.
- **Hash table:** `entries` 16-bit words, at an even address. `entries` is a power of two from 256
  to 16384. The recommended sizes are:
  - **1024** entries (2 KB) on a 68000/68020;
  - **4096** entries (8 KB) on a 68040 or better (`LZ4_68K_TABLE_SMALL` / `_LARGE`).
- **Table contents:** they never need clearing. Any contents are valid, because stale entries are
  verified before use. Keep the table between calls. For linked frames, carrying it over from the
  batch's earlier frames is what finds the cross-frame matches.
- **Stack:** peak use, measured below the caller's return address and including the saved
  registers, is 64 bytes for the decoder and 80 for the encoder. The C entries add 12 bytes
  (`lz4_decode`, `lz4_encode`) or 16 (`lz4_encode_linked`).
- **Code:** about 4.2 KB for the decoder, 1.0 KB for the encoder and 0.1 KB for the C entries.

### Assembling

```sh
vasmm68k_mot -m68000 -Fhunk -o lz4_68k.o lz4_68k.asm   # hunk object (vbcc / vlink / Devpac-style)
vasmm68k_mot -m68000 -Faout -o lz4_68k.o lz4_68k.asm   # a.out object (bebbo's m68k-amigaos-gcc)
```

## Tests

Run `m68k/lz4/test.sh` for all the steps, or name steps: `host build dec fuzz big enc encr encbig
tail odd bench`. On an M-series Mac the whole run takes about 4 minutes: about 3 min 20 s without
`bench`, and about 50 s for `bench`.

The tests run inside the webadf repository, not from this directory alone. They need:

- `tools/lz4-measure/fetch.sh`, which fetches the pinned liblz4 and Carré's decoder;
- the corpus `tools/lz4-measure/build/corpus.bin` and its frames dump. Make them with
  `tools/lz4-measure/build.sh`; `NO_LIVE=1` works offline, and without `ADF=` there are no ADF
  rows;
- `tools/lz4-measure/m68k/build.sh`, which runs the bench;
- Docker, with the pinned `amigadev/crosstools` image;
- amitools' `vamos`;
- a host cc.

The 68000 test program is linked with bebbo's gcc and the `-Faout` object. The `-Fhunk` object is
assembled but not linked: **VBCC/vlink linking is untested.**

| step | what |
|---|---|
| host | C model vs liblz4 on the host: every corpus frame (tables of 256 to 16384 entries, zeroed and random contents), linked groups, every length 1..1518 × 6 data kinds, edge cases (0..40 bytes, 65535 bytes, a window reaching 65536), 3,000 random linked frames, and exact-cap checks (size fits, size − 1 gives 0, nothing written past the cap). It also writes the decoder vectors. |
| build | assembles with `-Faout` and `-Fhunk`, both checked and `LZ4_68K_UNCHECKED_READS=1`, and links the two 68000 test programs (`vtest`, `vtest_u`). |
| dec | decodes every liblz4 block of the corpus (fast, HC 9, linked fast, linked HC 9; 1,796 frames) at all 4 src/dst parities. Guard bytes surround the output. A dst_end one byte short must give -1. The same run again with the window below $10000 (the checked loop). Both builds. |
| fuzz | 1,600 random frames through liblz4 and our decoder at every parity. Then truncated blocks (all lengths for some), corrupted blocks and random bytes. The result and the output must equal a plain C oracle with the same acceptance rules, with the guards intact. Once more with a window below $10000. Both builds; the unchecked build must match the oracle on every block the oracle accepts, and is otherwise held only to the guards and a result of -1 or 0..cap. |
| big | runs of 65,535..65,540 bytes (a long match at offsets 1, 3 and 4, and a last literal run) at all 4 parities, with dst exact, one short and 1,000 over, plus truncated copies; and the entry checks of both entry points. Both builds. |
| enc | asm == C model, byte for byte and table for table, on the corpus (per frame and linked; 1K and 4K tables) at rotating parities. Every block decodes with liblz4, and the caps are checked. |
| encr | asm == C model on every length 1..1518 at all 4 parities, with mixed data, 1 in 5 linked. Plus liblz4 decode and cap checks. |
| encbig | asm == C model for n = 32,767, 32,769, 40,000 and 65,535, on period-2/3/5 and mixed data, linked with the window reaching 65,536, with tables of 256 and 16,384 entries. |
| tail | the input placed at the very end of a buffer, for the decoder (valid, truncated and corrupted blocks, plain and linked) and the encoder. Both builds. A full vamos memory trace must show no access in the 256-byte guard region after it. |
| odd | a small mixed run of both entry points at every parity. The memory trace must show no word or long access at an odd address. |
| bench | the cycle table below. |

## Measured speed (68000 cycles per raw byte)

These come from vamos (amitools 0.4.0, Musashi's 68000 timings), with
`tools/lz4-measure/m68k/build.sh`. Each figure is vamos' total cycles for 2 passes, minus the
empty loop, per raw byte.

- **F** is the first 64 frames of a type, one block per frame.
- **B** is 8 whole batches, one block each, which is what a linked decode sees.
- Decoders run on liblz4 HC 9 blocks.
- Encoders use cap = the raw size.
- Every codec's output is checked against the raw bytes first.

| type | kind | our decode | our decode, unchecked reads | Carré fastest | our encode 1K | our encode 4K | lz4p encode | asm RLE decode | asm RLE encode |
|---|---|---|---|---|---|---|---|---|---|
| dl-ftp-text | F | 22.3 | 20.9 | 20.0 | 130.1 | 125.9 | 242.4 | 11.5 | 41.2 |
| dl-ftp-text | B | 25.8 | 23.3 | 22.8 | 143.2 | 137.4 | 241.9 | - | - |
| dl-ftp-source | F | 22.6 | 21.1 | 19.9 | 122.3 | 118.2 | 215.0 | 15.1 | 44.3 |
| dl-ftp-source | B | 24.0 | 21.9 | 21.5 | 126.8 | 120.2 | 199.0 | - | - |
| dl-http | F | 21.0 | 19.9 | 18.7 | 103.3 | 99.5 | 177.2 | 14.7 | 44.0 |
| dl-http | B | 19.7 | 18.5 | 18.6 | 93.5 | 88.2 | 141.9 | - | - |
| dl-ftp-adf | F | 19.4 | 18.4 | 18.1 | 107.7 | 105.1 | 199.1 | 15.2 | 42.2 |
| dl-ftp-adf | B | 19.8 | 18.4 | 19.3 | 117.2 | 114.5 | 215.4 | - | - |
| dl-ftp-random | F | 13.4 | 13.4 | 13.6 | 34.5 | 34.0 | 79.9 | 11.2 | 40.5 |
| dl-ftp-random | B | 10.5 | 10.5 | 13.5 | 45.2 | 45.1 | 95.2 | - | - |
| ul-acks | F | 27.4 | 27.0 | 23.7 | 113.0 | 111.8 | 229.2 | 33.0 | 64.0 |
| ul-acks | B | 28.1 | 27.3 | 21.5 | 103.1 | 102.9 | 173.3 | - | - |
| ul-ftp-text | F | 22.3 | 20.9 | 20.0 | 130.1 | 125.9 | 242.5 | 11.5 | 41.2 |
| ul-ftp-text | B | 25.0 | 22.8 | 22.2 | 140.0 | 134.1 | 241.0 | - | - |

At 7.09 MHz, 22 c/B is about 315 KB/s of decoded text, and 130 c/B is about 53 KB/s of encoded text.

**Decoder: honest result.** The checked default build does **not** beat Carré's `lz4_fastest` on
compressible data:

- it is 3-14 % slower on text, source, HTML and ADF;
- it is 16-31 % slower on the tiny ACK frames, where the per-call entry costs weigh most;
- it is faster on incompressible data: 13.4 vs 13.6 per frame, and 10.5 vs 13.5 per batch.

Carré's decoder has no bounds checks at all. Ours checks:

- the source end;
- the destination end, through a per-sequence budget and a checked tail loop;
- the window, at 14 cycles per match;
- offset 0, at 8 cycles per match;
- the arguments, once per call.

The window and offset-0 checks cost about 1-2.5 c/B, depending on sequence length. That is above
the hoped-for 1 c/B. The `LZ4_68K_UNCHECKED_READS=1` column shows the build without them:

- it beats Carré on HTML and ADF batches and on random data;
- it is 2-6 % slower on text, source, HTML and ADF frames, and on text and source batches;
- the remaining gap is the write-safety budget's recounts and each block's checked tail.

Synthetic blocks of fixed sequence shapes give an estimate (not exact) for short sequences: ours
cost about 40 cycles more than Carré's per sequence. About 22 of those are the two checks and about
10 are the recounts, so the per-sequence core comes out within a few cycles of his. Long literal
runs are faster than Carré's: 14.9 vs 17.0 c/B for 40-byte runs.

**Encoder.** It reaches 122-130 c/B on text and source with the 1K table, against the 130-160
target. That is 1.9× faster than the prototype `lz4p`. On incompressible data it is 34 c/B, which
is faster than the asm RLE encoder.

**vamos caveats** (from the research, section 4):

- vamos models no chip-RAM wait states, no DMA contention and no interrupts. A real A500 is
  estimated 0-15 % slower, and more so under a hires Workbench.
- The 68020 table assumes cache hits. It was not run here.
- Code and data in fast RAM avoid the contention.
- The C rows of the research that call `memcpy` are undercounted. None of the rows above do.

## Licence

MIT. Copyright (c) 2026 Stefan Skotte and contributors; see `LICENSE`. It can be embedded in a
closed-source driver as long as the notice is kept.
