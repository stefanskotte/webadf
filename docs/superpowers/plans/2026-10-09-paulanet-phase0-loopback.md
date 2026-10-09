# PaulaNET Phase 0: Track-77 Loopback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, on the bench A500, whether PaulaNET's own framing on DF1 cylinder 77 reaches the operator's bar
(at least 15 KB/s and a median round trip of at most 250 ms), using a TEST firmware build that echoes every batch
and an Amiga CLI tool, `NetLoop`, that writes, reads back and times it.

**Architecture:** The board side is pure, host-tested C (`pnet_mfm`, `pnet_frame`, `pnet_rx`, `pnet_loop`) plus
small hooks in `flux_capture.c` and `main.c`. Every hook sits under `#if WF_PNET_LOOP`, a CMake option that is OFF
for every release. In a TEST build:
- a WGATE on SEL1 with DF1's head on cylinder 77, side 0, arms the existing capture in a raw-cell mode;
- core0 parses the batch into a PSRAM echo store;
- a read of side 1 streams the echo through DF1's existing stream buffer, in PaulaNET's framing.

`NetLoop` is built with bebbo's m68k-amigaos-gcc 6.5 in a digest-pinned Docker image. It compiles the board's own
codec files unchanged, and reaches the Amiga on an ADF that `xdftool` builds and the web library serves.

**Tech Stack:** C11 + pico-sdk 2.3.0 (RP2350, PIO, DMA), host tests in `wifi-floppy/firmware/test/run.sh`; bebbo
`m68k-amigaos-gcc` 6.5 (Docker `amigadev/crosstools`), AmigaOS 3.1 `trackdisk.device` / `timer.device`; amitools
(`xdftool`, `vamos`); vitest for the one web-side guard.

**Spec:** `docs/superpowers/research/2026-10-09-paulanet-df1.md`: §8 "Phase 0: track-77 loopback, measured", read with
§1 (PaulaNET as published), §3.4 (core0 time and the track paths) and §5 (DF0/DF1 sharing). The operator rulings
below override the spec where they differ, and the "Corrections" section records where the code overrides it.

## Operator rulings (2026-10-09), binding

1. **Only Rob's PaulaNET framing:** raw RLE bits, `IOTDF_INDEXSYNC`, software alignment. The spec's framing (b),
   MFM with `IOTDF_WORDSYNC`, is dropped, so NetLoop has no framing switch.
   - RobSmithDev granted the use of all of PaulaNET (protocol, driver, code) as long as the overall licence is
     respected: his copyright notice and credit go wherever his code or protocol is used.
   - This plan implements from the protocol's description and pastes none of his source. Every file that implements
     the protocol carries his notice. The only things taken from his code are golden test vectors: the output of his
     reference encoders, run on a host on 2026-10-09 (see Task 1).
2. **The bar to continue to Phase 1:** at least 15 KB/s, and a median round trip of at most 250 ms, on the bench A500.
   - The bench A500 is rev 8a.1 with Kickstart 3.1, 1 MB chip + 8 MB fast RAM, and Workbench on an IDE drive with
     AmiTCP_NG installed.
   - How the numbers are read is in Task 10, step 3.
3. **The board side is a TEST build, never a release.**
   - Publish it with `pnpm firmware:publish --notes "TEST build: ..."`.
   - Network mode is hard-wired in that build: DF1's cylinder 77 is the loopback whenever DF1 is on and holds a
     disk.
   - With the test mode off (every release, `WF_PNET_LOOP=OFF`), DF1 works exactly as today.
4. **Amiga side:** a CLI tool, `NetLoop`, built with bebbo's m68k-amigaos-gcc in Docker with a pinned image digest,
   by a script under `tools/` that builds it reproducibly.
   - The executable reaches the Amiga on an ADF that the web app serves.
   - `xdftool` (amitools, on this machine) builds the ADF.
5. **Bench:** the operator does one physical step per turn. The serial log is taken with `serstream.py` (its source is
   in Task 9, step 5).

## Corrections to the spec, from the code

The code and Rob's repository (commit `0afd5fa`, cloned in the research session's scratchpad under
`ext/PaulaNET`) were read for this plan. Where they disagree with the research doc, this plan follows the code:

1. **Amiga to board, the DataHeader is sent RAW, not MFM.** The spec's §1.2 lists "2. The MFM header" in this direction.
   - `paulanetio.c` `transmitToPaulaNET` and `paulaNetTransmitPackets` write the 12-byte struct straight after
     `0x0001 0x0001`, and `PaulaNET.cpp` `handleDataReceived` reads it raw (with `SWAP16`).
   - Only the PacketsHeader and the CompressionHeaders are MFM in that direction.
   - From board to Amiga, the DataHeader is MFM (24 bytes).
2. **Bit 15 of a frame's size flips meaning with direction.**
   - Toward the board it means RLE (`paulaNetAddPacket` ORs `0x8000` when compressing; the Pico decompresses when it
     is set).
   - Toward the Amiga it means MFM (`PaulaNET.cpp:1426`; `paulaNetReceivePackets` MFM-decodes when it is set).
   - `pnet_frame.h` takes the direction as a parameter for this reason.
3. **`flux_in` does not measure edge to edge.**
   - `floppy.pio` counts while WDATA is high and pushes at the next falling edge, so every interval comes back short
     by the pulse's low time.
   - MFM's 2/3/4-cell classes never noticed. PaulaNET's 1-cell intervals do.
   - The spec's "interval / cell, rounded" classifier therefore needs that low time added back. `pnet_rx.c` learns it
     from the write's own 16-cell sync interval.
4. **DF1's INDEX is raised only at each buffer wrap** (`dma_irq`, `main.c:632-670`), while PaulaNET raises INDEX at
   the start of every transmission (`PaulaNET.cpp:1113-1129`).
   - The spec's §3.4 and §5 call the wrap INDEX "already right for INDEXSYNC reads". It is not, for latency: the
     first INDEXSYNC read after a stream starts would wait one whole buffer (about 135 ms for an 8 KB echo).
   - The loopback raises INDEX itself when it starts the echo stream (Task 7).
5. **The OTA idle gate reads DF0's motor only.**
   - `g_motor_on` is `dskchg_motor_on()` = drive 0 (`dskchg.h:34`, `main.c:2402`), so DF1's motor does not hold an
     update back, contrary to spec §3.4.
   - What holds it back while networking is `gate_mounted`/`gate_slot`: DF1 gets a disk only as the next disk of a
     set that is mounted on DF0 (point 6).
   - For the TEST build this is noted, not solved, as the ruling allows. `.fw-target.mts` ejects DF0 first.
6. **DF1 cannot serve "a test ADF" of our choosing.**
   - `dc_df1_want` (`device_client.c:720-727`) gives DF1 only the preloaded next disk of the set that DF0's disk
     belongs to.
   - So the bench mounts a set disk on DF0 (Workbench 3.1, disk 2), and DF1 holds the next disk (Locale).
   - In the TEST build, cylinder 77 of that disk is shadowed by the loopback.
7. **DF1's stream buffer is 14,336 bytes** (`DF1_WORD_BUF_BYTES`), smaller than PaulaNET's default Pico-to-Amiga
   transfer (`maxTxSize` 16,128, `PaulaNET.cpp:80`).
   - NetLoop therefore caps N at 12,000 bytes, which is 12,443 bytes on the wire at worst.
   - Phase 2 with Rob's own driver must configure a smaller `maxRxSize` or grow DF1's buffer. This is recorded for
     Phase 1 in Task 10.
8. **Minor.** RLE output is not "every control byte non-zero" (spec §1.3): the encoder pads an odd output with one
   `0x00` control byte. Rob's Amiga decoder skips it. His Pico decoder reads it as "repeat 0" and swallows the next
   byte, which is harmless only because the pad is always last. `pnet_rle_decode` skips it, as the Amiga does.

## Global Constraints

- **Toolchain:** before any firmware build, run `export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"`
  (`docs/decisions/2026-08-30-device-firmware-rulings.md`, Ruling 9). The build is
  `cmake -B build -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 && cmake --build build`.
- **Stack:**
  - Every function of ours is held to 768 bytes of stack frame (`-Werror=frame-larger-than=768`).
  - core0's stack is 4 KB (`PICO_STACK_SIZE=0x1000`).
  - Nothing new keeps a buffer on the stack. The largest new frame is `pnet_serve_df1`'s 20 frame refs (160 B).
- **SRAM:**
  - The heap floor is 20,480 B (DF1 ledger, Ruling R11). The last reading was 36,864 B, on 1.8.1.
  - The TEST build may add at most a few hundred bytes of `.bss`. Measured while validating this plan: +188 B
    `.bss`, +8 B `.data`.
  - Large buffers are reused (`mfm_buf` 32 KB, `track_words1` 14,336 B) or go in PSRAM (`g_pnet_echo`, 2 x 16 KB).
- **DF0 is byte-identical when the test mode is off.**
  - `WF_PNET_LOOP` defaults to OFF, and the pnet sources are added to the image only when it is ON.
  - Every hook is under `#if WF_PNET_LOOP`, and each such include sits inside one.
  - `wifi-floppy/firmware/tools/pnet_off_identical.sh` proves it (Tasks 6 and 7): `main.c` and `flux_capture.c`
    preprocess to exactly master's text with `WF_PNET_LOOP=0`.
- **TEST build only:**
  - The image carries the marker `wf-pnet-loop-test`.
  - `refuseReleaseImage` refuses it unless `--notes` starts with `TEST build`.
  - It is never announced, and never merged as a release.
- **core0 only:**
  - Everything the loopback does runs on core0: the STEP and WGATE ISRs, and its loop.
  - core1, lwIP and TLS are untouched.
  - The PSRAM echo store is not a disk slot: core1 never writes it, and it needs no `psram_df1` handshake.
- **Protocol credit:** every new file that implements PaulaNET starts with "PaulaNET protocol: Copyright (C) 2026
  RobSmithDev, https://github.com/RobSmithDev/PaulaNET. Used with the author's permission (2026-10-09)". This applies
  to `src/pnet_*.{c,h}`, the pnet tests, and `tools/netloop/*`. No code of his is pasted.
- **The shared codec is portable C.**
  - `pnet_mfm.c` and `pnet_frame.c` compile unchanged for the board, the host and the 68000.
  - Byte order is always explicit.
  - There are no unaligned 16/32-bit loads: a 68000 takes an address error on one.
- **Host tests** live in `wifi-floppy/firmware/test/` and are picked up by `run.sh`'s `test_*.c` glob.
  - A task is green only when `wifi-floppy/firmware/test/run.sh; echo "exit $?"` prints `exit 0`, because `run.sh`
    reports failures but keeps going.
  - CI builds them with Linux GCC, which warns more than clang. Run the new tests once under `gcc:13` (Task 4).
- **Amiga build:**
  - `amigadev/crosstools@sha256:bf5c0e37d2b60cf2aca93225558a7b6357e4598f8c82d04cdcb6a8268c9035d1` (gcc
    `6.5.0b 20260819`), with flags `-noixemul -m68000 -O2 -std=gnu11 -Wall -Werror`.
  - All CHIP buffers are word-aligned, and no transfer exceeds 32,766 B (DSKLEN).
- **Bench:**
  - The operator does one physical step per turn, and the step ends the turn.
  - PASS or FAIL must be visible at a glance: NetLoop prints `RESULT: PASS` or `RESULT: FAIL`.
  - Firmware installs go through `.fw-target.mts` (it ejects DF0) only with the Amiga switched off, and are announced
    in the conversation.
- **No `git stash`** in shared worktrees. Re-check `git status` before staging; never `git add -A`.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A capture armed late, or a WGATE blip.**
   - The input: a capture armed late, which missed the first sync pulse, or a WGATE blip.
   - Expected: it is refused by the 16-cell sync check and never parsed as a batch.
   - The test: `a_capture_that_missed_the_first_sync_pulse_is_refused` (Task 3).
2. **The board has not finished decoding when the Amiga reads side 1.**
   - Expected: NetLoop counts the old echo as stale and reads again, never as a mismatch.
   - The test: `only_this_rounds_echo_answers` (Task 8).
3. **NetLoop is restarted, or the A500 reset with Ctrl-A-A, while the board keeps the previous run's counters.**
   - Expected: the first round must not hit the board's "resend" rule and be judged against an old echo.
   - The tests: `a_restart_resyncs_from_the_boards_counter` (Task 8) and `counters_follow_paulanet` (Task 4).
4. **A batch too big for the echo store, or an echo too big for DF1's 14,336-byte stream buffer.**
   - Expected: it is refused cleanly (`PNET_E_FULL`, or a builder returning 0), and neither buffer is written past.
   - The test: `what_does_not_fit_is_refused` (Task 2).
5. **Malformed RLE:** a truncated literal block, a repeat with no byte, a zero control byte mid-stream.
   - Expected: the decoder returns -1 or skips the pad, and never reads past `n` or writes past `cap`.
   - The test: `rle_decoder_refuses_what_it_cannot_finish` (Task 1).

## File structure

| File | Responsibility |
|---|---|
| `wifi-floppy/firmware/src/pnet_mfm.{h,c}` (new) | PaulaNET's per-byte MFM, the XOR checksum, the RLE. Pure; board, host and 68000 |
| `wifi-floppy/firmware/src/pnet_frame.{h,c}` (new) | The cylinder-77 wire format both ways: build, parse, find the sync, bit-align. Pure; board, host and 68000 |
| `wifi-floppy/firmware/src/pnet_rx.{h,c}` (new) | Flux intervals to raw cells, with the pulse low time learned from the sync. Pure; board and host |
| `wifi-floppy/firmware/src/pnet_loop.{h,c}` (new) | The loopback's decisions: DF1 per track, WPROT, whose write, counters. Pure; board and host |
| `wifi-floppy/firmware/test/test_pnet_{mfm,frame,rx,loop}.c` (new) | Host tests, run by `test/run.sh` |
| `wifi-floppy/firmware/src/flux_capture.{h,c}` | `+` a raw-capture mode, all under `#if WF_PNET_LOOP` |
| `wifi-floppy/firmware/src/main.c` | `+` WGATE on SEL1, WPROT on step, take/serve/log on core0, all under `#if WF_PNET_LOOP` |
| `wifi-floppy/firmware/CMakeLists.txt` | `+` option `WF_PNET_LOOP` (OFF) |
| `wifi-floppy/firmware/tools/pnet_off_identical.sh` (new) | Proves that OFF preprocesses to master's text |
| `src/lib/firmware-manifest.ts`, `.test.ts` | `+` refuse the `wf-pnet-loop-test` marker unless the notes say TEST build |
| `tools/netloop/{netloop.c,netloop_stats.{h,c},test_netloop_stats.c,build.sh}` (new) | The Amiga tool, its pure helpers, their host test, and the reproducible build plus ADF |
| `THIRD-PARTY-NOTICES.md`, `.gitignore`, `HANDOFF.md` | Credit, ignore `build-offcheck/`, record the results |

Work on a branch `feat/paulanet-phase0` in a worktree (see the memory note on worktree setup for e2e; no e2e is
needed here, as the only web-side change is covered by vitest).

---

### Task 1: PaulaNET byte codecs (`pnet_mfm`) and the credit

**Files:**
- Create: `wifi-floppy/firmware/src/pnet_mfm.h`, `wifi-floppy/firmware/src/pnet_mfm.c`
- Test: `wifi-floppy/firmware/test/test_pnet_mfm.c`
- Modify: `THIRD-PARTY-NOTICES.md` (new section after "Software included in this repository")

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `size_t pnet_mfm_encode(const uint8_t *src, size_t n, uint8_t *dst, uint16_t *last)`
  - `void pnet_mfm_decode(const uint8_t *src, size_t n, uint8_t *dst)`
  - `uint16_t pnet_checksum(const uint8_t *p, size_t len)`
  - `size_t pnet_rle_bound(size_t n)`
  - `size_t pnet_rle_encode(const uint8_t *src, size_t n, uint8_t *dst)`
  - `long pnet_rle_decode(const uint8_t *src, size_t n, uint8_t *dst, size_t cap)`

- [ ] **Step 1: Write the failing test** at `wifi-floppy/firmware/test/test_pnet_mfm.c`. The GOLDEN values are the
  output of Rob's reference encoders at `0afd5fa`, captured on 2026-10-09. They are data, not his code.

```c
#include "harness.h"
#include "../src/pnet_mfm.h"
#include <stdint.h>
#include <string.h>

/*
 * PaulaNET's byte codecs. Vectors marked GOLDEN are the OUTPUT of RobSmithDev's reference
 * encoders (PaulaNET 0afd5fa: Pico/PaulaNET/rleCompression.cpp and the Pico's mfmEncode), run on
 * a host on 2026-10-09. No code of his is here. PaulaNET protocol (C) 2026 RobSmithDev, used with
 * permission (THIRD-PARTY-NOTICES.md).
 */

static void xorshift_fill(uint8_t *out, size_t len, uint32_t seed) {
    uint32_t x = seed;
    for (size_t i = 0; i < len; i++) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        out[i] = (uint8_t)(x & 0xffu);
    }
}

static void mfm_matches_the_reference_encoder(void) {   /* GOLDEN */
    const uint8_t in[] = {0x00, 0xFF, 0x54, 0x50, 0xA5, 0x01};
    const uint8_t want[] = {0xAA, 0xAA, 0x55, 0x55, 0x2A, 0x54, 0xAA, 0x52, 0x52, 0xA5, 0x2A, 0xA9};
    uint8_t out[sizeof want];
    uint16_t last = 0;
    CHECK_EQ_INT(pnet_mfm_encode(in, sizeof in, out, &last), sizeof want);
    CHECK(memcmp(out, want, sizeof want) == 0, "MFM words differ from PaulaNET's encoder");
    CHECK_EQ_INT(last, 0x2AA9);
}

static void mfm_decodes_every_byte_back(void) {
    uint8_t in[256], enc[512], back[256];
    uint16_t last = 0;
    for (int i = 0; i < 256; i++) in[i] = (uint8_t)i;
    pnet_mfm_encode(in, 256, enc, &last);
    pnet_mfm_decode(enc, 256, back);
    CHECK(memcmp(in, back, 256) == 0, "decode(encode(b)) != b");
}

/* Legal MFM across word boundaries: never two 1 cells together, never four 0 cells in a row. */
static void mfm_output_is_legal_mfm(void) {
    uint8_t in[600], enc[1200];
    uint16_t last = 0;
    xorshift_fill(in, sizeof in, 99u);
    pnet_mfm_encode(in, sizeof in, enc, &last);
    int prev = 0, zeros = 0, bad = 0;
    for (size_t b = 0; b < sizeof enc * 8u; b++) {
        const int bit = (enc[b >> 3] >> (7u - (b & 7u))) & 1;
        if (bit) { if (prev) bad++; zeros = 0; }
        else if (++zeros > 3) bad++;
        prev = bit;
    }
    CHECK_EQ_INT(bad, 0);
}

static void checksum_is_the_xor_of_big_endian_words(void) {
    const uint8_t a[] = {0x12, 0x34, 0x56, 0x78};
    CHECK_EQ_INT(pnet_checksum(a, 4), 0x444C);
    const uint8_t b[] = {0xAB};
    CHECK_EQ_INT(pnet_checksum(b, 1), 0xAB00);
    CHECK_EQ_INT(pnet_checksum(a, 0), 0);
}

static void check_rle(const uint8_t *in, size_t n, const uint8_t *want, size_t wn, const char *what) {
    uint8_t out[2048], back[2048];
    const size_t got = pnet_rle_encode(in, n, out);
    CHECK_EQ_INT(got, wn);
    CHECK(got == wn && memcmp(out, want, wn) == 0, what);
    CHECK_EQ_INT(pnet_rle_decode(out, got, back, sizeof back), (long)n);
    CHECK(memcmp(back, in, n) == 0, "decode(encode(x)) != x");
}

static void rle_matches_the_reference_encoder(void) {   /* GOLDEN */
    const uint8_t r1[] = {1, 2, 3, 3, 3, 3, 0, 0, 0, 0, 0, 9};
    const uint8_t w1[] = {0x82, 0x01, 0x02, 0x04, 0x03, 0x05, 0x00, 0x81, 0x09, 0x00};
    check_rle(r1, sizeof r1, w1, sizeof w1, "mixed literals and runs");
    const uint8_t r2[] = {7};
    const uint8_t w2[] = {0x81, 0x07};
    check_rle(r2, sizeof r2, w2, sizeof w2, "one byte");
    uint8_t r3[300];
    memset(r3, 0xAB, sizeof r3);
    const uint8_t w3[] = {0x7F, 0xAB, 0x7F, 0xAB, 0x2E, 0xAB};
    check_rle(r3, sizeof r3, w3, sizeof w3, "a 300-byte run splits at 127");
    const uint8_t r5[] = {5, 5, 6, 6, 7};
    const uint8_t w5[] = {0x85, 0x05, 0x05, 0x06, 0x06, 0x07};
    check_rle(r5, sizeof r5, w5, sizeof w5, "pairs stay literal");
}

static void rle_literal_blocks_split_at_127(void) {   /* GOLDEN: 130 distinct bytes */
    uint8_t in[130], out[256];
    for (int i = 0; i < 130; i++) in[i] = (uint8_t)(i * 7 + 1);
    const size_t n = pnet_rle_encode(in, sizeof in, out);
    CHECK_EQ_INT(n, 132);
    CHECK_EQ_INT(out[0], 0xFF);
    CHECK_EQ_INT(out[128], 0x83);
    CHECK(memcmp(out + 1, in, 127) == 0 && memcmp(out + 129, in + 127, 3) == 0, "literal bytes");
}

static void rle_of_random_data_matches_and_fits_the_bound(void) {   /* GOLDEN */
    uint8_t in[1500], out[1600], back[1500];
    xorshift_fill(in, sizeof in, 0x12345678u);
    const size_t n = pnet_rle_encode(in, sizeof in, out);
    CHECK_EQ_INT(n, 1512);
    CHECK(out[0] == 0xFF && out[1] == 0xA5 && out[n - 2] == 0xC5 && out[n - 1] == 0x54,
          "head or tail differs from PaulaNET's encoder");
    CHECK(n <= pnet_rle_bound(sizeof in), "over pnet_rle_bound");
    CHECK_EQ_INT(pnet_rle_decode(out, n, back, sizeof back), 1500);
    CHECK(memcmp(back, in, sizeof in) == 0, "round trip");
}

/* Review Focus 5: malformed RLE never reads past n or writes past cap. */
static void rle_decoder_refuses_what_it_cannot_finish(void) {
    uint8_t out[16];
    const uint8_t trunc_lit[] = {0x85, 1, 2};            /* says 5 literals, has 2 */
    CHECK_EQ_INT(pnet_rle_decode(trunc_lit, sizeof trunc_lit, out, sizeof out), -1);
    const uint8_t trunc_run[] = {0x05};                  /* a repeat with no byte to repeat */
    CHECK_EQ_INT(pnet_rle_decode(trunc_run, sizeof trunc_run, out, sizeof out), -1);
    const uint8_t too_big[] = {0x7F, 0x00};              /* 127 bytes into 16 */
    CHECK_EQ_INT(pnet_rle_decode(too_big, sizeof too_big, out, sizeof out), -1);
    const uint8_t padded[] = {0x03, 0x41, 0x00};         /* the even-length pad is skipped */
    CHECK_EQ_INT(pnet_rle_decode(padded, sizeof padded, out, sizeof out), 3);
    CHECK(out[0] == 0x41 && out[1] == 0x41 && out[2] == 0x41, "AAA");
    const uint8_t zero_mid[] = {0x00, 0x82, 0x10, 0x20}; /* a zero control mid-stream is a no-op */
    CHECK_EQ_INT(pnet_rle_decode(zero_mid, sizeof zero_mid, out, sizeof out), 2);
}

int main(void) {
    RUN(mfm_matches_the_reference_encoder);
    RUN(mfm_decodes_every_byte_back);
    RUN(mfm_output_is_legal_mfm);
    RUN(checksum_is_the_xor_of_big_endian_words);
    RUN(rle_matches_the_reference_encoder);
    RUN(rle_literal_blocks_split_at_127);
    RUN(rle_of_random_data_matches_and_fits_the_bound);
    RUN(rle_decoder_refuses_what_it_cannot_finish);
    return REPORT();
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E 'test_pnet_mfm|COMPILE FAIL'; echo "exit ${PIPESTATUS[0]}"`
Expected: `COMPILE FAIL: test_pnet_mfm.c` (no `pnet_mfm.h`), `exit 1`.

- [ ] **Step 3: Write the header** `wifi-floppy/firmware/src/pnet_mfm.h`

```c
#ifndef PNET_MFM_H
#define PNET_MFM_H
/*
 * PaulaNET's three byte-level codecs: per-byte MFM, the XOR checksum and the RLE.
 *
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09; THIRD-PARTY-NOTICES.md). This file implements
 * the protocol from its description and contains none of his code. The GOLDEN vectors in
 * test/test_pnet_mfm.c are the output of his reference encoders.
 *
 * Pure C, no pico-sdk and no unaligned 16/32-bit access (a 68000 takes an address error on one):
 * the same file is compiled into the board (WF_PNET_LOOP builds), the host tests, and the Amiga
 * tool tools/netloop. Byte order is explicit: the wire carries 16-bit words, high byte first.
 */
#include <stdint.h>
#include <stddef.h>

/* One byte -> one 16-bit MFM word, written high byte first (2 bytes per input byte). The data
 * bits sit at the 0x5555 positions in PaulaNET's order b7 b5 b3 b1 b6 b4 b2 b0 (word bits 14 12
 * 10 8 6 4 2 0). A clock bit (0xAAAA positions) is 1 exactly when the data bits either side of it
 * are both 0; the clock before bit 14 looks at bit 0 of the previous word, *last (0 to start a
 * chunk). Returns the bytes written, 2 * n. */
size_t pnet_mfm_encode(const uint8_t *src, size_t n, uint8_t *dst, uint16_t *last);

/* The inverse: n output bytes from 2 * n input bytes. Clock bits are ignored. */
void pnet_mfm_decode(const uint8_t *src, size_t n, uint8_t *dst);

/* XOR of the big-endian 16-bit words of p[0..len). An odd last byte counts as a high half. */
uint16_t pnet_checksum(const uint8_t *p, size_t len);

/* PaulaNET RLE. Control byte, then data:
 *   bit 7 set:   the low 7 bits (1..127) count literal bytes that follow;
 *   bit 7 clear: the low 7 bits (3..127) count repeats of the one byte that follows.
 * Runs of 3 or more equal bytes become repeats; shorter runs join a literal block. The output is
 * padded to an even length with one 0x00 control byte, which the decoder skips. */
size_t pnet_rle_bound(size_t n);           /* worst-case encoded size of n bytes */
size_t pnet_rle_encode(const uint8_t *src, size_t n, uint8_t *dst);
/* Decoded length, or -1 if the input ends inside a block or the output would pass `cap`. */
long   pnet_rle_decode(const uint8_t *src, size_t n, uint8_t *dst, size_t cap);
#endif
```

- [ ] **Step 4: Write the implementation** `wifi-floppy/firmware/src/pnet_mfm.c`

```c
/* PaulaNET protocol (C) 2026 RobSmithDev, used with permission -- see pnet_mfm.h. */
#include "pnet_mfm.h"
#include <string.h>

size_t pnet_mfm_encode(const uint8_t *src, size_t n, uint8_t *dst, uint16_t *last) {
    uint16_t prev = *last;
    for (size_t i = 0; i < n; i++) {
        const uint8_t b = src[i];
        uint16_t w = (uint16_t)(((b & 0xAAu) << 7) | (b & 0x55u));
        // Every clock position whose two neighbouring data bits are both 0 gets a 1. The
        // neighbours of clock bit k are data bits k+1 and k-1; bit 15's lower neighbour is the
        // previous word's bit 0.
        const uint16_t nb = (uint16_t)((w << 1) | (w >> 1) | (prev << 15));
        w = (uint16_t)(w | (~nb & 0xAAAAu));
        dst[2 * i]     = (uint8_t)(w >> 8);
        dst[2 * i + 1] = (uint8_t)w;
        prev = w;
    }
    *last = prev;
    return 2 * n;
}

void pnet_mfm_decode(const uint8_t *src, size_t n, uint8_t *dst) {
    for (size_t i = 0; i < n; i++) {
        const uint16_t d = (uint16_t)(((src[2 * i] << 8) | src[2 * i + 1]) & 0x5555u);
        dst[i] = (uint8_t)((d >> 7) | d);
    }
}

uint16_t pnet_checksum(const uint8_t *p, size_t len) {
    uint16_t c = 0;
    for (size_t i = 0; i < len; i += 2)
        c ^= (uint16_t)((p[i] << 8) | (i + 1 < len ? p[i + 1] : 0));
    return c;
}

size_t pnet_rle_bound(size_t n) { return n + n / 127u + 2u; }

/* Equal bytes starting at i, at most 127. */
static size_t run_at(const uint8_t *s, size_t n, size_t i) {
    size_t r = 1;
    while (i + r < n && r < 127u && s[i + r] == s[i]) r++;
    return r;
}

size_t pnet_rle_encode(const uint8_t *src, size_t n, uint8_t *dst) {
    size_t i = 0, o = 0;
    while (i < n) {
        size_t r = run_at(src, n, i);
        if (r >= 3u) {
            dst[o++] = (uint8_t)r;
            dst[o++] = src[i];
            i += r;
            continue;
        }
        const size_t hdr = o++;
        size_t lit = 0;
        while (i < n && lit < 127u) {
            r = run_at(src, n, i);
            if (r >= 3u) break;                   // better as a repeat
            if (lit + r > 127u) r = 127u - lit;   // a pair split by the block limit
            memcpy(&dst[o], &src[i], r);
            o += r; i += r; lit += r;
        }
        dst[hdr] = (uint8_t)(0x80u | lit);
    }
    if (o & 1u) dst[o++] = 0;                     // even length: one no-op control byte
    return o;
}

long pnet_rle_decode(const uint8_t *src, size_t n, uint8_t *dst, size_t cap) {
    size_t i = 0, o = 0;
    while (i < n) {
        const uint8_t c = src[i++];
        const size_t k = c & 0x7Fu;
        if (k == 0) continue;                     // the even-length pad
        if (k > cap - o) return -1;
        if (c & 0x80u) {
            if (k > n - i) return -1;
            memcpy(&dst[o], &src[i], k);
            i += k;
        } else {
            if (i >= n) return -1;
            memset(&dst[o], src[i++], k);
        }
        o += k;
    }
    return (long)o;
}
```

- [ ] **Step 5: Run the suite**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E 'pnet|FAIL|CRASH'; wifi-floppy/firmware/test/run.sh >/dev/null 2>&1; echo "exit $?"`
Expected: `test_pnet_mfm.c: 39 checks, 0 failed`, no FAIL lines, `exit 0`.

- [ ] **Step 6: Credit Rob in `THIRD-PARTY-NOTICES.md`.** Insert this section directly before the line
  `## Software included in this repository`:

```markdown
## Protocols used with permission

- **PaulaNET** by RobSmithDev (https://github.com/RobSmithDev/PaulaNET), Copyright (C) 2026 RobSmithDev: Amiga
  networking over the floppy port -- the cylinder 75/76/77 track map, the side and write-protect signalling, the
  DataHeader/PacketsHeader/CompressionHeader layouts, the counter-and-acknowledge scheme and the RLE format. Used with
  the author's permission (2026-10-09), granted on the condition that the licences are respected and he is credited.
  The firmware's `pnet_*` sources and `tools/netloop/` implement the protocol from its description; none of his code
  is included. The golden test vectors in `wifi-floppy/firmware/test/test_pnet_mfm.c` are the output of his
  reference encoders.
```

- [ ] **Step 7: Commit**

```bash
git add wifi-floppy/firmware/src/pnet_mfm.h wifi-floppy/firmware/src/pnet_mfm.c \
        wifi-floppy/firmware/test/test_pnet_mfm.c THIRD-PARTY-NOTICES.md
git commit -m "feat(fw): PaulaNET byte codecs -- per-byte MFM, checksum, RLE (host-tested, golden vectors)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The cylinder-77 wire format (`pnet_frame`)

**Files:**
- Create: `wifi-floppy/firmware/src/pnet_frame.h`, `wifi-floppy/firmware/src/pnet_frame.c`
- Test: `wifi-floppy/firmware/test/test_pnet_frame.c`

**Interfaces:**
- Consumes (Task 1): `pnet_mfm_encode`, `pnet_mfm_decode`, `pnet_checksum`, `pnet_rle_bound`, `pnet_rle_encode`,
  `pnet_rle_decode`.
- Produces, used by Tasks 3, 4, 7 and 8:
  - Constants: `PNET_CYL` (77), `PNET_TRACK_IN` (154), `PNET_TRACK_OUT` (155), `PNET_HDR_BYTES` (12),
    `PNET_HDR_MFM_BYTES` (24), `PNET_LEAD_BYTES` (120), `PNET_TRAIL_BYTES` (120), `PNET_ETH_MTU` (1518),
    `PNET_MAX_FRAMES` (20), `PNET_MODE_ETHERNET` (3).
  - Types: `pnet_dir_t` (`PNET_TO_BOARD`, `PNET_TO_AMIGA`); `pnet_err_t` (`PNET_OK` .. `PNET_E_NOSYNC`, then
    `PNET_E_COUNT`); `pnet_hdr_t {checksum, data_size, compressed_size, mode, compressed, amiga_ctr, pico_ctr}`;
    `pnet_frame_ref_t {const uint8_t *data; uint16_t len}`.
  - Functions:
    - `const char *pnet_err_text(pnet_err_t)`
    - `size_t pnet_payload_bound(const uint16_t *lens, unsigned n)`
    - `size_t pnet_to_amiga_bound(const uint16_t *lens, unsigned n)`
    - `size_t pnet_build_to_board(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr, const pnet_frame_ref_t *f, unsigned n)`
    - `size_t pnet_build_to_amiga(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr, uint8_t flags, const pnet_frame_ref_t *f, unsigned n)`
    - `pnet_err_t pnet_parse_hdr_from_amiga(const uint8_t *b, size_t len, pnet_hdr_t *h)`
    - `pnet_err_t pnet_parse_hdr_to_amiga(const uint8_t *b, size_t len, pnet_hdr_t *h, bool with_payload)`
    - `pnet_err_t pnet_parse_frames(const uint8_t *p, size_t len, pnet_dir_t dir, uint8_t *out, size_t cap, uint16_t *lens, unsigned max, unsigned *n)`
    - `long pnet_find_sync(const uint8_t *b, size_t len, size_t scan)`
    - `size_t pnet_shift_left(uint8_t *b, size_t len, size_t bits)`

- [ ] **Step 1: Write the failing test** `wifi-floppy/firmware/test/test_pnet_frame.c`

```c
#include "harness.h"
#include "../src/pnet_frame.h"
#include "../src/pnet_mfm.h"
#include <stdint.h>
#include <string.h>

/* PaulaNET's cylinder-77 wire format, both directions. PaulaNET protocol (C) 2026 RobSmithDev,
 * used with permission. */

static uint8_t payload[12000], out[20000], dec[16384];

static void xorshift_fill(uint8_t *p, size_t len, uint32_t seed) {
    uint32_t x = seed;
    for (size_t i = 0; i < len; i++) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; p[i] = (uint8_t)x; }
}

/* Three frames: 64 random bytes, 1500 random bytes, 7 zero bytes. */
static unsigned three_frames(pnet_frame_ref_t *f, uint16_t *lens) {
    xorshift_fill(payload, 1564, 0xC0FFEEu);
    memset(payload + 1564, 0, 7);
    lens[0] = 64; lens[1] = 1500; lens[2] = 7;
    f[0].data = payload;        f[0].len = 64;
    f[1].data = payload + 64;   f[1].len = 1500;
    f[2].data = payload + 1564; f[2].len = 7;
    return 3;
}

static void to_board_header_is_raw_and_checks_out(void) {
    pnet_frame_ref_t f[3]; uint16_t lens[3];
    const unsigned n = three_frames(f, lens);
    const size_t w = pnet_build_to_board(out, sizeof out, 0x05, 0x80, f, n);
    CHECK(w > 0, "built");
    CHECK(out[0] == 0x00 && out[1] == 0x01 && out[2] == 0x00 && out[3] == 0x01, "sync 00 01 00 01");
    CHECK(out[4] == 0x54 && out[5] == 0x50, "raw magic, big-endian");
    CHECK_EQ_INT(out[12], PNET_MODE_ETHERNET);
    CHECK_EQ_INT(out[13], 0x42);   /* 2 "MFM" | 0x40 "from driver", as PaulaNET's driver sends */
    CHECK_EQ_INT(out[14], 0x05);
    CHECK_EQ_INT(out[15], 0x80);
    CHECK(out[w - 2] == 0xAA && out[w - 1] == 0xAA, "AA AA trailer");
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(out + 4, w - 4, &h), PNET_OK);
    CHECK_EQ_INT(h.compressed_size, w - 4 - PNET_HDR_BYTES - 2);
    CHECK_EQ_INT(h.data_size, h.compressed_size);
}

static void to_board_frames_round_trip(void) {
    pnet_frame_ref_t f[3]; uint16_t lens[3], got[PNET_MAX_FRAMES];
    const unsigned n = three_frames(f, lens);
    const size_t w = pnet_build_to_board(out, sizeof out, 1, 2, f, n);
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(out + 4, w - 4, &h), PNET_OK);
    unsigned m = 0;
    CHECK_EQ_INT(pnet_parse_frames(out + 4 + PNET_HDR_BYTES, h.compressed_size, PNET_TO_BOARD,
                                   dec, sizeof dec, got, PNET_MAX_FRAMES, &m), PNET_OK);
    CHECK_EQ_INT(m, 3);
    CHECK(got[0] == 64 && got[1] == 1500 && got[2] == 7, "lengths");
    CHECK(memcmp(dec, payload, 1571) == 0, "bytes");
}

static void a_damaged_batch_is_refused(void) {
    pnet_frame_ref_t f[3]; uint16_t lens[3];
    const unsigned n = three_frames(f, lens);
    const size_t w = pnet_build_to_board(out, sizeof out, 1, 2, f, n);
    pnet_hdr_t h;
    out[40] ^= 0x10;
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(out + 4, w - 4, &h), PNET_E_CHECKSUM);
    out[40] ^= 0x10;
    out[4] = 0x55;
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(out + 4, w - 4, &h), PNET_E_MAGIC);
    out[4] = 0x54;
    /* PaulaNET's receiver wants MORE than header + payload: exactly that much is refused */
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(out + 4, PNET_HDR_BYTES + h.compressed_size, &h),
                 PNET_E_SIZE);
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(out + 4, 11, &h), PNET_E_SHORT);
}

static void to_amiga_track_has_lead_in_sync_and_words(void) {
    pnet_frame_ref_t f[3]; uint16_t lens[3];
    const unsigned n = three_frames(f, lens);
    const size_t w = pnet_build_to_amiga(out, sizeof out, 0x05, 0x81, 0, f, n);
    CHECK(w > 0, "built");
    CHECK_EQ_INT(w % 4, 0);
    CHECK(w <= pnet_to_amiga_bound(lens, n), "within the bound");
    int lead = 1;
    for (unsigned i = 0; i < PNET_LEAD_BYTES; i++) if (out[i] != 0xAA) lead = 0;
    CHECK(lead, "120 x AA lead-in");
    CHECK(out[120] == 0x44 && out[121] == 0x89 && out[122] == 0x44 && out[123] == 0x89, "sync");
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_to_amiga(out + 124, w - 124, &h, true), PNET_OK);
    CHECK_EQ_INT(h.amiga_ctr, 0x05);
    CHECK_EQ_INT(h.pico_ctr, 0x81);
    CHECK_EQ_INT(h.compressed, 0);
    int trail = 1;
    for (size_t i = 124 + 24 + h.data_size; i < w; i++) if (out[i] != 0xAA) trail = 0;
    CHECK(trail && w - (124 + 24 + h.data_size) >= PNET_TRAIL_BYTES, ">= 120 x AA trailer");
    uint16_t got[PNET_MAX_FRAMES]; unsigned m = 0;
    CHECK_EQ_INT(pnet_parse_frames(out + 148, h.data_size, PNET_TO_AMIGA, dec, sizeof dec, got,
                                   PNET_MAX_FRAMES, &m), PNET_OK);
    CHECK(m == 3 && memcmp(dec, payload, 1571) == 0, "frames round trip");
}

/* Bit 15 of a frame's size means RLE toward the board and MFM toward the Amiga. */
static void the_rle_flag_depends_on_the_direction(void) {
    pnet_frame_ref_t f[3]; uint16_t lens[3], got[PNET_MAX_FRAMES];
    const unsigned n = three_frames(f, lens);
    const size_t w = pnet_build_to_amiga(out, sizeof out, 1, 2, 0, f, n);
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_to_amiga(out + 124, w - 124, &h, true), PNET_OK);
    unsigned m = 0;
    CHECK(pnet_parse_frames(out + 148, h.data_size, PNET_TO_BOARD, dec, sizeof dec, got,
                            PNET_MAX_FRAMES, &m) != PNET_OK, "read the wrong way, it must fail");
}

static void an_empty_batch_is_a_bare_header(void) {
    const size_t w = pnet_build_to_amiga(out, sizeof out, 0xFF, 0x7F, 0, NULL, 0);
    CHECK_EQ_INT(w, (120 + 4 + 24 + 120 + 3) & ~3);
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_to_amiga(out + 124, w - 124, &h, true), PNET_OK);
    CHECK_EQ_INT(h.data_size, 0);
    uint16_t got[PNET_MAX_FRAMES]; unsigned m = 9;
    CHECK_EQ_INT(pnet_parse_frames(out + 148, 0, PNET_TO_AMIGA, dec, sizeof dec, got,
                                   PNET_MAX_FRAMES, &m), PNET_OK);
    CHECK_EQ_INT(m, 0);
}

/* The Amiga's read starts anywhere in the lead-in, at any bit. */
static void the_amiga_finds_the_sync_at_any_bit(void) {
    static uint8_t buf[2200];
    pnet_frame_ref_t f[1] = {{payload, 1000}};
    xorshift_fill(payload, 1000, 7u);
    const size_t w = pnet_build_to_amiga(out, sizeof out, 3, 4, 0, f, 1);
    for (unsigned k = 0; k < 16; k++) {
        memset(buf, 0xAA, sizeof buf);
        for (size_t i = 0; i < w * 8; i++) {          /* 5 bytes of lead-in, then k bits late */
            const size_t to = 40 + k + i;
            if ((out[i >> 3] >> (7 - (i & 7))) & 1) buf[to >> 3] |= (uint8_t)(0x80u >> (to & 7));
            else buf[to >> 3] &= (uint8_t)~(0x80u >> (to & 7));
        }
        const long at = pnet_find_sync(buf, w + 8, 512);
        CHECK_EQ_INT(at, 40 + (long)k + 124 * 8);
        const size_t valid = pnet_shift_left(buf, w + 8, (size_t)at);
        pnet_hdr_t h;
        CHECK_EQ_INT(pnet_parse_hdr_to_amiga(buf, valid, &h, true), PNET_OK);
        uint16_t got[PNET_MAX_FRAMES]; unsigned m = 0;
        CHECK_EQ_INT(pnet_parse_frames(buf + 24, h.data_size, PNET_TO_AMIGA, dec, sizeof dec, got,
                                       PNET_MAX_FRAMES, &m), PNET_OK);
        CHECK(m == 1 && got[0] == 1000 && memcmp(dec, payload, 1000) == 0, "frame after alignment");
    }
    memset(buf, 0xAA, sizeof buf);
    CHECK_EQ_INT(pnet_find_sync(buf, sizeof buf, 512), -1);
}

/* Review Focus 4: too big for the store or for DF1's 14,336-byte buffer is refused cleanly. */
static void what_does_not_fit_is_refused(void) {
    pnet_frame_ref_t f[3]; uint16_t lens[3], got[PNET_MAX_FRAMES];
    const unsigned n = three_frames(f, lens);
    CHECK_EQ_INT(pnet_build_to_amiga(out, 1000, 1, 2, 0, f, n), 0);
    CHECK_EQ_INT(pnet_build_to_board(out, 100, 1, 2, f, n), 0);
    const size_t w = pnet_build_to_board(out, sizeof out, 1, 2, f, n);
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(out + 4, w - 4, &h), PNET_OK);
    unsigned m = 0;
    CHECK_EQ_INT(pnet_parse_frames(out + 16, h.compressed_size, PNET_TO_BOARD, dec, 1000, got,
                                   PNET_MAX_FRAMES, &m), PNET_E_FULL);
    CHECK_EQ_INT(pnet_parse_frames(out + 16, h.compressed_size, PNET_TO_BOARD, dec, sizeof dec, got,
                                   2, &m), PNET_E_FRAMES);
    pnet_frame_ref_t big = {payload, PNET_ETH_MTU + 1};
    CHECK_EQ_INT(pnet_build_to_board(out, sizeof out, 1, 2, &big, 1), 0);
    /* 12,000 bytes in 8 frames, the largest NetLoop sends, fits DF1's 14,336-byte buffer */
    pnet_frame_ref_t g[8]; uint16_t gl[8];
    xorshift_fill(payload, 12000, 3u);
    for (unsigned i = 0; i < 8; i++) {
        gl[i] = 1500;
        g[i].data = payload + 1500u * i; g[i].len = gl[i];
    }
    CHECK(pnet_to_amiga_bound(gl, 8) <= 14336u, "12,000 B echo fits DF1's stream buffer");
    CHECK(pnet_build_to_amiga(out, 14336, 1, 2, 0, g, 8) > 0, "and builds into it");
}

static void shift_left_keeps_whole_bytes_only(void) {
    uint8_t b[4] = {0x0F, 0xF0, 0x0F, 0xF0};
    CHECK_EQ_INT(pnet_shift_left(b, 4, 4), 3);
    CHECK(b[0] == 0xFF && b[1] == 0x00 && b[2] == 0xFF, "nibble shift");
    uint8_t c[3] = {1, 2, 3};
    CHECK_EQ_INT(pnet_shift_left(c, 3, 8), 2);
    CHECK(c[0] == 2 && c[1] == 3, "byte shift");
    CHECK_EQ_INT(pnet_shift_left(c, 3, 24), 0);
}

int main(void) {
    RUN(to_board_header_is_raw_and_checks_out);
    RUN(to_board_frames_round_trip);
    RUN(a_damaged_batch_is_refused);
    RUN(to_amiga_track_has_lead_in_sync_and_words);
    RUN(the_rle_flag_depends_on_the_direction);
    RUN(an_empty_batch_is_a_bare_header);
    RUN(the_amiga_finds_the_sync_at_any_bit);
    RUN(what_does_not_fit_is_refused);
    RUN(shift_left_keeps_whole_bytes_only);
    return REPORT();
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E 'test_pnet_frame|COMPILE FAIL'`
Expected: `COMPILE FAIL: test_pnet_frame.c`.

- [ ] **Step 3: Write the header** `wifi-floppy/firmware/src/pnet_frame.h`

```c
#ifndef PNET_FRAME_H
#define PNET_FRAME_H
/*
 * PaulaNET's wire format on cylinder 77, both directions.
 *
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09; THIRD-PARTY-NOTICES.md). Implemented from the
 * protocol's description; none of his code is in this file.
 *
 * Amiga -> board (side 0, ETD_RAWWRITE; pnet_build_to_board):
 *   00 01 00 01      two pulses 16 cells apart: the board times the cell from them
 *   DataHeader       12 bytes RAW, big-endian (this direction does not MFM-encode it)
 *   payload          compressed_size bytes
 *   AA AA            trailer
 * Board -> Amiga (side 1, ETD_RAWREAD + IOTDF_INDEXSYNC; pnet_build_to_amiga):
 *   120 x AA         lead-in for Paula's data separator
 *   44 89 44 89      sync, found by the Amiga in software at any bit offset
 *   DataHeader       12 bytes, MFM-encoded (24 bytes)
 *   payload          data_size bytes
 *   >= 120 x AA      trailer, to a whole number of 32-bit words (the board's DMA unit)
 * DataHeader, big-endian: magic 0x5450, checksum (XOR of the payload's big-endian words),
 *   data_size, compressed_size, mode (3 = Ethernet), compressed (0x42 from the Amiga's driver:
 *   2 "MFM" | 0x40 "from driver"; 0 from the board), amiga counter, pico counter.
 * Payload (empty when there are no frames): PacketsHeader {count, flags}, MFM (4 bytes); then per
 *   frame a CompressionHeader {size, original size}, MFM (8 bytes, each chunk encoded from a
 *   clean start), then `size` bytes of RLE (or of MFM), padded to even. Bit 15 of `size` means
 *   RLE toward the board, but MFM toward the Amiga -- the two directions disagree, so the
 *   direction is a parameter (pnet_dir_t), never a guess.
 */
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#define PNET_CYL             77
#define PNET_TRACK_IN        (PNET_CYL * 2)       /* 154: side 0, the Amiga writes */
#define PNET_TRACK_OUT       (PNET_CYL * 2 + 1)   /* 155: side 1, the Amiga reads */
#define PNET_MAGIC           0x5450u
#define PNET_MODE_ETHERNET   3u
#define PNET_FROM_DRIVER     0x40u
#define PNET_COMPRESSED_MFM  2u
#define PNET_HDR_BYTES       12u
#define PNET_HDR_MFM_BYTES   24u
#define PNET_LEAD_BYTES      120u
#define PNET_TRAIL_BYTES     120u
#define PNET_SYNC_WORDS      0x44894489u
#define PNET_ETH_MTU         1518u
#define PNET_MAX_FRAMES      20u

typedef enum { PNET_TO_BOARD, PNET_TO_AMIGA } pnet_dir_t;

typedef enum {
    PNET_OK = 0, PNET_E_SHORT, PNET_E_MAGIC, PNET_E_MODE, PNET_E_SIZE, PNET_E_CHECKSUM,
    PNET_E_FRAMES, PNET_E_FRAME_SIZE, PNET_E_RLE, PNET_E_FULL, PNET_E_NOSYNC, PNET_E_COUNT
} pnet_err_t;
const char *pnet_err_text(pnet_err_t e);

typedef struct {
    uint16_t checksum, data_size, compressed_size;
    uint8_t  mode, compressed, amiga_ctr, pico_ctr;
} pnet_hdr_t;

typedef struct { const uint8_t *data; uint16_t len; } pnet_frame_ref_t;

/* Worst-case payload bytes for frames of these lengths (0 for none). */
size_t pnet_payload_bound(const uint16_t *lens, unsigned n);
/* Worst-case length of a whole board -> Amiga track for these frames. */
size_t pnet_to_amiga_bound(const uint16_t *lens, unsigned n);

/* Both builders return the bytes written, or 0 when `cap` might not hold the result, when n is
 * over PNET_MAX_FRAMES, or a frame is empty or over PNET_ETH_MTU. Frames go out RLE. */
size_t pnet_build_to_board(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr,
                           const pnet_frame_ref_t *f, unsigned n);
size_t pnet_build_to_amiga(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr,
                           uint8_t flags, const pnet_frame_ref_t *f, unsigned n);

/* Board side: `b` is the capture from the first bit after the 00 01 00 01 sync. Checks magic,
 * mode, size (12 + compressed_size must be LESS than len, as PaulaNET's receiver requires) and
 * checksum. The payload is then at b + PNET_HDR_BYTES, h->compressed_size bytes. */
pnet_err_t pnet_parse_hdr_from_amiga(const uint8_t *b, size_t len, pnet_hdr_t *h);

/* Amiga side: `b` is aligned at the first bit after the 44 89 44 89 sync. With with_payload,
 * also checks that data_size payload bytes follow the 24 header bytes and their checksum. */
pnet_err_t pnet_parse_hdr_to_amiga(const uint8_t *b, size_t len, pnet_hdr_t *h, bool with_payload);

/* Decodes a payload's frames, back to back, into out[0..cap). lens[i] is frame i's length; *n
 * the count. PNET_E_FULL when they would not fit `cap`. */
pnet_err_t pnet_parse_frames(const uint8_t *p, size_t len, pnet_dir_t dir, uint8_t *out,
                             size_t cap, uint16_t *lens, unsigned max, unsigned *n);

/* The bit offset just past 44 89 44 89, when the sync STARTS within b[0..scan); -1 if absent. */
long pnet_find_sync(const uint8_t *b, size_t len, size_t scan);

/* Shifts b left by `bits` in place: b[i] takes the 8 bits from bit offset bits + 8i. Returns
 * how many leading bytes are whole afterwards. */
size_t pnet_shift_left(uint8_t *b, size_t len, size_t bits);
#endif
```

- [ ] **Step 4: Write the implementation** `wifi-floppy/firmware/src/pnet_frame.c`

```c
/* PaulaNET protocol (C) 2026 RobSmithDev, used with permission -- see pnet_frame.h. */
#include "pnet_frame.h"
#include "pnet_mfm.h"
#include <string.h>

const char *pnet_err_text(pnet_err_t e) {
    static const char *const t[PNET_E_COUNT] = {
        "ok", "short", "magic", "mode", "size", "checksum",
        "frames", "frame size", "rle", "full", "no sync",
    };
    return (unsigned)e < PNET_E_COUNT ? t[e] : "?";
}

static void put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }
static uint16_t get16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }

static void hdr_pack(const pnet_hdr_t *h, uint8_t *b) {
    put16(b, PNET_MAGIC);
    put16(b + 2, h->checksum);
    put16(b + 4, h->data_size);
    put16(b + 6, h->compressed_size);
    b[8] = h->mode; b[9] = h->compressed; b[10] = h->amiga_ctr; b[11] = h->pico_ctr;
}

/* False if the magic is wrong; the fields are filled either way. */
static bool hdr_unpack(const uint8_t *b, pnet_hdr_t *h) {
    h->checksum = get16(b + 2);
    h->data_size = get16(b + 4);
    h->compressed_size = get16(b + 6);
    h->mode = b[8]; h->compressed = b[9]; h->amiga_ctr = b[10]; h->pico_ctr = b[11];
    return get16(b) == PNET_MAGIC;
}

size_t pnet_payload_bound(const uint16_t *lens, unsigned n) {
    if (n == 0) return 0;
    size_t b = 4;
    for (unsigned i = 0; i < n; i++) b += 8u + pnet_rle_bound(lens[i]);
    return b;
}

size_t pnet_to_amiga_bound(const uint16_t *lens, unsigned n) {
    return PNET_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + pnet_payload_bound(lens, n)
         + PNET_TRAIL_BYTES + 3u;
}

/* The payload bound for frame refs; SIZE_MAX if any is unsendable. */
static size_t refs_bound(const pnet_frame_ref_t *f, unsigned n) {
    if (n > PNET_MAX_FRAMES) return SIZE_MAX;
    if (n == 0) return 0;
    size_t b = 4;
    for (unsigned i = 0; i < n; i++) {
        if (f[i].len == 0 || f[i].len > PNET_ETH_MTU) return SIZE_MAX;
        b += 8u + pnet_rle_bound(f[i].len);
    }
    return b;
}

static size_t put_payload(uint8_t *p, pnet_dir_t dir, uint8_t flags,
                          const pnet_frame_ref_t *f, unsigned n) {
    const uint8_t ph[2] = { (uint8_t)n, flags };
    uint16_t last = 0;
    size_t pos = pnet_mfm_encode(ph, 2, p, &last);
    for (unsigned i = 0; i < n; i++) {
        const size_t r = pnet_rle_encode(f[i].data, f[i].len, p + pos + 8);   // even: padded
        uint16_t size = (uint16_t)r;
        if (dir == PNET_TO_BOARD) size |= 0x8000u;    // toward the board, bit 15 means RLE
        uint8_t ch[4];
        put16(ch, size);
        put16(ch + 2, f[i].len);
        last = 0;                                     // each header from a clean start
        pnet_mfm_encode(ch, 4, p + pos, &last);
        pos += 8u + r;
    }
    return pos;
}

size_t pnet_build_to_board(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr,
                           const pnet_frame_ref_t *f, unsigned n) {
    const size_t pb = refs_bound(f, n);
    if (pb == SIZE_MAX || 4u + PNET_HDR_BYTES + pb + 2u > cap) return 0;
    out[0] = 0x00; out[1] = 0x01; out[2] = 0x00; out[3] = 0x01;
    uint8_t *pay = out + 4 + PNET_HDR_BYTES;
    const size_t plen = n ? put_payload(pay, PNET_TO_BOARD, 0, f, n) : 0;
    const pnet_hdr_t h = {
        .checksum = pnet_checksum(pay, plen), .data_size = (uint16_t)plen,
        .compressed_size = (uint16_t)plen, .mode = PNET_MODE_ETHERNET,
        .compressed = PNET_COMPRESSED_MFM | PNET_FROM_DRIVER,
        .amiga_ctr = amiga_ctr, .pico_ctr = pico_ctr,
    };
    hdr_pack(&h, out + 4);                            // RAW in this direction
    size_t pos = 4u + PNET_HDR_BYTES + plen;
    out[pos++] = 0xAA;
    out[pos++] = 0xAA;
    return pos;
}

size_t pnet_build_to_amiga(uint8_t *out, size_t cap, uint8_t amiga_ctr, uint8_t pico_ctr,
                           uint8_t flags, const pnet_frame_ref_t *f, unsigned n) {
    const size_t pb = refs_bound(f, n);
    if (pb == SIZE_MAX ||
        PNET_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + pb + PNET_TRAIL_BYTES + 3u > cap) return 0;
    memset(out, 0xAA, PNET_LEAD_BYTES);
    uint8_t *s = out + PNET_LEAD_BYTES;
    s[0] = 0x44; s[1] = 0x89; s[2] = 0x44; s[3] = 0x89;
    uint8_t *pay = s + 4 + PNET_HDR_MFM_BYTES;
    const size_t plen = n ? put_payload(pay, PNET_TO_AMIGA, flags, f, n) : 0;
    const pnet_hdr_t h = {
        .checksum = pnet_checksum(pay, plen), .data_size = (uint16_t)plen,
        .compressed_size = (uint16_t)plen, .mode = PNET_MODE_ETHERNET, .compressed = 0,
        .amiga_ctr = amiga_ctr, .pico_ctr = pico_ctr,
    };
    uint8_t raw[PNET_HDR_BYTES];
    hdr_pack(&h, raw);
    uint16_t last = 0;
    pnet_mfm_encode(raw, PNET_HDR_BYTES, s + 4, &last);   // MFM in this direction
    const size_t pos = (size_t)(pay - out) + plen;
    const size_t end = (pos + PNET_TRAIL_BYTES + 3u) & ~(size_t)3u;
    memset(out + pos, 0xAA, end - pos);
    return end;
}

pnet_err_t pnet_parse_hdr_from_amiga(const uint8_t *b, size_t len, pnet_hdr_t *h) {
    if (len < PNET_HDR_BYTES) return PNET_E_SHORT;
    if (!hdr_unpack(b, h)) return PNET_E_MAGIC;
    if (h->mode != PNET_MODE_ETHERNET) return PNET_E_MODE;
    if ((h->compressed_size & 1u) || PNET_HDR_BYTES + (size_t)h->compressed_size >= len)
        return PNET_E_SIZE;
    if (pnet_checksum(b + PNET_HDR_BYTES, h->compressed_size) != h->checksum)
        return PNET_E_CHECKSUM;
    return PNET_OK;
}

pnet_err_t pnet_parse_hdr_to_amiga(const uint8_t *b, size_t len, pnet_hdr_t *h, bool with_payload) {
    if (len < PNET_HDR_MFM_BYTES) return PNET_E_SHORT;
    uint8_t raw[PNET_HDR_BYTES];
    pnet_mfm_decode(b, PNET_HDR_BYTES, raw);
    if (!hdr_unpack(raw, h)) return PNET_E_MAGIC;
    if (h->mode != PNET_MODE_ETHERNET) return PNET_E_MODE;
    if (!with_payload) return PNET_OK;
    if (h->data_size & 1u) return PNET_E_SIZE;
    if (PNET_HDR_MFM_BYTES + (size_t)h->data_size > len) return PNET_E_SHORT;
    if (pnet_checksum(b + PNET_HDR_MFM_BYTES, h->data_size) != h->checksum) return PNET_E_CHECKSUM;
    return PNET_OK;
}

pnet_err_t pnet_parse_frames(const uint8_t *p, size_t len, pnet_dir_t dir, uint8_t *out,
                             size_t cap, uint16_t *lens, unsigned max, unsigned *n) {
    *n = 0;
    if (len == 0) return PNET_OK;
    if (len < 4) return PNET_E_FRAMES;
    uint8_t ph[2];
    pnet_mfm_decode(p, 2, ph);
    const unsigned count = ph[0];
    if (count > max) return PNET_E_FRAMES;
    size_t pos = 4, used = 0;
    for (unsigned i = 0; i < count; i++) {
        if (8u > len - pos) return PNET_E_FRAMES;
        uint8_t ch[4];
        pnet_mfm_decode(p + pos, 4, ch);
        pos += 8u;
        const uint16_t field = get16(ch), os = get16(ch + 2);
        const size_t size = field & 0x7FFFu;
        const bool rle = dir == PNET_TO_BOARD ? (field & 0x8000u) != 0 : (field & 0x8000u) == 0;
        if (size > len - pos) return PNET_E_FRAMES;
        if (os == 0 || os > PNET_ETH_MTU) return PNET_E_FRAME_SIZE;
        if (os > cap - used) return PNET_E_FULL;
        if (rle) {
            if (pnet_rle_decode(p + pos, size, out + used, os) != (long)os) return PNET_E_RLE;
        } else {
            if (size != 2u * os) return PNET_E_FRAME_SIZE;
            pnet_mfm_decode(p + pos, os, out + used);
        }
        lens[i] = os;
        used += os;
        pos += size + (size & 1u);
        if (pos > len) pos = len;
    }
    *n = count;
    return PNET_OK;
}

long pnet_find_sync(const uint8_t *b, size_t len, size_t scan) {
    uint32_t reg = 0;
    const size_t limit = scan + 4u < len ? scan + 4u : len;
    for (size_t i = 0; i < limit; i++) {
        for (unsigned k = 0; k < 8u; k++) {
            reg = (reg << 1) | ((b[i] >> (7u - k)) & 1u);
            const size_t bits = i * 8u + k + 1u;
            if (bits >= 32u && reg == PNET_SYNC_WORDS) return (long)bits;
        }
    }
    return -1;
}

size_t pnet_shift_left(uint8_t *b, size_t len, size_t bits) {
    const size_t q = bits >> 3;
    const unsigned r = (unsigned)(bits & 7u);
    if (q >= len) return 0;
    const size_t valid = len - q - (r ? 1u : 0u);
    for (size_t i = 0; i < valid; i++)
        b[i] = r ? (uint8_t)((b[i + q] << r) | (b[i + q + 1] >> (8u - r))) : b[i + q];
    return valid;
}
```

- [ ] **Step 5: Run the suite**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E 'pnet|FAIL|CRASH'; wifi-floppy/firmware/test/run.sh >/dev/null 2>&1; echo "exit $?"`
Expected: `test_pnet_frame.c: 117 checks, 0 failed`, `test_pnet_mfm.c: 39 checks, 0 failed`, `exit 0`.

- [ ] **Step 6: Commit**

```bash
git add wifi-floppy/firmware/src/pnet_frame.h wifi-floppy/firmware/src/pnet_frame.c \
        wifi-floppy/firmware/test/test_pnet_frame.c
git commit -m "feat(fw): PaulaNET cylinder-77 wire format, both directions (host-tested)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The raw-cell accumulator (`pnet_rx`)

**Files:**
- Create: `wifi-floppy/firmware/src/pnet_rx.h`, `wifi-floppy/firmware/src/pnet_rx.c`
- Test: `wifi-floppy/firmware/test/test_pnet_rx.c`

**Interfaces:**
- Consumes: Task 2's builder and parser, in the test only.
- Produces, used by Task 6:
  - Constants: `PNET_CELL_NS` (2000), `PNET_SYNC_CELLS` (16), `PNET_RX_SYNC_MIN_NS` (29500),
    `PNET_RX_SYNC_MAX_NS` (32500), `PNET_RX_MAX_CELLS` (64).
  - Type: `pnet_rx_t {buf, cap_bits, bit, words, sync_ns, pw_ns, sync_ok, overflowed, out_of_range}`.
  - Functions: `void pnet_rx_init(pnet_rx_t *r, uint8_t *buf, size_t cap_bytes)`,
    `void pnet_rx_feed(pnet_rx_t *r, uint32_t ns)`, `size_t pnet_rx_bytes(const pnet_rx_t *r)`.

- [ ] **Step 1: Write the failing test** `wifi-floppy/firmware/test/test_pnet_rx.c`. It feeds what `flux_in`
  reports: edge to edge minus the pulse's low time, with jitter. `a_capture_that_missed_the_first_sync_pulse_is_refused`
  is Review Focus 1.

```c
#include "harness.h"
#include "../src/pnet_rx.h"
#include "../src/pnet_frame.h"
#include <stdint.h>
#include <string.h>

/*
 * The raw-cell accumulator, fed what flux_in would report for a PaulaNET write: a lead word
 * (arm to first edge), then each gap between pulses, edge to edge MINUS the pulse's low time,
 * with a deterministic jitter. PaulaNET protocol (C) 2026 RobSmithDev, used with permission.
 */

static uint8_t wire[16384], capbuf[32768], frames[12000], dec[16384];
static uint32_t words[140000];

static size_t to_words(const uint8_t *w, size_t n, uint32_t pw, uint32_t jit, uint32_t *out) {
    size_t k = 0, prev = SIZE_MAX;
    uint32_t seed = 12345u;
    out[k++] = 30000u;                                   /* lead: arm -> first edge */
    for (size_t bit = 0; bit < n * 8u; bit++) {
        if (!((w[bit >> 3] >> (7u - (bit & 7u))) & 1u)) continue;
        if (prev != SIZE_MAX) {
            seed = seed * 1103515245u + 12345u;
            const int32_t j = jit ? (int32_t)((seed >> 16) % (2u * jit + 1u)) - (int32_t)jit : 0;
            out[k++] = (uint32_t)((int32_t)((bit - prev) * PNET_CELL_NS) - (int32_t)pw + j);
        }
        prev = bit;
    }
    return k;
}

static void feed_all(pnet_rx_t *r, const uint32_t *w, size_t n) {
    for (size_t i = 0; i < n; i++) pnet_rx_feed(r, w[i]);
}

static void bytes_after_the_sync_come_back(void) {
    const uint8_t w[] = {0x00, 0x01, 0x00, 0x01, 0x54, 0x50, 0x00, 0x00, 0xFF, 0x01, 0x80, 0x00,
                         0xAA, 0xAA};
    const uint32_t pws[] = {300u, 700u, 1200u};
    for (unsigned i = 0; i < 3; i++) {
        pnet_rx_t r;
        pnet_rx_init(&r, capbuf, sizeof capbuf);
        const size_t n = to_words(w, sizeof w, pws[i], 0, words);
        feed_all(&r, words, n);
        CHECK(r.sync_ok, "sync found");
        CHECK_EQ_INT(r.pw_ns, (int32_t)pws[i]);
        CHECK(pnet_rx_bytes(&r) >= 10 && memcmp(capbuf, w + 4, 8) == 0, "the 8 bytes after the sync");
        CHECK_EQ_INT(r.out_of_range, 0);
    }
}

/* +-300 ns on every interval, the sync included, against a 1000 ns rounding margin. */
static void jitter_does_not_move_a_bit(void) {
    pnet_frame_ref_t f[6];
    uint32_t x = 77u;
    for (size_t i = 0; i < 8000; i++) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; frames[i] = (uint8_t)x; }
    for (unsigned i = 0; i < 6; i++) { f[i].data = frames + 1500u * i; f[i].len = i < 5 ? 1500 : 500; }
    const size_t wn = pnet_build_to_board(wire, sizeof wire, 9, 0x80, f, 6);
    CHECK(wn > 0, "built");
    pnet_rx_t r;
    pnet_rx_init(&r, capbuf, sizeof capbuf);
    feed_all(&r, words, to_words(wire, wn, 800u, 300u, words));
    CHECK(r.sync_ok && !r.overflowed, "clean capture");
    CHECK(memcmp(capbuf, wire + 4, wn - 4) == 0, "every byte of an 8,000-byte batch");
}

/* The whole Amiga -> board path: build, flux, accumulate, parse. */
static void a_batch_survives_flux_and_parses(void) {
    pnet_frame_ref_t f[3] = {{frames, 64}, {frames + 64, 1500}, {frames + 1564, 7}};
    memset(frames + 1564, 0, 7);
    const size_t wn = pnet_build_to_board(wire, sizeof wire, 0x10, 0x7F, f, 3);
    pnet_rx_t r;
    pnet_rx_init(&r, capbuf, sizeof capbuf);
    feed_all(&r, words, to_words(wire, wn, 600u, 250u, words));
    pnet_hdr_t h;
    CHECK_EQ_INT(pnet_parse_hdr_from_amiga(capbuf, pnet_rx_bytes(&r), &h), PNET_OK);
    CHECK_EQ_INT(h.amiga_ctr, 0x10);
    uint16_t lens[PNET_MAX_FRAMES]; unsigned m = 0;
    CHECK_EQ_INT(pnet_parse_frames(capbuf + PNET_HDR_BYTES, h.compressed_size, PNET_TO_BOARD, dec,
                                   sizeof dec, lens, PNET_MAX_FRAMES, &m), PNET_OK);
    CHECK(m == 3 && memcmp(dec, frames, 1571) == 0, "frames");
}

/* Review Focus 1: a capture armed late (the first sync pulse missed) is refused, not parsed. */
static void a_capture_that_missed_the_first_sync_pulse_is_refused(void) {
    const uint8_t w[] = {0x00, 0x01, 0x00, 0x01, 0x54, 0x50, 0x12, 0x34, 0xAA, 0xAA};
    const size_t n = to_words(w, sizeof w, 600u, 0, words);
    pnet_rx_t r;
    pnet_rx_init(&r, capbuf, sizeof capbuf);
    pnet_rx_feed(&r, 30000u);                     /* lead (arm -> the SECOND sync pulse) */
    feed_all(&r, words + 2, n - 2);               /* word 1 is then a data interval */
    CHECK(!r.sync_ok, "not a 16-cell sync");
    CHECK_EQ_INT(pnet_rx_bytes(&r), 0);
}

static void a_long_gap_is_counted_and_clamped(void) {
    pnet_rx_t r;
    pnet_rx_init(&r, capbuf, sizeof capbuf);
    pnet_rx_feed(&r, 30000u);
    pnet_rx_feed(&r, 31400u);                     /* sync, pw 600 */
    pnet_rx_feed(&r, 70u * 2000u - 600u);
    CHECK_EQ_INT(r.out_of_range, 1);
    CHECK_EQ_INT(r.bit, PNET_RX_MAX_CELLS);
}

static void a_full_buffer_says_so(void) {
    uint8_t small[2];
    pnet_rx_t r;
    pnet_rx_init(&r, small, sizeof small);
    pnet_rx_feed(&r, 30000u);
    pnet_rx_feed(&r, 31400u);
    for (int i = 0; i < 20; i++) pnet_rx_feed(&r, 2000u - 600u);
    CHECK(r.overflowed, "overflowed");
    CHECK_EQ_INT(r.bit, 16);
}

int main(void) {
    RUN(bytes_after_the_sync_come_back);
    RUN(jitter_does_not_move_a_bit);
    RUN(a_batch_survives_flux_and_parses);
    RUN(a_capture_that_missed_the_first_sync_pulse_is_refused);
    RUN(a_long_gap_is_counted_and_clamped);
    RUN(a_full_buffer_says_so);
    return REPORT();
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E 'test_pnet_rx|COMPILE FAIL'`
Expected: `COMPILE FAIL: test_pnet_rx.c`.

- [ ] **Step 3: Write the header** `wifi-floppy/firmware/src/pnet_rx.h`

```c
#ifndef PNET_RX_H
#define PNET_RX_H
/*
 * Flux intervals -> PaulaNET's raw bitstream: what the Amiga wrote to DF1 cylinder 77, side 0.
 *
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09). Implemented from the description; no code of his.
 *
 * flux_bits.c (DF0's writes) knows only MFM: 2, 3 or 4 cells per interval. A PaulaNET write is
 * RLE bytes sent as raw cells, so an interval is any whole number of 2 us cells -- 1 for two
 * adjacent 1 bits, 20+ across a zero byte. This is the second classifier the research doc calls
 * for (§3.4), pure and host-tested like flux_bits.c.
 *
 * WHAT flux_in MEASURES. Not edge to edge: it counts while WDATA is high and reports at the next
 * falling edge, so every interval comes back short by the pulse's low time. MFM's wide classes
 * never cared; 1-cell intervals do. The write opens with 00 01 00 01 -- two pulses exactly 16
 * cells apart -- so the second word (the first is arm-to-first-edge, not an interval) gives the
 * missing low time: pw = 16 x 2000 ns - measured. Every later interval is rounded to cells AFTER
 * adding it back. Both ends are crystal clocks, so the nominal 2000 ns cell is used as is.
 *
 * Output: bit 0 is the first cell after the second sync pulse, so byte 0 is the DataHeader's
 * first byte. An interval of k cells appends k - 1 zeros and then a 1.
 */
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#define PNET_CELL_NS         2000u
#define PNET_SYNC_CELLS      16u
#define PNET_RX_SYNC_MIN_NS  29500u   /* the sync interval as flux_in reports it: 32 us less */
#define PNET_RX_SYNC_MAX_NS  32500u   /*   a pulse low time of -500..2500 ns */
#define PNET_RX_MAX_CELLS    64u      /* past any gap a legal batch holds: counted, then clamped */

typedef struct {
    uint8_t *buf;
    size_t   cap_bits;
    size_t   bit;           /* the next bit to write */
    uint32_t words;         /* PIO words fed, the lead included */
    uint32_t sync_ns;       /* word 1, as measured */
    int32_t  pw_ns;         /* 16 cells minus sync_ns */
    bool     sync_ok;       /* word 1 was a 16-cell interval; nothing is decoded otherwise */
    bool     overflowed;
    uint32_t out_of_range;  /* intervals over PNET_RX_MAX_CELLS */
} pnet_rx_t;

/* `cap_bytes` of `buf` are cleared. */
void   pnet_rx_init(pnet_rx_t *r, uint8_t *buf, size_t cap_bytes);
/* One PIO word, converted to ns (flux_counter_to_ns). */
void   pnet_rx_feed(pnet_rx_t *r, uint32_t ns);
/* Bytes so far, a partial last byte included. */
size_t pnet_rx_bytes(const pnet_rx_t *r);
#endif
```

- [ ] **Step 4: Write the implementation** `wifi-floppy/firmware/src/pnet_rx.c`

```c
/* PaulaNET protocol (C) 2026 RobSmithDev, used with permission -- see pnet_rx.h. */
#include "pnet_rx.h"
#include <string.h>

void pnet_rx_init(pnet_rx_t *r, uint8_t *buf, size_t cap_bytes) {
    memset(r, 0, sizeof *r);
    r->buf = buf;
    r->cap_bits = cap_bytes * 8u;
    memset(buf, 0, cap_bytes);
}

void pnet_rx_feed(pnet_rx_t *r, uint32_t ns) {
    const uint32_t w = r->words++;
    if (w == 0) return;                               // arm -> first edge: not an interval
    if (w == 1) {
        r->sync_ns = ns;
        r->sync_ok = ns >= PNET_RX_SYNC_MIN_NS && ns <= PNET_RX_SYNC_MAX_NS;
        r->pw_ns = (int32_t)(PNET_SYNC_CELLS * PNET_CELL_NS) - (int32_t)ns;
        return;
    }
    if (!r->sync_ok || r->overflowed) return;
    const int64_t t = (int64_t)ns + r->pw_ns + (int64_t)(PNET_CELL_NS / 2u);
    uint64_t cells = t < (int64_t)PNET_CELL_NS ? 1u : (uint64_t)t / PNET_CELL_NS;
    if (cells > PNET_RX_MAX_CELLS) { r->out_of_range++; cells = PNET_RX_MAX_CELLS; }
    const size_t at = r->bit + (size_t)cells - 1u;   // the 1 after cells - 1 zeros
    if (at >= r->cap_bits) { r->overflowed = true; return; }
    r->buf[at >> 3] |= (uint8_t)(0x80u >> (at & 7u));
    r->bit = at + 1u;
}

size_t pnet_rx_bytes(const pnet_rx_t *r) { return (r->bit + 7u) >> 3; }
```

- [ ] **Step 5: Run the suite**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E 'pnet|FAIL|CRASH'; wifi-floppy/firmware/test/run.sh >/dev/null 2>&1; echo "exit $?"`
Expected: `test_pnet_rx.c: 25 checks, 0 failed`, the earlier pnet lines unchanged, `exit 0`.

- [ ] **Step 6: Commit**

```bash
git add wifi-floppy/firmware/src/pnet_rx.h wifi-floppy/firmware/src/pnet_rx.c \
        wifi-floppy/firmware/test/test_pnet_rx.c
git commit -m "feat(fw): raw-cell accumulator for PaulaNET writes, pulse width learned from the sync

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The loopback's decisions (`pnet_loop`) and a GCC run

**Files:**
- Create: `wifi-floppy/firmware/src/pnet_loop.h`, `wifi-floppy/firmware/src/pnet_loop.c`
- Test: `wifi-floppy/firmware/test/test_pnet_loop.c`

**Interfaces:**
- Consumes (Task 2): `pnet_hdr_t`, `PNET_*` constants, `PNET_E_COUNT`, `PNET_MAX_FRAMES`.
- Produces, used by Task 7:
  - Constant: `PNET_ECHO_BYTES` (16384).
  - Type: `pnet_df1_t` (`PNET_DF1_DISK`, `PNET_DF1_SILENT`, `PNET_DF1_ECHO`).
  - Functions:
    - `pnet_df1_t pnet_df1_for_track(int want)`
    - `bool pnet_df1_wprot(int cyl)`
    - `bool pnet_capture_ours(bool df1_serving, bool sel0, bool sel1, int cyl1, int side)`
  - The state `pnet_loop_t {last_amiga, pico, nframes, len[20], rx, fresh, dup, bad[PNET_E_COUNT]}`, with
    `void pnet_loop_init(pnet_loop_t *)`, `bool pnet_loop_is_new(const pnet_loop_t *, const pnet_hdr_t *)` and
    `void pnet_loop_commit(pnet_loop_t *, const pnet_hdr_t *, unsigned n, const uint16_t *lens)`.

- [ ] **Step 1: Write the failing test** `wifi-floppy/firmware/test/test_pnet_loop.c`. The DF0 cases in
  `only_df1_on_77_side_0_is_a_batch` pin that DF0's writes stay DF0's.

```c
#include "harness.h"
#include "../src/pnet_loop.h"
#include <stdint.h>
#include <string.h>

/* The cylinder-77 loopback's decisions. PaulaNET protocol (C) 2026 RobSmithDev, used with
 * permission. */

static void df1_streams_disk_silence_or_echo(void) {
    CHECK_EQ_INT(pnet_df1_for_track(154), PNET_DF1_SILENT);
    CHECK_EQ_INT(pnet_df1_for_track(155), PNET_DF1_ECHO);
    CHECK_EQ_INT(pnet_df1_for_track(0), PNET_DF1_DISK);
    CHECK_EQ_INT(pnet_df1_for_track(153), PNET_DF1_DISK);
    CHECK_EQ_INT(pnet_df1_for_track(156), PNET_DF1_DISK);
    CHECK_EQ_INT(pnet_df1_for_track(-1), PNET_DF1_DISK);
}

static void wprot_is_released_only_on_cylinder_77(void) {
    CHECK(!pnet_df1_wprot(77), "77 writable");
    CHECK(pnet_df1_wprot(76) && pnet_df1_wprot(78) && pnet_df1_wprot(0) && pnet_df1_wprot(40),
          "everywhere else protected");
}

static void only_df1_on_77_side_0_is_a_batch(void) {
    CHECK(pnet_capture_ours(true, false, true, 77, 0), "DF1, 77, side 0");
    CHECK(!pnet_capture_ours(true, false, true, 77, 1), "side 1 is the Amiga reading");
    CHECK(!pnet_capture_ours(true, false, true, 76, 0), "another cylinder");
    CHECK(!pnet_capture_ours(false, false, true, 77, 0), "DF1 not serving a disk");
    CHECK(!pnet_capture_ours(true, false, false, 77, 0), "SEL1 not asserted");
    /* DF0's writes stay DF0's, whatever DF1's head is doing */
    CHECK(!pnet_capture_ours(true, true, false, 77, 0), "SEL0: a DF0 write");
    CHECK(!pnet_capture_ours(true, true, true, 77, 0), "both selects: never ours");
}

static pnet_hdr_t hdr(uint8_t amiga, uint8_t pico) {
    pnet_hdr_t h;
    memset(&h, 0, sizeof h);
    h.mode = PNET_MODE_ETHERNET;
    h.amiga_ctr = amiga;
    h.pico_ctr = pico;
    return h;
}

static void counters_follow_paulanet(void) {
    pnet_loop_t s;
    pnet_loop_init(&s);
    CHECK_EQ_INT(s.last_amiga, 0xFF);
    CHECK_EQ_INT(s.pico, 0x7F);
    const uint16_t two[2] = {64, 1500}, one[1] = {9};
    pnet_hdr_t h = hdr(0x00, 0xFF);                      /* the Amiga's first batch */
    CHECK(pnet_loop_is_new(&s, &h), "new");
    pnet_loop_commit(&s, &h, 2, two);
    CHECK_EQ_INT(s.pico, 0x80);
    CHECK_EQ_INT(s.nframes, 2);
    CHECK_EQ_INT(s.last_amiga, 0x00);
    CHECK(!pnet_loop_is_new(&s, &h), "the same counter again is a resend");
    pnet_loop_commit(&s, &h, 0, NULL);
    CHECK_EQ_INT(s.dup, 1);
    CHECK_EQ_INT(s.nframes, 2);                          /* a resend keeps the echo */
    h = hdr(0x01, 0x80);                                 /* next batch, acknowledging ours */
    pnet_loop_commit(&s, &h, 1, one);
    CHECK_EQ_INT(s.nframes, 1);
    CHECK_EQ_INT(s.len[0], 9);
    CHECK_EQ_INT(s.pico, 0x81);
    h = hdr(0x02, 0x81);                                 /* an empty batch that acknowledges */
    pnet_loop_commit(&s, &h, 0, NULL);
    CHECK_EQ_INT(s.nframes, 0);
    CHECK_EQ_INT(s.pico, 0x81);
    CHECK_EQ_INT(s.fresh, 3);
}

static void counters_wrap(void) {
    pnet_loop_t s;
    pnet_loop_init(&s);
    const uint16_t one[1] = {1};
    for (unsigned i = 0; i < 300; i++) {
        pnet_hdr_t h = hdr((uint8_t)i, s.pico);
        CHECK(pnet_loop_is_new(&s, &h), "every next counter is new");
        pnet_loop_commit(&s, &h, 1, one);
    }
    CHECK_EQ_INT(s.fresh, 300);
    CHECK_EQ_INT(s.dup, 0);
    CHECK_EQ_INT(s.pico, (uint8_t)(0x7F + 300));
}

int main(void) {
    RUN(df1_streams_disk_silence_or_echo);
    RUN(wprot_is_released_only_on_cylinder_77);
    RUN(only_df1_on_77_side_0_is_a_batch);
    RUN(counters_follow_paulanet);
    RUN(counters_wrap);
    return REPORT();
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E 'test_pnet_loop|COMPILE FAIL'`
Expected: `COMPILE FAIL: test_pnet_loop.c`.

- [ ] **Step 3: Write the header** `wifi-floppy/firmware/src/pnet_loop.h`

```c
#ifndef PNET_LOOP_H
#define PNET_LOOP_H
/*
 * The cylinder-77 loopback's decisions (WF_PNET_LOOP TEST builds): what DF1 streams for a track,
 * WPROT, whose write a capture is, and PaulaNET's counter/acknowledge rule. Pure; main.c acts.
 *
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09). Implemented from the description; no code of his.
 *
 * Counters, as PaulaNET has them: each side bumps its own 8-bit counter per new batch and echoes
 * the other's. A batch whose amiga counter equals the last one taken is a resend: its frames are
 * not taken again. An amiga batch that echoes our current pico counter acknowledges our batch,
 * which is then dropped. In the loopback our batch IS the echo of the Amiga's last frames.
 */
#include <stdint.h>
#include <stdbool.h>
#include "pnet_frame.h"

#define PNET_ECHO_BYTES 16384u   /* one half of the PSRAM echo store (main.c) */

typedef enum { PNET_DF1_DISK = 0, PNET_DF1_SILENT, PNET_DF1_ECHO } pnet_df1_t;

/* What DF1 streams for `want` (cyl * 2 + side): the disk, nothing (154: the Amiga writes), or
 * the echo (155). */
pnet_df1_t pnet_df1_for_track(int want);
/* DF1's WPROT for a head on `cyl`: asserted everywhere but cylinder 77. */
bool pnet_df1_wprot(int cyl);
/* A WGATE assertion is a loopback batch: DF1 serves a disk, SEL1 (not SEL0) is asserted, and
 * DF1's head is on cylinder 77, side 0. sel0/sel1 are ASSERTED, not pin levels. */
bool pnet_capture_ours(bool df1_serving, bool sel0, bool sel1, int cyl1, int side);

typedef struct {
    uint8_t  last_amiga;               /* 0xFF: nothing taken yet */
    uint8_t  pico;                     /* our batch counter, 0x7F at start (as PaulaNET's) */
    uint8_t  nframes;                  /* frames in the echo; 0 = an empty batch */
    uint16_t len[PNET_MAX_FRAMES];
    uint32_t rx, fresh, dup;           /* captures; new batches; resends */
    uint32_t bad[PNET_E_COUNT];        /* refused captures, by reason (main.c counts these) */
} pnet_loop_t;

void pnet_loop_init(pnet_loop_t *s);
bool pnet_loop_is_new(const pnet_loop_t *s, const pnet_hdr_t *h);
/* A parsed batch: n frames of lens[] if it is new (n = 0 and lens may be NULL for a resend). */
void pnet_loop_commit(pnet_loop_t *s, const pnet_hdr_t *h, unsigned n, const uint16_t *lens);
#endif
```

- [ ] **Step 4: Write the implementation** `wifi-floppy/firmware/src/pnet_loop.c`

```c
/* PaulaNET protocol (C) 2026 RobSmithDev, used with permission -- see pnet_loop.h. */
#include "pnet_loop.h"
#include <string.h>

pnet_df1_t pnet_df1_for_track(int want) {
    if (want == PNET_TRACK_IN) return PNET_DF1_SILENT;
    if (want == PNET_TRACK_OUT) return PNET_DF1_ECHO;
    return PNET_DF1_DISK;
}

bool pnet_df1_wprot(int cyl) { return cyl != PNET_CYL; }

bool pnet_capture_ours(bool df1_serving, bool sel0, bool sel1, int cyl1, int side) {
    return df1_serving && !sel0 && sel1 && cyl1 == PNET_CYL && side == 0;
}

void pnet_loop_init(pnet_loop_t *s) {
    memset(s, 0, sizeof *s);
    s->last_amiga = 0xFFu;
    s->pico = 0x7Fu;
}

bool pnet_loop_is_new(const pnet_loop_t *s, const pnet_hdr_t *h) {
    return h->amiga_ctr != s->last_amiga;
}

void pnet_loop_commit(pnet_loop_t *s, const pnet_hdr_t *h, unsigned n, const uint16_t *lens) {
    if (h->pico_ctr == s->pico) s->nframes = 0;          // the Amiga has our batch
    if (!pnet_loop_is_new(s, h)) { s->dup++; return; }  // a resend: frames already taken
    s->last_amiga = h->amiga_ctr;
    s->fresh++;
    if (n == 0) return;
    if (n > PNET_MAX_FRAMES) n = PNET_MAX_FRAMES;
    s->pico++;
    s->nframes = (uint8_t)n;
    memcpy(s->len, lens, n * sizeof *lens);
}
```

- [ ] **Step 5: Run the suite**

Run: `wifi-floppy/firmware/test/run.sh 2>&1 | grep -E 'pnet|FAIL|CRASH'; wifi-floppy/firmware/test/run.sh >/dev/null 2>&1; echo "exit $?"`
Expected: `test_pnet_loop.c: 333 checks, 0 failed`, all four pnet lines at 0 failed, `exit 0`.

- [ ] **Step 6: The new tests under Linux GCC.** CI warns more than macOS clang (HANDOFF, "Firmware CI fails on every
  push since 2026-10-05"). This uses the local `gcc:13` image:

Run:
```bash
cd wifi-floppy/firmware && docker run --rm -v "$PWD":/w -w /w/test gcc:13 bash -c '
  for t in test_pnet_mfm test_pnet_frame test_pnet_rx test_pnet_loop; do
    gcc -std=c11 -D_DEFAULT_SOURCE -g -O2 -Wall -Wextra -Werror -o /tmp/$t $t.c \
        ../src/pnet_mfm.c ../src/pnet_frame.c ../src/pnet_rx.c ../src/pnet_loop.c && /tmp/$t | tail -1 || exit 1
  done'; echo "exit $?"
```
Expected: four `0 failed` lines, `exit 0`.

- [ ] **Step 7: Commit**

```bash
git add wifi-floppy/firmware/src/pnet_loop.h wifi-floppy/firmware/src/pnet_loop.c \
        wifi-floppy/firmware/test/test_pnet_loop.c
git commit -m "feat(fw): PaulaNET loopback decisions -- DF1 per track, WPROT, capture owner, counters

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The `WF_PNET_LOOP` build option and the publish guard

**Files:**
- Modify: `wifi-floppy/firmware/CMakeLists.txt`: after the `WFMF_FIRMWARE_SOURCES` list (its closing `)` is line 85), and after the
  `WF_DF1_DEFAULT` check (line 180).
- Modify: `src/lib/firmware-manifest.ts:29-35`, `src/lib/firmware-manifest.test.ts:41-46`
- Modify: `.gitignore`: the "Firmware side builds" lines.

**Interfaces:**
- Consumes: Tasks 1-4's sources (the ON build compiles them for ARM).
- Produces:
  - The compile definition `WF_PNET_LOOP` (always defined, 0 or 1), used by Tasks 6 and 7.
  - `refuseReleaseImage` now refuses an image containing `wf-pnet-loop-test` unless the notes start with
    `TEST build`. Task 7 puts that marker in the image.

- [ ] **Step 1: Write the failing vitest.** In `src/lib/firmware-manifest.test.ts`, add after the
  `'refuses a build with DF1 on by default unless the notes say TEST build'` case:

```ts
  it('refuses a PaulaNET loopback build unless the notes say TEST build', () => {
    const pnet = Buffer.from('xx wf-pnet-loop-test xx');
    expect(refuseReleaseImage(realInfo, 533624, pnet)).toMatch(/PaulaNET/);
    expect(refuseReleaseImage(realInfo, 533624, pnet, 'a release')).toMatch(/PaulaNET/);
    expect(refuseReleaseImage(realInfo, 533624, pnet, 'TEST build: PaulaNET phase 0')).toBeNull();
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/lib/firmware-manifest.test.ts`
Expected: FAIL in "refuses a PaulaNET loopback build" (`expected null to match /PaulaNET/`).

- [ ] **Step 3: Add the guard.** In `src/lib/firmware-manifest.ts`, directly after the `wf-df1-default-on` check and
  before `return null;`:

```ts
  // A PaulaNET loopback build (WF_PNET_LOOP) carries this marker (main.c). Bench only, like DF1-default.
  if (bytes.includes(Buffer.from('wf-pnet-loop-test', 'ascii')) && !(notes ?? '').startsWith('TEST build')) {
    return 'image is a PaulaNET loopback build (WF_PNET_LOOP); publish it only as a bench build, with --notes starting "TEST build"';
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm vitest run src/lib/firmware-manifest.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Add the CMake option.** Apply exactly this change to `wifi-floppy/firmware/CMakeLists.txt`, either by
  hand or by saving the block as `/tmp/pnet-cmake.diff` and running `git apply /tmp/pnet-cmake.diff` from the repo root:

```diff
--- a/wifi-floppy/firmware/CMakeLists.txt
+++ b/wifi-floppy/firmware/CMakeLists.txt
@@ -83,6 +83,18 @@
   src/fw_offer.c src/fw_verify.c
   src/vendor/monocypher/monocypher.c src/vendor/monocypher/monocypher-ed25519.c
 )
+# PaulaNET track-77 loopback (plan docs/superpowers/plans/2026-10-09-paulanet-phase0-loopback.md).
+# A bench TEST build only: DF1's cylinder 77 becomes a PaulaNET loopback for the Amiga tool
+# tools/netloop. OFF compiles none of it -- every hook in main.c and flux_capture.c is under
+# #if WF_PNET_LOOP and these sources are not even in the image -- and the publish script refuses
+# an image carrying the marker (main.c) unless the notes start "TEST build". Needs DF1, i.e.
+# WF_DRIVE_ID (checked below, beside WF_DF1_DEFAULT).
+option(WF_PNET_LOOP "Bench TEST build: DF1 cylinder 77 is a PaulaNET loopback" OFF)
+list(APPEND WFMF_COMMON_DEFS WF_PNET_LOOP=$<IF:$<BOOL:${WF_PNET_LOOP}>,1,0>)
+if (WF_PNET_LOOP)
+  list(APPEND WFMF_FIRMWARE_SOURCES src/pnet_mfm.c src/pnet_frame.c src/pnet_rx.c src/pnet_loop.c)
+  message(STATUS "WF_PNET_LOOP is ON: DF1 cylinder 77 is a PaulaNET loopback (TEST build only).")
+endif ()
 # Stack frames (HANDOFF 3ax): 1.7.0 died because one 1232-byte frame took core0's
 # boot path past its stack (2 KB then, 4 KB since 1.7.1) -- a hard fault before
 # USB came up, invisible to every host test. Any frame of ours over 768 bytes now
@@ -178,6 +190,9 @@
 if (WF_DF1_DEFAULT AND NOT WF_DRIVE_ID)
   message(FATAL_ERROR "WF_DF1_DEFAULT needs WF_DRIVE_ID: DF1 answers its ID through the responder")
 endif ()
+if (WF_PNET_LOOP AND NOT WF_DRIVE_ID)
+  message(FATAL_ERROR "WF_PNET_LOOP needs WF_DRIVE_ID: the loopback is DF1's, and DF1 needs the responder")
+endif ()
 # D2 (plan 2026-10-08 Task 5): DF1's DMA word buffer. OFF = DD-sized (+14,336 B);
 # an HD next disk then leaves DF1 empty. DF1 is served only in a WF_DRIVE_ID
 # build (its ID, NONE while off, comes from the responder), so the buffer is
```

- [ ] **Step 6: Ignore the identity check's build directory.** In `.gitignore`, change

```
# Firmware side builds: the DF1-default-on TEST image and the bus-sniffer image.
build-df1/
build-sniff/
```

to

```
# Firmware side builds: the DF1-default-on TEST image, the bus-sniffer image, the
# PaulaNET loopback side build, and tools/pnet_off_identical.sh's preprocessing build.
build-df1/
build-sniff/
build-pnet/
build-offcheck/
```

- [ ] **Step 7: Both configurations build.** This uses a side directory, so `build/` is not disturbed:

Run:
```bash
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
cd wifi-floppy/firmware
cmake -B build-pnet -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 -DWF_PNET_LOOP=ON \
  | grep 'WF_PNET_LOOP is ON' && cmake --build build-pnet >/dev/null && echo "ON ok"
cmake -B build -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 -DWF_PNET_LOOP=OFF \
  && cmake --build build >/dev/null && echo "OFF ok"
```
Expected: the `WF_PNET_LOOP is ON` status line, then `ON ok`, then `OFF ok`. The pure sources are compiled for ARM
with `-Werror=frame-larger-than=768`, and nothing calls them yet.

- [ ] **Step 8: Commit**

```bash
git add wifi-floppy/firmware/CMakeLists.txt src/lib/firmware-manifest.ts src/lib/firmware-manifest.test.ts .gitignore
git commit -m "build(fw): WF_PNET_LOOP option (OFF), and the publish script refuses its marker outside TEST builds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: A raw-capture mode in `flux_capture`, and the OFF identity check

**Files:**
- Modify: `wifi-floppy/firmware/src/flux_capture.h` (after `flux_capture_take`'s declaration, line 82),
  `wifi-floppy/firmware/src/flux_capture.c` (includes, statics, `consume`, `flux_capture_arm`, `flux_capture_disarm`,
  `flux_capture_take`, and a new function at the end)
- Create: `wifi-floppy/firmware/tools/pnet_off_identical.sh`

**Interfaces:**
- Consumes (Task 3): `pnet_rx_t`, `pnet_rx_init`, `pnet_rx_feed`, `pnet_rx_bytes`.
- Produces, under `#if WF_PNET_LOOP` only, used by Task 7:
  - `void flux_capture_arm_raw(void)`, ISR-safe like `flux_capture_arm`.
  - `flux_capture_raw_t {bytes, nbytes, words, sync_ns, pw_ns, sync_ok, overflowed, out_of_range, max_backlog, ended_us}`.
  - `bool flux_capture_take_raw(flux_capture_raw_t *out)`.
  - `flux_capture_take()` never returns a raw capture.

This is device-only code: `run.sh` excludes `flux_capture.c`, for the reason its comment gives. Its decisions are the
host-tested `pnet_rx.c`. The checks here are therefore the two builds and the identity script.

- [ ] **Step 1: Write the identity check first** at `wifi-floppy/firmware/tools/pnet_off_identical.sh` (then
  `chmod +x` it). Before this task's change, it passes for both files, which proves that the script runs.

```bash
#!/usr/bin/env bash
# With WF_PNET_LOOP=OFF the firmware must build exactly as <base> (default: master) does -- DF0
# above all (plan docs/superpowers/plans/2026-10-09-paulanet-phase0-loopback.md, Global
# Constraints). This proves it at the source level: each firmware .c file the plan touches is
# preprocessed with the device build's own compile command (WF_PNET_LOOP=0), and so is the same
# file from <base>; any difference fails. Both copies see THIS tree's headers, which differ from
# <base> only inside #if WF_PNET_LOOP. (A __FILE__ in either file would differ by name alone and
# fail this check; neither file uses one today.)
set -euo pipefail
fw="$(cd "$(dirname "$0")/.." && pwd)"
base="${1:-master}"
bd="$fw/build-offcheck"
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
cmake -S "$fw" -B "$bd" -G Ninja -DPICO_SDK_PATH="$HOME/pico-sdk" \
  -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 -DCMAKE_EXPORT_COMPILE_COMMANDS=ON \
  -DWF_PNET_LOOP=OFF -DWF_DF1_DEFAULT=OFF >/dev/null 2>&1 || { echo "FAIL: cmake configure"; exit 1; }
# Generates floppy.pio.h and the version header the sources include.
cmake --build "$bd" >/dev/null 2>&1 || { echo "FAIL: the OFF build itself"; exit 1; }
fail=0
for f in main.c flux_capture.c; do
  tmp="$fw/src/.offcheck_base_$f"   # beside the original, so its #include "..." resolve the same
  git -C "$fw" show "$base:wifi-floppy/firmware/src/$f" > "$tmp"
  python3 - "$bd/compile_commands.json" "$fw/src/$f" "$tmp" "$bd/offcheck_$f" <<'EOPY'
import json, os, shlex, subprocess, sys
db, src, base, out = sys.argv[1:]
want = os.path.realpath(src)
cmd = next(e for e in json.load(open(db))
           if os.path.realpath(os.path.join(e['directory'], e['file'])) == want
           and 'wifi_floppy.dir' in e['command'])
keep, skip = [], False
for a in shlex.split(cmd['command']):
    if skip: skip = False; continue
    if a in ('-o', '-c', '-MF', '-MT'): skip = True; continue
    if a in ('-MD', '-MMD'): continue
    keep.append(a)
for path, tag in ((src, 'new'), (base, 'base')):
    subprocess.run(keep + ['-E', '-P', path, '-o', f'{out}.{tag}.i'], cwd=cmd['directory'], check=True)
EOPY
  rm -f "$tmp"
  if cmp -s "$bd/offcheck_$f.base.i" "$bd/offcheck_$f.new.i"; then
    echo "identical with WF_PNET_LOOP=0: src/$f"
  else
    echo "DIFFERS with WF_PNET_LOOP=0: src/$f"
    diff "$bd/offcheck_$f.base.i" "$bd/offcheck_$f.new.i" | head -40 || true
    fail=1
  fi
done
exit $fail
```

Run: `wifi-floppy/firmware/tools/pnet_off_identical.sh master; echo "exit $?"`
Expected: `identical with WF_PNET_LOOP=0: src/main.c`, the same for `src/flux_capture.c`, then `exit 0`.

- [ ] **Step 2: Apply the raw mode.** Apply exactly these two changes, by hand or with `git apply` as in Task 5:

```diff
--- a/wifi-floppy/firmware/src/flux_capture.h
+++ b/wifi-floppy/firmware/src/flux_capture.h
@@ -81,4 +81,30 @@
  *  Clears the flag, so a caller that takes it owns it. */
 bool flux_capture_take(flux_capture_result_t *out);
 
+#if WF_PNET_LOOP
+/*
+ * PaulaNET loopback TEST builds (plan 2026-10-09-paulanet-phase0-loopback): the same PIO, DMA,
+ * ring and buffer, but the intervals go to pnet_rx.c (raw 2 us cells, any count) instead of
+ * flux_bits.c (MFM, 2-4 cells). A raw capture is taken with flux_capture_take_raw() only;
+ * flux_capture_take() never returns one, so DF0's write-back cannot see a network batch.
+ */
+void flux_capture_arm_raw(void);
+
+typedef struct {
+    const uint8_t *bytes;     /* from the first bit after the 00 01 00 01 sync */
+    uint32_t nbytes;
+    uint32_t words;           /* PIO words, the lead included */
+    uint32_t sync_ns;
+    int32_t  pw_ns;
+    bool     sync_ok;
+    bool     overflowed;
+    uint32_t out_of_range;
+    uint32_t max_backlog;     /* most unread ring words seen at once */
+    uint64_t ended_us;        /* time_us_64() when WGATE released */
+} flux_capture_raw_t;
+
+/** True, once, after a RAW capture ends. */
+bool flux_capture_take_raw(flux_capture_raw_t *out);
 #endif
+
+#endif
```

```diff
--- a/wifi-floppy/firmware/src/flux_capture.c
+++ b/wifi-floppy/firmware/src/flux_capture.c
@@ -7,6 +7,9 @@
 #include "hardware/clocks.h"
 #include "pico/time.h"
 #include <string.h>
+#if WF_PNET_LOOP
+#include "pnet_rx.h"
+#endif
 
 /*
  * WHY A RING AND NOT AN INTERRUPT PER INTERVAL.
@@ -47,9 +50,19 @@
 static uint32_t d_max_backlog, d_max_gap_ms, d_last_poll_ms;
 static uint32_t d_cells[3], d_ns_min, d_ns_max, d_glitches;
 static uint32_t d_count, d_lead_ns, d_min_at;   // HANDOFF 3av (b)
+#if WF_PNET_LOOP
+// The PaulaNET loopback's raw capture (flux_capture.h). raw_mode is set at arm and read by
+// consume() and both takes; a DF0 arm clears it.
+static volatile bool raw_mode;
+static pnet_rx_t raw_rx;
+static volatile uint64_t raw_ended_us;
+#endif
 
 static void consume(uint32_t word) {
     const uint32_t ns = flux_counter_to_ns(word, pio_hz);
+#if WF_PNET_LOOP
+    if (raw_mode) { pnet_rx_feed(&raw_rx, ns); return; }
+#endif
     // Word 0 is not a flux interval: arming only restarts flux_in, so it
     // counts from the arm (or carries the previous capture's count) to the
     // first edge. Measured 2026-10-04 (HANDOFF 3av): the sub-3000 ns minimum
@@ -97,7 +110,14 @@
     return (uint32_t)(((w - (uintptr_t)ring) / 4u) & (RING_WORDS - 1u));
 }
 
+#if WF_PNET_LOOP
+static void arm(bool raw);
+void flux_capture_arm(void) { arm(false); }
+void flux_capture_arm_raw(void) { arm(true); }
+static void arm(bool raw) {
+#else
 void flux_capture_arm(void) {
+#endif
     if (cap_dma < 0 || armed) return;
     // Everything stale goes first: a FIFO still holding intervals from the
     // last write would put another track's flux at the head of this one.
@@ -110,6 +130,11 @@
     dma_channel_set_trans_count(cap_dma, 0xffffffffu, true);
 
     cap_read = 0;
+#if WF_PNET_LOOP
+    raw_mode = raw;
+    if (raw) pnet_rx_init(&raw_rx, mfm_buf, sizeof mfm_buf);
+    else
+#endif
     flux_bits_init(&bits, mfm_buf, sizeof mfm_buf);
     d_max_backlog = d_max_gap_ms = 0;
     d_cells[0] = d_cells[1] = d_cells[2] = 0;
@@ -127,6 +152,9 @@
     if (!armed) return;
     pio_sm_set_enabled(cap_pio, cap_sm, false);
     armed = false;
+#if WF_PNET_LOOP
+    raw_ended_us = time_us_64();
+#endif
     // NOT decoded here: this runs in the WGATE ISR. The service loop drains
     // what is left and decides what to do with it.
     ended = true;
@@ -173,6 +201,9 @@
 }
 
 bool flux_capture_take(flux_capture_result_t *out) {
+#if WF_PNET_LOOP
+    if (raw_mode) return false;      // a loopback batch: flux_capture_take_raw's
+#endif
     if (!ended) return false;
     // Drain whatever the DMA landed between the last poll and WGATE going
     // away -- the tail of the track, which is where the last sector lives.
@@ -196,3 +227,25 @@
     out->glitches = d_glitches;
     return true;
 }
+
+#if WF_PNET_LOOP
+bool flux_capture_take_raw(flux_capture_raw_t *out) {
+    if (!ended || !raw_mode) return false;
+    while (cap_read != dma_head()) {          // the tail, as flux_capture_take does
+        consume(ring[cap_read]);
+        cap_read = (cap_read + 1u) & (RING_WORDS - 1u);
+    }
+    ended = false;
+    out->bytes        = mfm_buf;
+    out->nbytes       = (uint32_t)pnet_rx_bytes(&raw_rx);
+    out->words        = raw_rx.words;
+    out->sync_ns      = raw_rx.sync_ns;
+    out->pw_ns        = raw_rx.pw_ns;
+    out->sync_ok      = raw_rx.sync_ok;
+    out->overflowed   = raw_rx.overflowed;
+    out->out_of_range = raw_rx.out_of_range;
+    out->max_backlog  = d_max_backlog;
+    out->ended_us     = raw_ended_us;
+    return true;
+}
+#endif
```

- [ ] **Step 3: The OFF build is still master's**

Run: `wifi-floppy/firmware/tools/pnet_off_identical.sh master; echo "exit $?"`
Expected: both files `identical with WF_PNET_LOOP=0`, then `exit 0`.

- [ ] **Step 4: The ON build compiles**

Run: `export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"; cmake --build wifi-floppy/firmware/build-pnet >/dev/null && echo "ON ok"`
Expected: `ON ok`. There is no `-Wunused-function`, because the new functions are public.

- [ ] **Step 5: Host suite unaffected**

Run: `wifi-floppy/firmware/test/run.sh >/dev/null 2>&1; echo "exit $?"`
Expected: `exit 0`.

- [ ] **Step 6: Commit**

```bash
git add wifi-floppy/firmware/src/flux_capture.h wifi-floppy/firmware/src/flux_capture.c \
        wifi-floppy/firmware/tools/pnet_off_identical.sh
git commit -m "feat(fw): raw-capture mode for the PaulaNET loopback (WF_PNET_LOOP only; OFF proven identical)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The loopback on core0 (`main.c`)

**Files:**
- Modify: `wifi-floppy/firmware/src/main.c`. Every change is under `#if WF_PNET_LOOP`:
  - the includes (line 66);
  - two ISR flags beside `write_ours` (line 849);
  - `step_drive`'s WPROT (line 709);
  - `gpio_isr`'s WGATE branch (line 1230);
  - the glue functions before `// ---- main` (line 2811);
  - the boot banner after the `df1:` boot line (lines 2891-2894);
  - DF1's serve call in core0's loop (line 3508).

**Interfaces:**
- Consumes:
  - Tasks 2 and 4: `pnet_frame.h` and `pnet_loop.h`.
  - Task 6: `flux_capture_arm_raw`, `flux_capture_take_raw`, `flux_capture_raw_t`.
  - Existing statics in `main.c`: `stream_stop`, `start_streaming`, `serve_drive`, `index_off`, `track_words1`,
    `want_track`, `cur_cyl`, `cur_side`, `g_df1_mode`, `clock_ms`.
- Produces:
  - The image marker `wf-pnet-loop-test` (Task 5's guard; Task 9 checks it).
  - Serial lines, used in the bench:
    - `wf-pnet-loop-test: DF1 cylinder 77 is a PaulaNET loopback (bench only)` at boot;
    - every 5 s while there is traffic, `pnet: rx .. new .. dup .. bad .. ctr aa/pp echo N fr` and
      `pnet: us dec max .. avg .. ready max .. build max .. avg .. bl ..`;
    - when anything was refused, `pnet: bad nosync .. magic .. size .. ck .. frames .. rle .. full ..`, plus one
      detailed `pnet: refused <why>: ..` per window.

What it does, in order:
1. **STEP:** while DF1 is on, DF1's WPROT is released on cylinder 77 and asserted everywhere else, at the step itself.
2. **WGATE:** a write with SEL1 asserted (SEL0 not), DF1 serving a disk, and DF1's head on cylinder 77 side 0 arms a
   raw capture under its own flag. DF0's `write_ours` path is untouched.
3. **The loop, in this order each pass:**
   - take a finished raw capture: parse it, and store new frames in the inactive PSRAM half;
   - serve DF1: a disk track as today; silence on track 154; the echo on track 155;
   - log a summary every 5 s.
   - The echo is built straight into `track_words1`, after `stream_stop(1)`, and is restarted with an INDEX pulse of
     its own (Correction 4).

- [ ] **Step 1: Apply the change** exactly, by hand or with `git apply` as in Task 5:

```diff
--- a/wifi-floppy/firmware/src/main.c
+++ b/wifi-floppy/firmware/src/main.c
@@ -65,6 +65,10 @@
 #include "hardware/sync.h"   // __dmb(), for the display seqlock below
 #include <string.h>
 #include <stddef.h>          // ptrdiff_t, for __wrap__sbrk() below
+#if WF_PNET_LOOP
+#include "pnet_frame.h"      // PaulaNET loopback TEST build: the cylinder-77 wire format
+#include "pnet_loop.h"       //   and its decisions
+#endif
 
 // transport_tls.c is device-only (no host test exercises it, unlike every
 // other file this task wires in), so it has no shared header of its own --
@@ -707,6 +711,11 @@
     if (outwards) { if (cur_cyl[d] > 0) cur_cyl[d]--; }
     else          { if (cur_cyl[d] < NUM_CYL - 1) cur_cyl[d]++; }
     bus_out_set_drive(d, PIN_TRK0, cur_cyl[d] == 0);
+#if WF_PNET_LOOP
+    // Loopback: DF1 is writable on cylinder 77 only, set the moment the head gets there --
+    // trackdisk reads WPROT when a write starts, and PaulaNET's driver writes right after a seek.
+    if (d == 1 && g_df1_mode == DF1_MODE_NEXT) bus_out_set_drive(1, PIN_WPROT, pnet_df1_wprot(cur_cyl[1]));
+#endif
     dskchg_on_step_d(d);
     want_track[d] = cur_cyl[d] * 2 + cur_side;
     if (d != 0) return;            // the log, the counters and the LED are DF0's
@@ -847,6 +856,12 @@
 // captured -- capturing it would apply DF1's write to DF0.
 static volatile uint32_t writes_other_drive;
 static volatile bool     write_ours;
+#if WF_PNET_LOOP
+// PaulaNET loopback (TEST build): the loop's df1_mounted, for the WGATE ISR, and whether the
+// write in progress is DF1's cylinder-77 batch -- its own flag, so write_ours stays DF0's alone.
+static volatile bool     g_pnet_df1_mounted;
+static volatile bool     pnet_write_ours;
+#endif
 
 // Written by core0 when a write lands, read by core1's uploader. g_write_gen
 // is a seqlock (write_back_gen_begin/_end, final review F1): odd from before
@@ -1228,6 +1243,24 @@
         // power-down's own fall comes before core0 can know; the capture
         // timeout and the interval floor below catch that one.)
         if (writing && g_bus_unpowered) return;
+#if WF_PNET_LOOP
+        // Loopback (TEST build): DF1 writing cylinder 77, side 0, is a PaulaNET batch -- a raw
+        // capture for pnet_take_capture(), never a disk write. Checked before the SEL0 rule
+        // below, which would count it as another drive's write and drop it.
+        if (writing && gpio_get(PIN_SEL0) &&
+            pnet_capture_ours(g_pnet_df1_mounted, false, !gpio_get(PIN_SEL1), cur_cyl[1], cur_side)) {
+            pnet_write_ours = true;
+            flux_capture_arm_raw();
+            wf_trace(WF_EV_WGATE, 1u, 0x100u | (uint32_t)PNET_TRACK_IN);
+            return;
+        }
+        if (!writing && pnet_write_ours) {
+            pnet_write_ours = false;
+            flux_capture_disarm();
+            wf_trace(WF_EV_WGATE, 0u, 0x100u | (uint32_t)PNET_TRACK_IN);
+            return;
+        }
+#endif
         /*
          * Only DF0's writes. SEL0 is read here, at interrupt time, and that is
          * enough -- unlike STEP's DIR -- because the Amiga holds the drive
@@ -2808,6 +2841,143 @@
     }
 }
 
+#if WF_PNET_LOOP
+// ---------------------------------------------------------------- PaulaNET loopback (TEST build)
+// Plan docs/superpowers/plans/2026-10-09-paulanet-phase0-loopback.md. PaulaNET protocol:
+// Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET, used with permission.
+//
+// DF1's cylinder 77 is not disk data in this build. Side 0 takes the Amiga's batch (gpio_isr arms
+// a raw capture on SEL1); side 1 streams the echo of its frames in PaulaNET's framing. All of it
+// runs on core0 -- the STEP and WGATE interrupts and this loop -- so nothing is shared with core1.
+// The decoded frames live in PSRAM, in two halves: a batch that fails to parse never touches the
+// echo being served. The echo track is built into DF1's own stream buffer, which nothing else
+// uses while the head is on cylinder 77, so the loopback adds no SRAM buffer at all.
+//
+// The marker tells scripts/firmware-release.ts (src/lib/firmware-manifest.ts) that this image is
+// a TEST build; the boot banner reads it, which keeps it in the image.
+const char wf_pnet_loop_marker[] = "wf-pnet-loop-test";
+static pnet_loop_t g_pnet;                       // core0 only
+static uint8_t     g_pnet_half;                  // the half of g_pnet_echo the echo is in
+static __uninitialized_psram("pnetecho") uint8_t g_pnet_echo[2][PNET_ECHO_BYTES];
+// One 5 s window of timings, for pnet_log_summary.
+static uint32_t g_pnet_dec_max, g_pnet_dec_sum, g_pnet_decs, g_pnet_ready_max;
+static uint32_t g_pnet_build_max, g_pnet_build_sum, g_pnet_builds, g_pnet_backlog_max;
+static bool     g_pnet_reject_logged;            // one detailed refusal per window
+
+static void pnet_reject(pnet_err_t e, const flux_capture_raw_t *cap) {
+    g_pnet.bad[e]++;
+    if (g_pnet_reject_logged) return;
+    g_pnet_reject_logged = true;
+    wf_logf(WF_WARN, "pnet: refused %s: %luB sync %lu pw %ld w %lu oor %lu%s", pnet_err_text(e),
+            (unsigned long)cap->nbytes, (unsigned long)cap->sync_ns, (long)cap->pw_ns,
+            (unsigned long)cap->words, (unsigned long)cap->out_of_range,
+            cap->overflowed ? " OVERFLOW" : "");
+}
+
+// A finished cylinder-77 write: parse it, and take its frames if the batch is new. Runs before
+// DF1 is served in the same pass, so a read of side 1 that follows at once gets this echo.
+static void pnet_take_capture(void) {
+    flux_capture_raw_t cap;
+    if (!flux_capture_take_raw(&cap)) return;
+    const uint64_t t0 = time_us_64();
+    g_pnet.rx++;
+    if (cap.max_backlog > g_pnet_backlog_max) g_pnet_backlog_max = cap.max_backlog;
+    if (!cap.sync_ok) { pnet_reject(PNET_E_NOSYNC, &cap); return; }
+    pnet_hdr_t h;
+    pnet_err_t e = pnet_parse_hdr_from_amiga(cap.bytes, cap.nbytes, &h);
+    if (e != PNET_OK) { pnet_reject(e, &cap); return; }
+    if (pnet_loop_is_new(&g_pnet, &h)) {
+        uint16_t lens[PNET_MAX_FRAMES];
+        unsigned n = 0;
+        e = pnet_parse_frames(cap.bytes + PNET_HDR_BYTES, h.compressed_size, PNET_TO_BOARD,
+                              g_pnet_echo[g_pnet_half ^ 1u], PNET_ECHO_BYTES, lens,
+                              PNET_MAX_FRAMES, &n);
+        if (e != PNET_OK) { pnet_reject(e, &cap); return; }
+        g_pnet_half ^= 1u;
+        pnet_loop_commit(&g_pnet, &h, n, lens);
+    } else {
+        pnet_loop_commit(&g_pnet, &h, 0, NULL);  // a resend: only its acknowledgement counts
+    }
+    const uint64_t now = time_us_64();
+    const uint32_t dec = (uint32_t)(now - t0), ready = (uint32_t)(now - cap.ended_us);
+    if (dec > g_pnet_dec_max) g_pnet_dec_max = dec;
+    if (ready > g_pnet_ready_max) g_pnet_ready_max = ready;
+    g_pnet_dec_sum += dec;
+    g_pnet_decs++;
+}
+
+// serve_drive(1, ...) for this build: cylinder 77 is the loopback, every other track the disk.
+static void pnet_serve_df1(int32_t tok, int *loaded) {
+    const int want = want_track[1];
+    const pnet_df1_t act = pnet_df1_for_track(want);
+    if (act == PNET_DF1_DISK) { serve_drive(1, tok, loaded); return; }
+    if (want == *loaded) return;
+    *loaded = want;
+    stream_stop(1);                              // the DMA reads track_words1: stop it first
+    if (act == PNET_DF1_SILENT) return;          // side 0: the Amiga writes, nothing to read
+    const uint64_t t0 = time_us_64();
+    pnet_frame_ref_t f[PNET_MAX_FRAMES];
+    const uint8_t *p = g_pnet_echo[g_pnet_half];
+    for (unsigned i = 0; i < g_pnet.nframes; i++) {
+        f[i].data = p;
+        f[i].len = g_pnet.len[i];
+        p += g_pnet.len[i];
+    }
+    // Built as bytes straight into the word buffer, then start_streaming repacks it IN PLACE.
+    // That is safe: its loop reads bytes 4i..4i+3 and only then writes word i, and no later
+    // word reads a byte before 4(i+1). The builder pads to whole words.
+    uint8_t *out = (uint8_t *)track_words1;
+    const size_t bytes = pnet_build_to_amiga(out, sizeof track_words1, g_pnet.last_amiga,
+                                             g_pnet.pico, 0, f, g_pnet.nframes);
+    if (bytes == 0) {
+        wf_logf(WF_ERR, "pnet: an echo of %u frames does not fit DF1's %u B buffer -- not served",
+                (unsigned)g_pnet.nframes, (unsigned)sizeof track_words1);
+        return;
+    }
+    if (!start_streaming(1, out, (uint32_t)bytes * 8u)) return;
+    // INDEX now, as PaulaNET does at the start of every transmission: the Amiga's INDEXSYNC read
+    // then starts at the lead-in instead of one whole buffer later (dma_irq's INDEX is at the wrap).
+    bus_out_set_drive(1, PIN_INDEX, true);
+    add_alarm_in_us(INDEX_PULSE_US, index_off, (void *)(uintptr_t)1u, true);
+    const uint32_t us = (uint32_t)(time_us_64() - t0);
+    if (us > g_pnet_build_max) g_pnet_build_max = us;
+    g_pnet_build_sum += us;
+    g_pnet_builds++;
+}
+
+// Every 5 s while there is traffic: counts, and the window's timings in microseconds.
+static void pnet_log_summary(void) {
+    static uint32_t last_ms, last_rx;
+    const uint32_t now = clock_ms();
+    if (now - last_ms < 5000u) return;
+    last_ms = now;
+    g_pnet_reject_logged = false;
+    if (g_pnet.rx == last_rx && g_pnet_builds == 0) return;
+    last_rx = g_pnet.rx;
+    const uint32_t *b = g_pnet.bad;
+    uint32_t bad = 0;
+    for (unsigned i = 0; i < PNET_E_COUNT; i++) bad += b[i];
+    wf_logf(WF_INFO, "pnet: rx %lu new %lu dup %lu bad %lu ctr %02x/%02x echo %u fr",
+            (unsigned long)g_pnet.rx, (unsigned long)g_pnet.fresh, (unsigned long)g_pnet.dup,
+            (unsigned long)bad, g_pnet.last_amiga, g_pnet.pico, (unsigned)g_pnet.nframes);
+    wf_logf(WF_INFO, "pnet: us dec max %lu avg %lu ready max %lu build max %lu avg %lu bl %lu",
+            (unsigned long)g_pnet_dec_max,
+            (unsigned long)(g_pnet_decs ? g_pnet_dec_sum / g_pnet_decs : 0),
+            (unsigned long)g_pnet_ready_max, (unsigned long)g_pnet_build_max,
+            (unsigned long)(g_pnet_builds ? g_pnet_build_sum / g_pnet_builds : 0),
+            (unsigned long)g_pnet_backlog_max);
+    if (bad)
+        wf_logf(WF_WARN, "pnet: bad nosync %lu magic %lu size %lu ck %lu frames %lu rle %lu full %lu",
+                (unsigned long)b[PNET_E_NOSYNC], (unsigned long)b[PNET_E_MAGIC],
+                (unsigned long)(b[PNET_E_SHORT] + b[PNET_E_SIZE] + b[PNET_E_MODE]),
+                (unsigned long)b[PNET_E_CHECKSUM],
+                (unsigned long)(b[PNET_E_FRAMES] + b[PNET_E_FRAME_SIZE]),
+                (unsigned long)b[PNET_E_RLE], (unsigned long)b[PNET_E_FULL]);
+    g_pnet_dec_max = g_pnet_dec_sum = g_pnet_decs = g_pnet_ready_max = 0;
+    g_pnet_build_max = g_pnet_build_sum = g_pnet_builds = g_pnet_backlog_max = 0;
+}
+#endif
+
 // ---------------------------------------------------------------- main
 // Defined by the SDK (hardware_psram/psram.c) but not declared in any public
 // header; normally run before main() by runtime init, which this build skips
@@ -2892,6 +3062,12 @@
                 g_df1_mode == DF1_MODE_NEXT ? "next disk of the set" : "off",
                 drv_loaded ? "stored" : "compiled default");
     }
+#if WF_PNET_LOOP
+    pnet_loop_init(&g_pnet);
+    wf_logf(WF_WARN, "%s: DF1 cylinder 77 is a PaulaNET loopback (bench only)", wf_pnet_loop_marker);
+    if (!psram_check_address(&g_pnet_echo[1][PNET_ECHO_BYTES - 1]))
+        wf_logf(WF_ERR, "pnet: the echo store is not backed by PSRAM -- the loopback will fail");
+#endif
     // One word per drive; PIN_* are board reads, so filled here, not static.
     uint32_t boot_lines[WF_DRIVES];
     boot_lines[0] = (1u << PIN_TRK0) | (1u << PIN_WPROT);   // DF0, as before
@@ -3505,8 +3681,15 @@
 #if DF1_CAPABLE
         // DF1 only while its word names a disk it holds: an empty DF1 streams
         // nothing (its want_track still follows its head).
+#if WF_PNET_LOOP
+        g_pnet_df1_mounted = df1_mounted;
+        pnet_take_capture();                     // a finished batch first: its echo may be read next
+        if (df1_mounted) pnet_serve_df1(df1_seen_tok, &loaded1);
+        pnet_log_summary();
+#else
         if (df1_mounted) serve_drive(1, df1_seen_tok, &loaded1);
 #endif
+#endif
 
         // HD spec §7 step 10: the free-heap low-water mark, logged each time
         // it drops (sampled every 5 s, so a transient dip can be missed --
```

- [ ] **Step 2: The OFF build is still master's**

Run: `wifi-floppy/firmware/tools/pnet_off_identical.sh master; echo "exit $?"`
Expected: both files `identical with WF_PNET_LOOP=0`, then `exit 0`.

- [ ] **Step 3: Both images build. The marker is in ON only; measure the SRAM cost.**

Run:
```bash
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
cd wifi-floppy/firmware
cmake --build build-pnet >/dev/null && cmake --build build >/dev/null && echo built
for b in build-pnet build; do
  echo "== $b marker=$(strings $b/wifi_floppy.bin | grep -c wf-pnet-loop-test)"
  arm-none-eabi-size -A $b/wifi_floppy.elf | grep -E '^\.(bss|data|psram_noload) '
  arm-none-eabi-nm $b/wifi_floppy.elf | grep -E ' end$'
done
```
Expected:
- `built`, with `build-pnet marker=1` and `build marker=0`.
- `.bss` +188 and `.data` +8 against `build`, and `end` 0xBC (188) bytes higher. The heap arena loses those 188 B.
- `.psram_noload` +32,768.

Values within a few bytes of these are fine. More than 512 B of new `.bss` is a defect: find the buffer that went to
SRAM.

- [ ] **Step 4: Host suite**

Run: `wifi-floppy/firmware/test/run.sh >/dev/null 2>&1; echo "exit $?"`
Expected: `exit 0`. `run.sh` also greps for `gpio_put` on bus outputs: the new code uses `bus_out_set_drive` only.

- [ ] **Step 5: Commit**

```bash
git add wifi-floppy/firmware/src/main.c
git commit -m "feat(fw): PaulaNET track-77 loopback on DF1 (WF_PNET_LOOP TEST builds only)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `NetLoop`, its helpers, and the reproducible build plus ADF

**Files:**
- Create: `tools/netloop/netloop_stats.h`, `tools/netloop/netloop_stats.c`, `tools/netloop/test_netloop_stats.c`,
  `tools/netloop/netloop.c`, `tools/netloop/build.sh`
- Output (not committed: `build/` and `*.adf` are already in `.gitignore`): `tools/netloop/build/NetLoop`,
  `tools/netloop/build/NetLoop.adf`

**Interfaces:**
- Consumes (Tasks 1-2, compiled unchanged for the 68000): `pnet_mfm.c`, `pnet_frame.c` and every `pnet_frame.h`
  function and constant.
- Produces:
  - `void nl_split(uint32_t n, uint16_t *lens, unsigned *nframes)`
  - `void nl_fill(uint32_t seed, uint8_t *out, uint32_t n)`
  - `bool nl_echo_answers(uint8_t hdr_amiga, uint8_t hdr_pico, uint8_t ctr, uint8_t last_pico)`
  - `uint8_t nl_start_ctr(bool have_board_hdr, uint8_t board_last_amiga)`
  - `uint32_t nl_percentile(uint32_t *v, unsigned n, unsigned pct)`
  - `uint32_t nl_tenths(uint64_t num, uint64_t den)`
  - The CLI `NetLoop [N=<bytes>] [ROUNDS=<n>] [READS=1|2] [SELFTEST]`, which prints `RESULT: PASS` or
    `RESULT: FAIL` last.

- [ ] **Step 1: Write the failing test** `tools/netloop/test_netloop_stats.c`. `only_this_rounds_echo_answers` is
  Review Focus 2, and `a_restart_resyncs_from_the_boards_counter` is Review Focus 3.

```c
#include "../../wifi-floppy/firmware/test/harness.h"
#include "netloop_stats.h"
#include <string.h>

static void sizes_split_into_ethernet_frames(void) {
    uint16_t l[20]; unsigned n = 0;
    nl_split(64, l, &n);
    CHECK(n == 1 && l[0] == 64, "64");
    nl_split(1500, l, &n);
    CHECK(n == 1 && l[0] == 1500, "1500");
    nl_split(8000, l, &n);
    CHECK(n == 6 && l[0] == 1500 && l[4] == 1500 && l[5] == 500, "8000 = 5 x 1500 + 500");
    nl_split(12000, l, &n);
    CHECK(n == 8 && l[7] == 1500, "12000 = 8 x 1500");
}

static void the_payload_is_repeatable_and_never_stuck(void) {
    uint8_t a[64], b[64];
    nl_fill(42, a, sizeof a);
    nl_fill(42, b, sizeof b);
    CHECK(memcmp(a, b, sizeof a) == 0, "same seed, same bytes");
    nl_fill(0, a, sizeof a);
    int nonzero = 0;
    for (unsigned i = 0; i < sizeof a; i++) nonzero |= a[i];
    CHECK(nonzero, "seed 0 does not give zeros");
}

/* Review Focus 2: an echo the board built before it decoded this round's write is stale. */
static void only_this_rounds_echo_answers(void) {
    CHECK(nl_echo_answers(5, 0x81, 5, 0x80), "acks 5, a new batch");
    CHECK(!nl_echo_answers(4, 0x80, 5, 0x80), "still the previous round's echo");
    CHECK(!nl_echo_answers(5, 0x80, 5, 0x80), "acks 5 but a batch we already had");
}

/* Review Focus 3: a restart resumes after the board's counter, never on it. */
static void a_restart_resyncs_from_the_boards_counter(void) {
    CHECK_EQ_INT(nl_start_ctr(false, 0x00), 0xFF);
    const uint8_t c = nl_start_ctr(true, 0x00);
    CHECK((uint8_t)(c + 1) != 0x00, "the next batch is new to a board that last took 0x00");
    CHECK_EQ_INT((uint8_t)(nl_start_ctr(true, 0xFF) + 1), 0x00);
}

static void percentiles_are_nearest_rank(void) {
    uint32_t v[10] = {10, 1, 9, 2, 8, 3, 7, 4, 6, 5};
    CHECK_EQ_INT(nl_percentile(v, 10, 50), 5);
    CHECK_EQ_INT(nl_percentile(v, 10, 95), 10);
    CHECK_EQ_INT(v[0], 1);
    CHECK_EQ_INT(nl_percentile(v, 0, 50), 0);
    uint32_t one[1] = {7};
    CHECK_EQ_INT(nl_percentile(one, 1, 95), 7);
}

static void tenths_round(void) {
    CHECK_EQ_INT(nl_tenths(1, 3), 3);          /* 0.33 -> 0.3 */
    CHECK_EQ_INT(nl_tenths(2, 3), 7);          /* 0.67 -> 0.7 */
    CHECK_EQ_INT(nl_tenths(5, 0), 0);
    /* 8,000 B x 100 rounds in 709,379 E-clock ticks (1 s on a PAL A500) = 781.3 KB/s */
    CHECK_EQ_INT(nl_tenths(8000ull * 100u * 709379u, 709379ull * 1024u), 7813);
}

int main(void) {
    RUN(sizes_split_into_ethernet_frames);
    RUN(the_payload_is_repeatable_and_never_stuck);
    RUN(only_this_rounds_echo_answers);
    RUN(a_restart_resyncs_from_the_boards_counter);
    RUN(percentiles_are_nearest_rank);
    RUN(tenths_round);
    return REPORT();
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cc -std=c11 -Wall -Wextra -Werror -O1 -Itools/netloop -o /tmp/tnl tools/netloop/test_netloop_stats.c tools/netloop/netloop_stats.c`
Expected: fails, because `netloop_stats.h` does not exist.

- [ ] **Step 3: Write** `tools/netloop/netloop_stats.h`

```c
#ifndef NETLOOP_STATS_H
#define NETLOOP_STATS_H
/*
 * NetLoop's pure helpers: the payload, the round's verdict and the arithmetic of its report.
 * Host-tested by test_netloop_stats.c (build.sh runs it before every Amiga build).
 * PaulaNET protocol (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET, used with
 * permission.
 */
#include <stdint.h>
#include <stdbool.h>

#define NL_FRAME_MAX 1500u   /* NetLoop's frames: an Ethernet payload's worth */

/* n bytes as frames of at most NL_FRAME_MAX, the last one shorter. n <= 20 * NL_FRAME_MAX. */
void nl_split(uint32_t n, uint16_t *lens, unsigned *nframes);
/* xorshift32 bytes from `seed` (0 is replaced: xorshift never leaves 0). */
void nl_fill(uint32_t seed, uint8_t *out, uint32_t n);
/* The echo answers round `ctr`: it acknowledges ctr, and it is a batch we have not had. */
bool nl_echo_answers(uint8_t hdr_amiga, uint8_t hdr_pico, uint8_t ctr, uint8_t last_pico);
/* The counter to continue from: the board's last-taken one when its header was read (so the next
 * batch is new to it, after a restart or Ctrl-A-A), else PaulaNET's initial 0xFF. */
uint8_t nl_start_ctr(bool have_board_hdr, uint8_t board_last_amiga);
/* Nearest-rank percentile; SORTS v. 0 for n == 0. */
uint32_t nl_percentile(uint32_t *v, unsigned n, unsigned pct);
/* round(10 * num / den): one decimal place without floating point. 0 when den == 0. */
uint32_t nl_tenths(uint64_t num, uint64_t den);
#endif
```

- [ ] **Step 4: Write** `tools/netloop/netloop_stats.c`

```c
/* NetLoop helpers -- see netloop_stats.h. */
#include "netloop_stats.h"
#include <stdlib.h>

void nl_split(uint32_t n, uint16_t *lens, unsigned *nframes) {
    unsigned k = 0;
    while (n > 0) {
        const uint32_t l = n > NL_FRAME_MAX ? NL_FRAME_MAX : n;
        lens[k++] = (uint16_t)l;
        n -= l;
    }
    *nframes = k;
}

void nl_fill(uint32_t seed, uint8_t *out, uint32_t n) {
    uint32_t x = seed ? seed : 0x9E3779B9u;
    for (uint32_t i = 0; i < n; i++) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        out[i] = (uint8_t)x;
    }
}

bool nl_echo_answers(uint8_t hdr_amiga, uint8_t hdr_pico, uint8_t ctr, uint8_t last_pico) {
    return hdr_amiga == ctr && hdr_pico != last_pico;
}

uint8_t nl_start_ctr(bool have_board_hdr, uint8_t board_last_amiga) {
    return have_board_hdr ? board_last_amiga : 0xFFu;
}

static int cmp_u32(const void *a, const void *b) {
    const uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b;
    return x < y ? -1 : x > y;
}

uint32_t nl_percentile(uint32_t *v, unsigned n, unsigned pct) {
    if (n == 0) return 0;
    qsort(v, n, sizeof *v, cmp_u32);
    unsigned rank = (unsigned)(((uint64_t)pct * n + 99u) / 100u);   /* ceil(pct% of n) */
    if (rank < 1) rank = 1;
    if (rank > n) rank = n;
    return v[rank - 1];
}

uint32_t nl_tenths(uint64_t num, uint64_t den) {
    if (den == 0) return 0;
    return (uint32_t)((num * 10u + den / 2u) / den);
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `cc -std=c11 -Wall -Wextra -Werror -O1 -Itools/netloop -o /tmp/tnl tools/netloop/test_netloop_stats.c tools/netloop/netloop_stats.c && /tmp/tnl | tail -1`
Expected: `test_netloop_stats.c: 21 checks, 0 failed`.

- [ ] **Step 6: Write the tool** `tools/netloop/netloop.c`.
  - **The round:** write the batch to track 154; read the echo from 155, either as PaulaNET's driver does (READS=2)
    or once (READS=1); then compare.
  - **Retries:** up to 3 reads per write and 3 writes per round. Stale echoes, rewrites and every failure kind are
    counted.
  - **Before the first round:** a resync from the board's header, then one warm-up round that is not counted.
  - **SELFTEST** runs the codec on the 68000 with no drive.
  - **Counters** are `unsigned long`, because this NDK's `ULONG` is `unsigned int` and `printf`'s `%lu` refuses it
    under `-Werror` (found while validating this plan).

```c
/*
 * NetLoop -- the PaulaNET track-77 loopback probe for the A500 (PaulaNET-on-DF1, Phase 0).
 * Plan: docs/superpowers/plans/2026-10-09-paulanet-phase0-loopback.md in the webadf repository.
 *
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09). Implemented from the protocol's description;
 * none of his code is in this program.
 *
 * Each round writes a batch of N payload bytes to DF1 cylinder 77 side 0 (ETD_RAWWRITE), reads
 * the board's echo from side 1 (ETD_RAWREAD with IOTDF_INDEXSYNC, then software bit alignment),
 * and checks every byte. READS=2 (default) reads as PaulaNET's own driver does: a 1,024-byte
 * header read, a seek back to side 0, then a read sized from the header. READS=1 reads once,
 * sized for the echo NetLoop expects. Times come from timer.device's E-clock.
 *
 *   NetLoop [N=<bytes>] [ROUNDS=<n>] [READS=1|2] [SELFTEST]
 */
#include <exec/types.h>
#include <exec/memory.h>
#include <exec/io.h>
#include <devices/trackdisk.h>
#include <devices/timer.h>
#include <dos/dos.h>
#include <dos/rdargs.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include <proto/timer.h>
#include <stdio.h>
#include <string.h>
#include "pnet_mfm.h"
#include "pnet_frame.h"
#include "netloop_stats.h"

static const char vers[] __attribute__((used)) =
    "$VER: NetLoop 1.0 (09.10.2026) PaulaNET protocol by RobSmithDev, used with permission";

#define DF1_UNIT    1
#define CHIP_BYTES  16896u    /* the largest write or read, rounded up */
#define ECHO_BYTES  16384u
#define MAX_N       12000u    /* the board's echo must fit DF1's 14,336-byte stream buffer */
#define MAX_ROUNDS  1000u
#define SYNC_SCAN   512u
#define HDR_READ    1024u     /* PaulaNET's driver reads at least this much for a header */
#define SEEK_TO(t)  ((ULONG)(t) * NUMSECS * TD_SECTOR)

struct Device *TimerBase;

static struct MsgPort *port;
static struct IOExtTD *td;
static struct timerequest *treq;
static BOOL td_open, timer_open;
static UBYTE *wbuf, *rbuf;    /* CHIP: Paula's disk DMA reads and writes these */
static UBYTE *payload, *echo;
static uint32_t *rtt;
static ULONG hz = 709379;

/* unsigned long, not ULONG: this NDK's ULONG is unsigned int, and printf's %lu wants long. */
static unsigned long c_ioerr, c_nosync, c_badhdr, c_stale, c_rewrites, c_mismatch, c_failed;
static uint64_t t_write, t_read, t_align;

static uint64_t ticks(void) {
    struct EClockVal ev;
    hz = ReadEClock(&ev);
    return ((uint64_t)ev.ev_hi << 32) | ev.ev_lo;
}

static void ms(uint64_t t, unsigned long *whole, unsigned long *tenth) {
    const unsigned long v = nl_tenths(t * 1000u, hz);
    *whole = v / 10u;
    *tenth = v % 10u;
}

static BYTE td_io(UWORD cmd, UBYTE flags, APTR data, ULONG len, ULONG offset) {
    td->iotd_Req.io_Command = cmd;
    td->iotd_Req.io_Flags = flags;
    td->iotd_Req.io_Data = data;
    td->iotd_Req.io_Length = len;
    td->iotd_Req.io_Offset = offset;
    td->iotd_Count = 0xFFFFFFFFul;   /* no disk-change count check, as PaulaNET's driver */
    return DoIO((struct IORequest *)td);
}

/* One INDEXSYNC read of `len` bytes from side 1: aligned, header decoded. 0 = usable. */
static int read_once(ULONG len, pnet_hdr_t *h, BOOL with_payload, size_t *valid) {
    const uint64_t t0 = ticks();
    if (td_io(ETD_RAWREAD, IOTDF_INDEXSYNC, rbuf, len, PNET_TRACK_OUT)) { c_ioerr++; return 1; }
    const uint64_t t1 = ticks();
    t_read += t1 - t0;
    const long off = pnet_find_sync(rbuf, len, SYNC_SCAN);
    if (off < 0) { c_nosync++; return 1; }
    size_t span = with_payload ? len : (size_t)(off >> 3) + PNET_HDR_MFM_BYTES + 1u;
    if (span > len) span = len;
    *valid = pnet_shift_left(rbuf, span, (size_t)off);
    const int bad = pnet_parse_hdr_to_amiga(rbuf, *valid, h, with_payload) != PNET_OK;
    t_align += ticks() - t1;
    if (bad) { c_badhdr++; return 1; }
    return 0;
}

/* 0 = the echo matches, 2 = it answered but differs. */
static int check_echo(const pnet_hdr_t *h, const uint16_t *lens, unsigned nf, ULONG n) {
    uint16_t el[PNET_MAX_FRAMES];
    unsigned en = 0;
    if (pnet_parse_frames(rbuf + PNET_HDR_MFM_BYTES, h->data_size, PNET_TO_AMIGA, echo, ECHO_BYTES,
                          el, PNET_MAX_FRAMES, &en) != PNET_OK) { c_mismatch++; return 2; }
    if (en != nf) { c_mismatch++; return 2; }
    for (unsigned i = 0; i < nf; i++) if (el[i] != lens[i]) { c_mismatch++; return 2; }
    if (memcmp(echo, payload, n) != 0) { c_mismatch++; return 2; }
    return 0;
}

/* Up to three tries at reading this round's echo. 1 = none answered. */
static int read_echo(UBYTE ctr, UBYTE last_pico, const uint16_t *lens, unsigned nf, ULONG n,
                     ULONG reads, pnet_hdr_t *h) {
    for (int r = 0; r < 3; r++) {
        size_t valid;
        ULONG len;
        if (reads == 2) {
            if (read_once(HDR_READ, h, FALSE, &valid)) continue;
            if (!nl_echo_answers(h->amiga_ctr, h->pico_ctr, ctr, last_pico)) { c_stale++; continue; }
            td_io(TD_SEEK, 0, NULL, 0, SEEK_TO(PNET_TRACK_IN));   /* as PaulaNET's driver does */
            len = (PNET_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + h->data_size + 64u + 1u) & ~1ul;
        } else {
            len = ((ULONG)pnet_to_amiga_bound(lens, nf) - PNET_TRAIL_BYTES + 32u + 1u) & ~1ul;
        }
        if (len > CHIP_BYTES) len = CHIP_BYTES;
        if (read_once(len, h, TRUE, &valid)) continue;
        if (!nl_echo_answers(h->amiga_ctr, h->pico_ctr, ctr, last_pico)) { c_stale++; continue; }
        return check_echo(h, lens, nf, n);
    }
    return 1;
}

/* One round: 0 ok, 1 failed, 2 mismatch. *took = its E-clock ticks. */
static int one_round(UBYTE *ctr, UBYTE *last_pico, ULONG n, ULONG reads, ULONG seed, uint32_t *took) {
    uint16_t lens[PNET_MAX_FRAMES];
    pnet_frame_ref_t refs[PNET_MAX_FRAMES];
    unsigned nf;
    nl_split(n, lens, &nf);
    nl_fill(seed, payload, n);
    ULONG off = 0;
    for (unsigned i = 0; i < nf; i++) { refs[i].data = payload + off; refs[i].len = lens[i]; off += lens[i]; }
    *ctr = (UBYTE)(*ctr + 1u);
    const size_t wlen = pnet_build_to_board(wbuf, CHIP_BYTES, *ctr, *last_pico, refs, nf);
    if (!wlen) return 1;
    pnet_hdr_t h;
    memset(&h, 0, sizeof h);
    const uint64_t t0 = ticks();
    int res = 1;
    for (int attempt = 0; attempt < 3 && res == 1; attempt++) {
        if (attempt) c_rewrites++;
        const uint64_t w0 = ticks();
        // A first write can find WPROT not yet released (PaulaNET's driver retries once too).
        if (td_io(ETD_RAWWRITE, 0, wbuf, wlen, PNET_TRACK_IN) &&
            td_io(ETD_RAWWRITE, 0, wbuf, wlen, PNET_TRACK_IN)) { c_ioerr++; continue; }
        t_write += ticks() - w0;
        res = read_echo(*ctr, *last_pico, lens, nf, n, reads, &h);
    }
    *took = (uint32_t)(ticks() - t0);
    if (res != 1) *last_pico = h.pico_ctr;   /* it answered: acknowledge it next round */
    return res;
}

/* Learn the board's counters, so a restarted NetLoop's first batch is new to it. */
static void resync(UBYTE *ctr, UBYTE *last_pico) {
    pnet_hdr_t h;
    size_t valid;
    *ctr = 0xFFu;
    *last_pico = 0xFFu;
    td_io(TD_SEEK, 0, NULL, 0, SEEK_TO(PNET_TRACK_IN));   /* onto cylinder 77: WPROT releases */
    if (read_once(HDR_READ, &h, FALSE, &valid) == 0) {
        *ctr = nl_start_ctr(TRUE, h.amiga_ctr);
        *last_pico = h.pico_ctr;
    }
}

static int st_fail(const char *what) {
    printf("selftest: %s\nRESULT: FAIL\n", what);
    return RETURN_FAIL;
}

/* The codec on this CPU, with no drive: build a batch, decode it as the board does, build the
 * board's echo, put it 8 bytes and 3 bits into a read, align it and check it. */
static int selftest(void) {
    uint16_t lens[PNET_MAX_FRAMES], el[PNET_MAX_FRAMES];
    pnet_frame_ref_t refs[PNET_MAX_FRAMES];
    unsigned nf, en = 0;
    const ULONG n = 4000;
    nl_split(n, lens, &nf);
    nl_fill(7, payload, n);
    ULONG off = 0;
    for (unsigned i = 0; i < nf; i++) { refs[i].data = payload + off; refs[i].len = lens[i]; off += lens[i]; }
    const size_t w = pnet_build_to_board(wbuf, CHIP_BYTES, 5, 0xFF, refs, nf);
    pnet_hdr_t h;
    if (!w || pnet_parse_hdr_from_amiga(wbuf + 4, w - 4, &h) != PNET_OK) return st_fail("to-board header");
    if (pnet_parse_frames(wbuf + 4 + PNET_HDR_BYTES, h.compressed_size, PNET_TO_BOARD, echo, ECHO_BYTES,
                          el, PNET_MAX_FRAMES, &en) != PNET_OK || en != nf || memcmp(echo, payload, n))
        return st_fail("to-board frames");
    off = 0;
    for (unsigned i = 0; i < en; i++) { refs[i].data = echo + off; refs[i].len = el[i]; off += el[i]; }
    const size_t r = pnet_build_to_amiga(rbuf + 8, CHIP_BYTES - 16u, h.amiga_ctr, 0x80, 0, refs, en);
    if (!r) return st_fail("to-amiga build");
    memset(rbuf, 0xAA, 8);
    for (size_t i = r + 8u; i-- > 1u; ) rbuf[i] = (UBYTE)((rbuf[i] >> 3) | (rbuf[i - 1] << 5));
    rbuf[0] = (UBYTE)(rbuf[0] >> 3);
    const uint64_t t0 = ticks();
    const long so = pnet_find_sync(rbuf, r + 8u, SYNC_SCAN);
    if (so < 0) return st_fail("sync not found");
    const size_t valid = pnet_shift_left(rbuf, r + 8u, (size_t)so);
    const uint64_t t1 = ticks();
    pnet_hdr_t h2;
    if (pnet_parse_hdr_to_amiga(rbuf, valid, &h2, TRUE) != PNET_OK || h2.amiga_ctr != 5 || h2.pico_ctr != 0x80)
        return st_fail("to-amiga header");
    memset(echo, 0, n);
    if (pnet_parse_frames(rbuf + PNET_HDR_MFM_BYTES, h2.data_size, PNET_TO_AMIGA, echo, ECHO_BYTES,
                          el, PNET_MAX_FRAMES, &en) != PNET_OK || en != nf || memcmp(echo, payload, n))
        return st_fail("to-amiga frames");
    const uint64_t t2 = ticks();
    unsigned long a, b, c, d;
    ms(t1 - t0, &a, &b);
    ms(t2 - t1, &c, &d);
    printf("selftest: %lu B echo, align %lu.%lu ms, parse %lu.%lu ms\n", (unsigned long)r, a, b, c, d);
    printf("RESULT: PASS\n");
    return RETURN_OK;
}

static void cleanup(void) {
    if (td_open) {
        td_io(TD_MOTOR, 0, NULL, 0, 0);      /* io_Length 0: motor off */
        CloseDevice((struct IORequest *)td);
    }
    if (timer_open) CloseDevice((struct IORequest *)treq);
    if (td) DeleteIORequest((struct IORequest *)td);
    if (treq) DeleteIORequest((struct IORequest *)treq);
    if (port) DeleteMsgPort(port);
    if (wbuf) FreeMem(wbuf, CHIP_BYTES);
    if (rbuf) FreeMem(rbuf, CHIP_BYTES);
    if (payload) FreeMem(payload, MAX_N);
    if (echo) FreeMem(echo, ECHO_BYTES);
    if (rtt) FreeMem(rtt, MAX_ROUNDS * sizeof *rtt);
}

int main(void) {
    LONG args[4] = {0, 0, 0, 0};
    struct RDArgs *rd = ReadArgs((STRPTR)"N/K/N,ROUNDS/K/N,READS/K/N,SELFTEST/S", args, NULL);
    if (!rd) { PrintFault(IoErr(), (STRPTR)"NetLoop"); return RETURN_FAIL; }
    const unsigned long n = args[0] ? (unsigned long)*(LONG *)args[0] : 64u;
    const unsigned long rounds = args[1] ? (unsigned long)*(LONG *)args[1] : MAX_ROUNDS;
    const unsigned long reads = args[2] ? (unsigned long)*(LONG *)args[2] : 2u;
    const BOOL self = args[3] != 0;
    FreeArgs(rd);
    printf("NetLoop 1.0 -- PaulaNET protocol by RobSmithDev, used with permission\n");
    if (n < 1 || n > MAX_N || rounds < 1 || rounds > MAX_ROUNDS || (reads != 1 && reads != 2)) {
        printf("N=1..%lu ROUNDS=1..%lu READS=1|2\n", (unsigned long)MAX_N, (unsigned long)MAX_ROUNDS);
        return RETURN_ERROR;
    }
    int rc = RETURN_FAIL;
    port = CreateMsgPort();
    td = port ? (struct IOExtTD *)CreateIORequest(port, sizeof *td) : NULL;
    treq = port ? (struct timerequest *)CreateIORequest(port, sizeof *treq) : NULL;
    wbuf = AllocMem(CHIP_BYTES, MEMF_CHIP | MEMF_CLEAR);
    rbuf = AllocMem(CHIP_BYTES, MEMF_CHIP | MEMF_CLEAR);
    payload = AllocMem(MAX_N, MEMF_ANY | MEMF_CLEAR);
    echo = AllocMem(ECHO_BYTES, MEMF_ANY | MEMF_CLEAR);
    rtt = AllocMem(MAX_ROUNDS * sizeof *rtt, MEMF_ANY | MEMF_CLEAR);
    if (!td || !treq || !wbuf || !rbuf || !payload || !echo || !rtt) { printf("out of memory\n"); goto out; }
    if (OpenDevice((STRPTR)TIMERNAME, UNIT_ECLOCK, (struct IORequest *)treq, 0)) {
        printf("no timer.device\n"); goto out;
    }
    timer_open = TRUE;
    TimerBase = treq->tr_node.io_Device;
    if (self) { rc = selftest(); goto out; }
    if (OpenDevice((STRPTR)TD_NAME, DF1_UNIT, (struct IORequest *)td, 0)) {
        printf("no DF1 (trackdisk.device unit 1)\n"); goto out;
    }
    td_open = TRUE;
    td_io(TD_CHANGESTATE, 0, NULL, 0, 0);
    if (td->iotd_Req.io_Actual) {
        printf("DF1 has no disk: mount a set on DF0 so DF1 gets its next disk\n"); goto out;
    }
    UBYTE ctr, last_pico;
    uint32_t took;
    resync(&ctr, &last_pico);
    one_round(&ctr, &last_pico, n, reads, 1, &took);     /* warm-up: motor, seek; not counted */
    c_ioerr = c_nosync = c_badhdr = c_stale = c_rewrites = c_mismatch = c_failed = 0;
    t_write = t_read = t_align = 0;
    printf("N=%lu ROUNDS=%lu READS=%lu\n", n, rounds, reads);
    unsigned long ok = 0, done = 0;
    uint64_t total = 0;
    for (ULONG i = 0; i < rounds; i++) {
        if (SetSignal(0, SIGBREAKF_CTRL_C) & SIGBREAKF_CTRL_C) { printf("*** Break\n"); break; }
        const int res = one_round(&ctr, &last_pico, n, reads, i * 2654435761u + 2u, &took);
        total += took;
        done++;
        if (res == 0) rtt[ok++] = took;
        else if (res == 1) c_failed++;
    }
    unsigned long a, b, c, d, e, f, g, k;
    printf("rounds %lu/%lu ok, mismatches %lu, failed %lu\n", ok, rounds, c_mismatch, c_failed);
    printf("retries: stale %lu rewrites %lu nosync %lu badhdr %lu ioerr %lu\n",
           c_stale, c_rewrites, c_nosync, c_badhdr, c_ioerr);
    const unsigned long kb = nl_tenths((uint64_t)n * ok * hz, total * 1024u);
    const unsigned long kb2 = nl_tenths((uint64_t)n * ok * 2u * hz, total * 1024u);
    printf("one-way %lu.%lu KB/s, both ways %lu.%lu KB/s (1 KB = 1024 B)\n", kb / 10u, kb % 10u,
           kb2 / 10u, kb2 % 10u);
    if (ok) {
        const unsigned long med = nl_percentile(rtt, (unsigned)ok, 50), p95 = nl_percentile(rtt, (unsigned)ok, 95);
        ms(med, &a, &b); ms(p95, &c, &d); ms(rtt[0], &e, &f); ms(rtt[ok - 1], &g, &k);
        printf("rtt ms: median %lu.%lu p95 %lu.%lu min %lu.%lu max %lu.%lu\n", a, b, c, d, e, f, g, k);
    }
    if (done) {
        ms(t_write / done, &a, &b); ms(t_read / done, &c, &d); ms(t_align / done, &e, &f);
        printf("mean ms per round: write %lu.%lu read %lu.%lu align+header %lu.%lu\n", a, b, c, d, e, f);
    }
    const BOOL pass = ok == rounds && c_mismatch == 0 && c_failed == 0;
    printf("RESULT: %s\n", pass ? "PASS" : "FAIL");
    rc = pass ? RETURN_OK : RETURN_WARN;
out:
    cleanup();
    return rc;
}
```

- [ ] **Step 7: Write the build script** `tools/netloop/build.sh` (then `chmod +x` it). It runs, in order:
  1. the host test;
  2. the pinned-digest m68k build;
  3. the ADF;
  4. the checksums;
  5. SELFTEST on an emulated 68000 under `vamos`, which is on this machine. It needs a `time.clock` shim for amitools
     0.4.0 on Python 3.9.

```bash
#!/usr/bin/env bash
# NetLoop: the PaulaNET loopback probe for the A500 (plan
# docs/superpowers/plans/2026-10-09-paulanet-phase0-loopback.md). Builds, in order:
#   1. the host test of the pure helpers (this machine's cc), and runs it;
#   2. tools/netloop/build/NetLoop with bebbo's m68k-amigaos-gcc 6.5, from a Docker image
#      pinned by digest (the same toolchain AmiTCP_NG builds with);
#   3. tools/netloop/build/NetLoop.adf with xdftool (amitools), to upload to the webadf library.
# `build.sh test` stops after 1. The codec is the board's own: wifi-floppy/firmware/src/
# pnet_mfm.c and pnet_frame.c, compiled unchanged for the 68000.
# PaulaNET protocol (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET, used with
# permission.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$here/build"
# amigadev/crosstools:m68k-amigaos, the multi-arch index as of 2026-10-09 (linux/amd64 and
# linux/arm64). A tag can move; a digest cannot.
IMG='amigadev/crosstools@sha256:bf5c0e37d2b60cf2aca93225558a7b6357e4598f8c82d04cdcb6a8268c9035d1'
mkdir -p "$out"

cc -std=c11 -Wall -Wextra -Werror -O1 -I"$here" -o "$out/test_netloop_stats" \
   "$here/test_netloop_stats.c" "$here/netloop_stats.c"
"$out/test_netloop_stats"
[ "${1:-}" = test ] && exit 0

docker run --rm -v "$root":/work -w /work "$IMG" m68k-amigaos-gcc --version | head -1
docker run --rm -v "$root":/work -w /work "$IMG" m68k-amigaos-gcc \
  -noixemul -m68000 -O2 -std=gnu11 -Wall -Werror -s \
  -I wifi-floppy/firmware/src -I tools/netloop \
  -o tools/netloop/build/NetLoop \
  tools/netloop/netloop.c tools/netloop/netloop_stats.c \
  wifi-floppy/firmware/src/pnet_mfm.c wifi-floppy/firmware/src/pnet_frame.c

rm -f "$out/NetLoop.adf"
xdftool "$out/NetLoop.adf" create + format NetLoop ffs + write "$out/NetLoop" NetLoop
xdftool "$out/NetLoop.adf" list
# The executable is reproducible (same digest, same sources -> same bytes). The ADF is not:
# xdftool stamps the volume and file dates with the time of the build.
shasum -a 256 "$out/NetLoop" "$out/NetLoop.adf"

# The selftest on an emulated 68000 (amitools' vamos, on this machine). It runs the shared codec
# big-endian, the way the A500 will. vamos 0.4.0 calls time.clock, which Python 3.9 removed; the
# shim puts it back for this run only. vamos has no E-clock, so the times print as 0.0 here.
if command -v vamos >/dev/null; then
  py="$(head -1 "$(command -v vamos)" | sed 's/^#!//')"
  "$py" - "$out/NetLoop" 2>/dev/null <<'PY' | tail -2 | tee "$out/selftest.txt"
import sys, time
time.clock = time.perf_counter
from amitools.tools.vamos import main
sys.argv = ['vamos', sys.argv[1], 'SELFTEST']
sys.exit(main())
PY
  grep -q '^RESULT: PASS' "$out/selftest.txt" || { echo "FAIL: NetLoop SELFTEST under vamos"; exit 1; }
fi
```

- [ ] **Step 8: Build, and check reproducibility**

Run: `tools/netloop/build.sh && shasum -a 256 tools/netloop/build/NetLoop > /tmp/nl1 && tools/netloop/build.sh >/dev/null && shasum -a 256 -c /tmp/nl1`
Expected:
- the host test reports `21 checks, 0 failed`;
- `m68k-amigaos-gcc (AmigaDev) 6.5.0b 20260819...`;
- `xdftool` lists `NetLoop` (about 23.5 KB, `----rwed`) on the volume `NetLoop`;
- `selftest: 4328 B echo, align 0.0 ms, parse 0.0 ms` and `RESULT: PASS` (vamos has no E-clock, so the times read
  0.0 there);
- finally `tools/netloop/build/NetLoop: OK`: the second build is byte-identical.

The first `docker run` pulls the image, about 1 GB.

- [ ] **Step 9: Commit**

```bash
git add tools/netloop/netloop.c tools/netloop/netloop_stats.h tools/netloop/netloop_stats.c \
        tools/netloop/test_netloop_stats.c tools/netloop/build.sh
git commit -m "feat(tools): NetLoop, the A500 PaulaNET loopback probe (pinned bebbo gcc, xdftool ADF, vamos selftest)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Publish the TEST build and get both halves onto the bench

**Files:** none changed. This task produces a registry entry, an install, an uploaded ADF and a serial log.

**Interfaces:**
- Consumes: Tasks 5-8. The TEST image comes from `build/`, because `firmware-release.ts` reads only
  `wifi-floppy/firmware/build`. `NetLoop.adf` comes from Task 8.
- Produces: the board running `<semver>+g<hash>` with the marker, and the Amiga with `NetLoop` in `SYS:C`.

- [ ] **Step 1: Build the TEST image in `build/`** from a clean, committed tree. The version suffix comes from
  `git describe` of the firmware subtree, so commit first. `FIRMWARE_SEMVER` stays 1.10.0; the hash tells the TEST
  build apart from the 1.10.0 release, as with 1.8.0's TEST build (HANDOFF 3bc).

Run:
```bash
git status --short     # expect nothing under wifi-floppy/firmware
export PATH="/Applications/ArmGNUToolchain/15.3.rel1/arm-none-eabi/bin:$PATH"
cd wifi-floppy/firmware
cmake -B build -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 \
      -DWF_PNET_LOOP=ON -DWF_DF1_DEFAULT=ON && cmake --build build
strings build/wifi_floppy.bin | grep -c wf-pnet-loop-test    # 1
cat build/generated/wifi_floppy_version.h | grep WF_FIRMWARE_VERSION
```
Expected:
- the marker count is `1`;
- the version reads `1.10.0+g<hash of this branch>`, with no `+dirty` and no `+nogit`.

`WF_DF1_DEFAULT=ON` matters only to a board with no stored DF1 setting; Step 4 sets it anyway.

- [ ] **Step 2: Dry run, then publish**

Run (from the repo root):
```bash
pnpm firmware:publish --dry-run --notes "TEST build: PaulaNET phase 0 loopback on DF1 cylinder 77 (bench only; never a release)"
pnpm firmware:publish --notes "TEST build: PaulaNET phase 0 loopback on DF1 cylinder 77 (bench only; never a release)"
```
Expected:
- the dry run prints the version from Step 1, and no refusal;
- the publish prints a new sequence number. Record it.
- If the dry run says "Publish refused: image is a PaulaNET loopback build", the notes do not start with
  `TEST build`.

- [ ] **Step 3: Put `build/` back to a release configuration** at once, so that no later `pnpm firmware:build` or
  publish picks up the TEST options from `CMakeCache.txt`:

Run:
```bash
cd wifi-floppy/firmware && cmake -B build -G Ninja -DPICO_SDK_PATH=$HOME/pico-sdk -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 \
  -DWF_PNET_LOOP=OFF -DWF_DF1_DEFAULT=OFF && cmake --build build >/dev/null && strings build/wifi_floppy.bin | grep -c wf-pnet-loop-test
```
Expected: `0`.

- [ ] **Step 4: Operator, one step: switch the A500 OFF.** End the turn and ask for exactly that. The install ejects
  DF0, and the idle gate needs DF0's motor off.

- [ ] **Step 5: Start the serial log, then install.**
  - Recreate `serstream.py` in this session's scratchpad if it is not there. Its full source:

```python
import os, sys, termios, time, select
dev = sys.argv[1]; secs = float(sys.argv[2]); out = open(sys.argv[3], 'ab', buffering=0)
end = time.time() + secs
while time.time() < end:
    try:
        fd = os.open(dev, os.O_RDONLY | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError:
        time.sleep(1); continue  # board rebooting: wait for the port to come back
    a = termios.tcgetattr(fd); a[3] &= ~(termios.ICANON | termios.ECHO); termios.tcsetattr(fd, termios.TCSANOW, a)
    try:
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.5)
            if r:
                try: out.write(os.read(fd, 4096))
                except BlockingIOError: pass
    except OSError:
        out.write(b'\n[serstream: port lost, reopening]\n')
    finally:
        try: os.close(fd)
        except OSError: pass
```

  - Then run `python3 <scratchpad>/serstream.py /dev/cu.usbmodem1101 7200 <scratchpad>/pnet-bench.log` in the
    background.
  - From the main checkout (`/Users/sfs/Devel/webadf`, where the untracked `.fw-target.mts` lives), run
    `pnpm exec dotenv -e .env.local -- tsx .fw-target.mts '<version from Step 1>'`, and say in the conversation that an
    install was triggered.
  - Wait for the log to show the reboot.
  - Expected in the log:
    - `wf-pnet-loop-test: DF1 cylinder 77 is a PaulaNET loopback (bench only)`;
    - a `df1:` boot line;
    - no `pnet: the echo store is not backed by PSRAM`.
  - The Devices card shows the TEST version.

- [ ] **Step 6: Operator, one step:** on the Devices card, set **DF1** to **Next disk of the set**, if it is not
  already. PASS: the card says "Set on the board". (It takes effect at the next Amiga restart, which is Step 7.)

- [ ] **Step 7: Operator, one step:** switch the A500 on and let Workbench boot from the IDE drive.
  - PASS: Workbench comes up, and the log shows `df1: next disk of the set` (live or at boot).
  - Then, in a Shell, `avail`: record the chip and fast free figures, which Phase -1 still owes.

- [ ] **Step 8: Operator, one step:** upload `tools/netloop/build/NetLoop.adf` on the Library page, and press
  **Mount** on it for the board. PASS: the card shows NetLoop in DF0.

- [ ] **Step 9: Operator, one step:** in a Shell, `copy df0:NetLoop SYS:C/` then `NetLoop SELFTEST`.
  - PASS: the last line is `RESULT: PASS`. The `align` and `parse` times are the 68000's own cost for a 4,328-byte
    echo: record them.
  - FAIL here, while Task 8's vamos run passed, would mean a real-68000 difference in the codec. Stop and report.

---

### Task 10: Bench measurements, the bar, and the record

**Files:**
- Modify: `HANDOFF.md`. Add `### 3be. PaulaNET Phase 0 ...` directly above `### 3bd.`, and update the "Amiga
  networking" backlog entry.

**Interfaces:**
- Consumes: Task 9's running bench, and the serial log `pnet-bench.log`.
- Produces: the measured numbers, the bar verdict, and the Phase 1 go/no-go question for the operator.

Every bench step below is ONE operator turn. The operator types or photographs NetLoop's last six lines:
`rounds`, `retries`, `one-way`, `rtt ms`, `mean ms per round` and `RESULT`.

- [ ] **Step 1: Operator: give DF1 a disk.** Mount **Workbench** (disk 2 of the library's Workbench 3.1 set) on DF0
  from the web. Wait about 10 s, then run `info`.
  - PASS: `info` lists DF1 with the volume **Locale**.
  - FAIL: if DF1 says "No disk present" for more than 30 s, the preload did not reach DF1 (3bc).
  - Do not open files on DF1 during this task: its cylinder 77 is the loopback, not Locale's data.

- [ ] **Step 2: Operator, three turns, one command each:** `NetLoop N=64`, then `NetLoop N=1500`, then
  `NetLoop N=8000`. Each is 1,000 round trips with READS=2, PaulaNET's own driver pattern.
  - PASS for each: `rounds 1000/1000 ok, mismatches 0, failed 0` and `RESULT: PASS`.
  - After each, check the log's `pnet:` lines:
    - `bad` should stay 0;
    - `bl` (the most unread ring words) must stay under 4096, or the capture ring overran;
    - `dec`, `ready` and `build` are the board's capture-to-ready and build times. Record their maxima.

- [ ] **Step 3: Operator, two turns:** `NetLoop N=64 READS=1`, then `NetLoop N=8000 READS=1`. Same PASS rule.
  Then evaluate the bar (ruling 2), recording every number in the table below:
  - **Throughput:** the `one-way` KB/s at **N=8000** must be at least 15.0. One-way is payload delivered in one
    direction per second; the echo carries the same bytes back, and `both ways` is twice that.
  - **Latency:** the `rtt ms: median` at **N=64**, a ping-sized round trip, must be at most 250.0.
  - **The bar is met** if READS=2 meets both: Rob's own driver would then do. If only READS=1 meets them, the bar is
    met for our own driver only. Say exactly that to the operator; it decides the Phase 2 path.

| Run | KB/s one-way | RTT median ms | RTT p95 ms | stale / rewrites | board dec / build max us |
|---|---|---|---|---|---|
| N=64 READS=2 | | | | | |
| N=1500 READS=2 | | | | | |
| N=8000 READS=2 | | | | | |
| N=64 READS=1 | | | | | |
| N=8000 READS=1 | | | | | |
| N=64 READS=2 during the DF0 copy (Step 4) | | | | | |

- [ ] **Step 4: Operator, one step: DF0 traffic at the same time** (spec §5).
  - Open a second Shell. In it, run `copy df0:#? ram:x/ ALL QUIET`.
  - At once, in the first Shell, run `NetLoop N=64 ROUNDS=200`.
  - PASS: the copy finishes with no read-error requester, and NetLoop prints `RESULT: PASS`.
  - Record the median and p95. HANDOFF expects "several hundred ms" here: this run is not held to the bar.

- [ ] **Step 5: Operator, one step: Ctrl-A-A.** After Workbench is back, run `info`, then `NetLoop N=64 ROUNDS=100`.
  - PASS: DF1 is still listed as Locale, and `RESULT: PASS`.
  - This is the restart case of Review Focus 3, on hardware: the board kept its counters, and NetLoop resynced from
    them.

- [ ] **Step 6: Read the serial log** (no operator step). First `grep -c 'records dropped' pnet-bench.log`: a log
  that dropped records proves no absence (memory: verify the capture). Then record:
  - the lowest `heap: free low-water` line. It must be at least 20,480 B (R11); below that, stop and report.
  - every `pnet: bad ...` line, with its detailed `pnet: refused <why>` partner. Each refused capture should match a
    NetLoop `stale` or `rewrite`.
  - the largest `dec`, `ready` and `build` values.

- [ ] **Step 7: Record in `HANDOFF.md`.** Add a section `### 3be. PaulaNET Phase 0 -- track-77 loopback (TEST build <version>, seq <n>)`
  directly above `### 3bd.`, containing:
  - the version and sequence;
  - Steps 1-6 as PASS or FAIL;
  - the filled-in table;
  - `avail` from Task 9 Step 7, and the SELFTEST align/parse times;
  - the heap low-water;
  - the bar verdict, worded as in Step 3;
  - this plan's "Corrections to the spec" 1-8, as one line each.

  Then add these open items for Phase 1:
  - OTA idle while networking (Correction 5);
  - DF1's 14,336-byte buffer against PaulaNET's 16,128-byte default (Correction 7);
  - INDEX at stream start (Correction 4);
  - "rollback: see Task 10 Step 9".

  In the "Amiga networking" backlog entry, replace "Plan: ...phase0-loopback.md" with "Phase 0 measured: see 3be".

- [ ] **Step 8: Commit the record**

```bash
git add HANDOFF.md
git commit -m "HANDOFF: PaulaNET Phase 0 loopback measured on the A500 -- <verdict in five words>

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Off switch and rollback.** Tell the operator both, then ask the Phase 1 question as the turn's last
  thing.
  - **Off now, at runtime:** set DF1 to **Off** on the card. In the TEST build, every loopback path requires DF1 to be
    on and to hold a disk. With DF1 off, the board behaves as the release does with DF1 off.
  - **Firmware rollback:** the registry refuses an OTA to a lower sequence (`refuseTarget` returns
    `would_roll_back`, `src/lib/firmware-update-rules.ts:64`), and rebuilding master gives the 1.10.0 release's
    existing version string. The way back is therefore a new release:
    - bump `FIRMWARE_SEMVER` to `1.10.1` on master, with `WF_PNET_LOOP` OFF;
    - build in `build/`, and check that the marker count is 0;
    - publish without `TEST build` notes;
    - with the Amiga off, target the board with `.fw-target.mts`.
  - Whether this branch is merged first, with OFF proven identical by `pnet_off_identical.sh`, is the operator's call
    together with Phase 1.
  - The question: "The bar is <met / met for our own driver only / not met>. Go to Phase 1, roll back, or keep the
    TEST build for Phase 1 development?"

---

## Self-review (done while writing this plan)

1. **Spec coverage (§8, Phase 0):**
   - "DF1 serves a test ADF on 0-74": Task 10 Step 1. It is a set's next disk; see Correction 6.
   - "capture on 77 side 0 (SEL1 arming, raw-cell classifier)": Tasks 3, 6 and 7.
   - "echo on side 1, same framing, header/counters/checksum": Tasks 2, 4 and 7.
   - "log capture-to-ready and build time": Task 7 (`ready`, `build`).
   - "host tests for classifier and framing": Tasks 1-4.
   - "NetLoop, bebbo gcc in Docker, write/read/compare, KB/s, RTT via timer.device, errors, N = 64/1500/8000":
     Task 8.
   - Accept 1 (1,000 rounds, 0 mismatches), 2 (KB/s, median, p95), 3 (during a DF0 copy) and 4 (Ctrl-A-A): Task 10,
     Steps 2-5.
   - The "two framings" item and the (b) MFM/WORDSYNC framing are removed by ruling 1.
   - The ruling's extras are covered too:
     - pinned digest and reproducible script: Task 8 Steps 7-8;
     - ADF via xdftool, served by the web app: Task 8, and Task 9 Step 8;
     - TEST-only publish: Tasks 5 and 9;
     - off switch and rollback: Task 10 Step 9;
     - OTA idle gate noted: Correction 5, and Task 10 Step 7;
     - serial via serstream: Task 9 Step 5;
     - 768 B frames: Global Constraints, and Task 5/7 builds with `-Werror=frame-larger-than`;
     - DF0 byte-identical: Tasks 6-7 with `pnet_off_identical.sh`.
2. **Placeholders:** none. The only `<...>` are values measured or assigned at run time: the version, the sequence,
   bench numbers and the verdict.
3. **Type consistency:**
   - `pnet_hdr_t` and `pnet_frame_ref_t` are used identically in Tasks 2, 4, 7 and 8.
   - `PNET_TRACK_IN`/`PNET_TRACK_OUT` live in `pnet_frame.h` and are used by `pnet_loop.c`, `main.c` and
     `netloop.c`.
   - `flux_capture_raw_t`'s fields are filled in Task 6 and read in Task 7.
   - `PNET_ECHO_BYTES` (Task 4) sizes `g_pnet_echo` (Task 7) and matches NetLoop's 16,384-byte `ECHO_BYTES`.
4. **Review Focus:** each of the five lines names a test, and each test is in its owning task's code above.
5. **Validated before writing:**
   - Every C source and test in Tasks 1-4 and 8 was compiled and run, with clang `-Wall -Wextra -Werror` and GCC 13
     `-O2`; all pass.
   - The firmware changes of Tasks 5-7 were applied to a copy of master and built ON and OFF. ON: `.bss` +188 B,
     PSRAM +32 KB. OFF preprocesses identically to master.
   - NetLoop built with the pinned image twice, byte-identical, and its SELFTEST passed on vamos's 68000.
