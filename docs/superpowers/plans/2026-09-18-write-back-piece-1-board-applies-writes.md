# Write-back piece 1: the board applies writes — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A whole, clean track the Amiga writes is re-encoded and written into the board's copy
of the disk in PSRAM, so the Amiga reads its own write back. The feature is behind
`-DWF_WRITE_BACK=ON`. Nothing is sent upstream; writes are lost at eject.

**Architecture:**
- A C port of the server's MFM track encoder (`mfm_encode_track` in `mfm.c`) turns the 11
  decoded sectors back into a standard track.
- A pure, host-tested `write_back.c` decides whether a capture may be applied (the verdict),
  and applies it (encode + `psram_image_mark_dirty`).
- `track_cache_invalidate()` drops a stale SRAM copy of a rewritten track.
- `main.c` wires these into the existing write-capture service loop and re-serves the current
  track when it was the one written.

**Tech stack:** C11, pico-sdk 2.x on RP2350, the host test harness in
`wifi-floppy/firmware/test/` (`run.sh`, `harness.h`).

**Spec:** `docs/superpowers/specs/2026-09-18-write-back-and-disk-history-design.md` §2
(decisions D5 and D6).

## Global constraints

- Host tests: `cd wifi-floppy/firmware/test && ./run.sh`. Every test is compiled with
  `-std=c11 -Wall -Wextra -Werror -DWFMF_HOST_TEST=1` against every `src/*.c` not excluded in
  `run.sh`. A new `src/*.c` is included automatically; it must therefore be host-portable, with
  no pico-sdk includes.
- Device build: `export PICO_SDK_PATH=/Users/sfs/pico-sdk`. Build options are **cached** in
  the build directory, so pass every `-DWF_*` explicitly whenever you switch variants.
- **Never `git add -A`** under `wifi-floppy/`: other sessions change this tree. Re-run
  `git status` immediately before staging, and stage explicit paths.
- Run long commands in the foreground (timeout up to 600000 ms). Do not end your turn while one
  runs, and do not use `git stash`.
- Encoder constants, verbatim from `src/lib/adfmfm/constants.ts`: `TRACK_BITS = 101344`,
  `TRACK_BYTES = 12668`, `SECTOR_MFM_BYTES = 1088`, `GAP_LEAD_BYTES = 256`, 11 sectors of
  512 bytes.
- Without `WF_WRITE_BACK`, firmware behaviour must be **exactly** as before.

---

### Task 1: The C MFM track encoder

**Files:**
- Modify: `wifi-floppy/firmware/src/mfm.h`
- Modify: `wifi-floppy/firmware/src/mfm.c`
- Test: `wifi-floppy/firmware/test/test_mfm.c`

**Interfaces:**
- Consumes: `mfm_checksum()`, `MFM_SECTORS`, `MFM_SECTOR_DATA_BYTES`, `MFM_SECTOR_MFM_BYTES`
  (existing, `mfm.h`).
- Produces:
  - `#define MFM_TRACK_BYTES 12668`
  - `#define MFM_TRACK_BITS 101344`
  - `#define MFM_GAP_LEAD_BYTES 256`
  - `void mfm_split_odd_even(const uint8_t *src, size_t n, uint8_t *dst);` (`dst` holds 2n)
  - `void mfm_fill_clock_bits(uint8_t *track, size_t len);`
  - `uint32_t mfm_encode_track(const uint8_t *data, uint8_t track_no, uint8_t *out);` —
    `data` is 5,632 bytes, `out` is `MFM_TRACK_BYTES`; returns the bit count, `MFM_TRACK_BITS`.

- [ ] **Step 1: Declare the API with a stub, so the test compiles and fails.**

In `mfm.h`, change the header comment's first line from "Amiga MFM, the WRITE direction" to
"Amiga MFM, both directions", and add a sentence saying the encoder exists so a captured write
can be re-served (write-back spec §2). Then add, before the final `#endif`:

```c
#define MFM_TRACK_BYTES      12668    /* src/lib/adfmfm TRACK_BYTES */
#define MFM_TRACK_BITS       101344   /* src/lib/adfmfm TRACK_BITS  */
#define MFM_GAP_LEAD_BYTES   256      /* src/lib/adfmfm GAP_LEAD_BYTES */

/** Odd/even bit split, per field: dst[0..n) = odd bits, dst[n..2n) = even. */
void mfm_split_odd_even(const uint8_t *src, size_t n, uint8_t *dst);

/** Fill clock bits into the 0xAA lanes over a whole assembled track, in place. */
void mfm_fill_clock_bits(uint8_t *track, size_t len);

/**
 * Encode one 5,632-byte ADF track as a standard Amiga MFM track, byte-identical
 * to src/lib/adfmfm encodeTrack() (and so to Greaseweazle). `out` must hold
 * MFM_TRACK_BYTES. Returns the track's bit count, MFM_TRACK_BITS.
 *
 * Why the board encodes at all (write-back spec D6): a captured write is
 * re-served in the one format the whole pipeline is proven on, never as the
 * Amiga's raw bitstream.
 */
uint32_t mfm_encode_track(const uint8_t *data, uint8_t track_no, uint8_t *out);
```

In `mfm.c`, append the stub:

```c
void mfm_split_odd_even(const uint8_t *src, size_t n, uint8_t *dst) { (void)src; (void)n; (void)dst; }
void mfm_fill_clock_bits(uint8_t *track, size_t len) { (void)track; (void)len; }
uint32_t mfm_encode_track(const uint8_t *data, uint8_t track_no, uint8_t *out) {
    (void)data; (void)track_no; memset(out, 0, MFM_TRACK_BYTES); return MFM_TRACK_BITS;
}
```

- [ ] **Step 2: Write the failing tests.**

In `test_mfm.c`, add these functions above `main` (`synthetic_adf`, `read_fixture`, `KINDS` and
`TRACKS_TESTED` already exist in that file):

```c
/* ------------------------------------------------------------------ */
/* The encoder must reproduce the golden tracks BYTE FOR BYTE. They are the
 * TypeScript encoder's output, asserted identical to Greaseweazle -- so this
 * checks the C port against an independent implementation, not itself. */
static void test_encoder_matches_every_golden_track(void) {
    uint8_t want[TRACK_MFM_BYTES];
    static uint8_t got[MFM_TRACK_BYTES];
    for (size_t k = 0; k < sizeof KINDS / sizeof KINDS[0]; k++) {
        uint8_t *adf = synthetic_adf(KINDS[k]);
        for (size_t t = 0; t < sizeof TRACKS_TESTED / sizeof TRACKS_TESTED[0]; t++) {
            int track_no = TRACKS_TESTED[t];
            if (!read_fixture(KINDS[k], track_no, want)) { CHECK(0, "fixture missing"); continue; }
            uint32_t bits = mfm_encode_track(adf + (size_t)track_no * TRACK_DATA_BYTES,
                                             (uint8_t)track_no, got);
            CHECK_EQ_INT(bits, MFM_TRACK_BITS);
            if (memcmp(got, want, TRACK_MFM_BYTES) != 0) {
                size_t i = 0;
                while (got[i] == want[i]) i++;
                printf("  %s track %d: first difference at byte %zu (got %02x want %02x)\n",
                       KINDS[k], track_no, i, got[i], want[i]);
                CHECK(0, "encoded track must equal the golden fixture");
            }
        }
        free(adf);
    }
}

/* encode -> decode gives back every byte, on a track no fixture covers. */
static void test_encode_then_decode_round_trips(void) {
    uint8_t *adf = synthetic_adf("prng");
    static uint8_t mfm[MFM_TRACK_BYTES];
    static uint8_t got[TRACK_DATA_BYTES];
    const int track_no = 97;
    mfm_encode_track(adf + (size_t)track_no * TRACK_DATA_BYTES, (uint8_t)track_no, mfm);
    memset(got, 0, sizeof got);
    mfm_decode_result_t r;
    mfm_decode_track(mfm, sizeof mfm, got, &r);
    CHECK_EQ_INT(r.found, 0x7ff);
    CHECK_EQ_INT(r.bad_checksums, 0);
    CHECK_EQ_INT(r.track_no, track_no);
    CHECK(memcmp(got, adf + (size_t)track_no * TRACK_DATA_BYTES, TRACK_DATA_BYTES) == 0,
          "decode(encode(x)) == x");
    free(adf);
}
```

In `main`, add after the existing `RUN(...)` lines:

```c
    RUN(test_encoder_matches_every_golden_track);
    RUN(test_encode_then_decode_round_trips);
```

- [ ] **Step 3: Run the tests and confirm they fail.**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | grep -E "test_mfm|first difference|FAIL" | head`

Expected: `test_mfm.c: N checks, M failed` with M > 0, and "first difference at byte 256"
lines: the stub emits zeros, and the first sync is at byte 256.

- [ ] **Step 4: Implement the encoder.** Replace the stub in `mfm.c` with this port of
`src/lib/adfmfm/mfm.ts` and `track.ts`:

```c
/* ---- the read direction's encoder, ported from src/lib/adfmfm ---------- */

void mfm_split_odd_even(const uint8_t *src, size_t n, uint8_t *dst) {
    for (size_t i = 0; i < n; i++) {
        dst[i]     = (uint8_t)((src[i] >> 1) & 0x55);
        dst[n + i] = (uint8_t)(src[i] & 0x55);
    }
}

/* A clock bit goes wherever neither neighbouring data bit is set. The 16-bit
 * window carries the rule across byte boundaries; the 0x4489 sync needs no
 * special case (see fillClockBits in mfm.ts for why). */
void mfm_fill_clock_bits(uint8_t *track, size_t len) {
    uint32_t y = 0;
    for (size_t i = 0; i < len; i++) {
        const uint32_t x = track[i];
        y = ((y << 8) | x) & 0xffffu;
        if ((x & 0xaau) == 0) y |= ~((y >> 1) | (y << 1)) & 0xaaaau;
        y &= 0xffu;
        track[i] = (uint8_t)y;
    }
}

static void put_be32(uint8_t *b, uint32_t v) {
    b[0] = (uint8_t)(v >> 24); b[1] = (uint8_t)(v >> 16);
    b[2] = (uint8_t)(v >> 8);  b[3] = (uint8_t)v;
}

uint32_t mfm_encode_track(const uint8_t *data, uint8_t track_no, uint8_t *out) {
    static const uint8_t label[16];            /* all zero, as encodeTrack writes */
    memset(out, 0, MFM_TRACK_BYTES);           /* the gaps are zeros before clocking */
    for (unsigned n = 0; n < MFM_SECTORS; n++) {
        const uint8_t *sd = data + (size_t)n * MFM_SECTOR_DATA_BYTES;
        /* Header: format 0xff, track, sector, sectors left to the gap. The
         * checksum covers header AND label, raw, before the split. */
        uint8_t hl[20] = { 0xff, track_no, (uint8_t)n, (uint8_t)(MFM_SECTORS - n) };
        uint8_t sum[4];
        uint8_t *p = out + MFM_GAP_LEAD_BYTES + (size_t)n * MFM_SECTOR_MFM_BYTES;
        p[0] = 0x44; p[1] = 0x89; p[2] = 0x44; p[3] = 0x89;      p += 4;
        mfm_split_odd_even(hl, 4, p);                             p += 8;
        mfm_split_odd_even(label, 16, p);                         p += 32;
        put_be32(sum, mfm_checksum(hl, 20));
        mfm_split_odd_even(sum, 4, p);                            p += 8;
        put_be32(sum, mfm_checksum(sd, MFM_SECTOR_DATA_BYTES));
        mfm_split_odd_even(sum, 4, p);                            p += 8;
        mfm_split_odd_even(sd, MFM_SECTOR_DATA_BYTES, p);
        /* The trailing 2 zero bytes split to 4 zero bytes: already zero. */
    }
    mfm_fill_clock_bits(out, MFM_TRACK_BYTES);
    return MFM_TRACK_BITS;
}
```

- [ ] **Step 5: Run the tests and confirm they pass.**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | grep -E "checks,|FAIL|CRASH"`

Expected: every line reads `0 failed`, `test_mfm.c` shows 20 more checks than before (16 bit-count checks + 4 round-trip checks), and
`run.sh` exits 0.

- [ ] **Step 6: Mutation check.** The encoder test must be able to fail. Temporarily change
`(uint8_t)(MFM_SECTORS - n)` to `(uint8_t)(MFM_SECTORS - n - 1)`. Re-run and confirm that
`test_encoder_matches_every_golden_track` fails. Then revert and re-run green.

- [ ] **Step 7: Commit.**

```bash
cd /Users/sfs/Devel/webadf && git status --short
git add wifi-floppy/firmware/src/mfm.h wifi-floppy/firmware/src/mfm.c wifi-floppy/firmware/test/test_mfm.c
git commit -m "firmware: MFM track encoder, byte-identical to the golden tracks

Ported from src/lib/adfmfm so the board can re-serve a captured write in the
one format the pipeline is proven on (write-back spec D6). Checked byte for
byte against the Greaseweazle-verified fixtures, and decode(encode(x)) == x.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Deciding and applying a write, and dropping stale SRAM copies

**Files:**
- Create: `wifi-floppy/firmware/src/write_back.h`
- Create: `wifi-floppy/firmware/src/write_back.c`
- Modify: `wifi-floppy/firmware/src/track_cache.h`, `wifi-floppy/firmware/src/track_cache.c`
- Test: `wifi-floppy/firmware/test/test_write_back.c` (new)

**Interfaces:**
- Consumes:
  - `mfm_encode_track`, `MFM_TRACK_BYTES`, `mfm_decode_track`, `mfm_decode_result_t` (Task 1
    and existing);
  - `psram_image_mark_dirty`, `psram_image_state`, `TRK_DIRTY`, `psram_token_slot`,
    `SLOT_NONE`, `psram_publish_slot`, `psram_active_token`, `psram_image_write_at`,
    `psram_image_commit`, `psram_image_set_backing` (existing, `psram_image.h`);
  - `track_cache_get` (existing).
- Produces:
  - `typedef enum { WB_APPLY = 0, WB_REJECT_NO_DISK, WB_REJECT_DISK_CHANGED, WB_REJECT_OVERFLOW, WB_REJECT_PARTIAL, WB_REJECT_INCONSISTENT, WB_REJECT_WRONG_TRACK } wb_verdict_t;`
  - `wb_verdict_t write_back_verdict(const mfm_decode_result_t *d, int head_track, bool overflowed, int32_t token_at_wgate, int32_t token_now);`
  - `const char *write_back_reason(wb_verdict_t v);`
  - `bool write_back_apply(int slot, int track, const uint8_t *adf_track);`
  - `void track_cache_invalidate(int track);`

- [ ] **Step 1: Declare the API with stubs.**

Create `src/write_back.h`:

```c
#ifndef WRITE_BACK_H
#define WRITE_BACK_H
// ---------------------------------------------------------------------------
// Applying a captured write to the board's copy of the disk -- write-back
// spec §2, piece 1. Pure and host-tested: the verdict is every decision about
// whether a capture may touch the disk, and the apply is encode + store.
//
// D5: only a whole, clean track is applied. Anything else is rejected, and the
// stored copy keeps its previous contents -- AmigaDOS reads the old data back,
// which is safer than serving damage.
// ---------------------------------------------------------------------------
#include <stdbool.h>
#include <stdint.h>
#include "mfm.h"

typedef enum {
    WB_APPLY = 0,
    WB_REJECT_NO_DISK,          // nothing mounted now
    WB_REJECT_DISK_CHANGED,     // a swap/eject landed between WGATE and now
    WB_REJECT_OVERFLOW,         // the capture ran out of room: its end is missing
    WB_REJECT_PARTIAL,          // fewer than all 11 sectors verified
    WB_REJECT_INCONSISTENT,     // sector headers disagree about the track
    WB_REJECT_WRONG_TRACK,      // a valid track, for a cylinder the head is not on
} wb_verdict_t;

// `head_track` is the track (cyl*2+side) sampled when WGATE asserted;
// `token_at_wgate` / `token_now` are psram_active_token() then and now.
wb_verdict_t write_back_verdict(const mfm_decode_result_t *d, int head_track,
                                bool overflowed, int32_t token_at_wgate,
                                int32_t token_now);

// Short, log-line sized.
const char *write_back_reason(wb_verdict_t v);

// Encode `adf_track` (MFM_TRACK_DATA_BYTES) as a standard track and store it
// in `slot` as DIRTY. True if it landed.
bool write_back_apply(int slot, int track, const uint8_t *adf_track);

#endif
```

Create `src/write_back.c`:

```c
#include "write_back.h"
wb_verdict_t write_back_verdict(const mfm_decode_result_t *d, int head_track,
                                bool overflowed, int32_t token_at_wgate,
                                int32_t token_now) {
    (void)d; (void)head_track; (void)overflowed; (void)token_at_wgate; (void)token_now;
    return WB_APPLY;
}
const char *write_back_reason(wb_verdict_t v) { (void)v; return ""; }
bool write_back_apply(int slot, int track, const uint8_t *adf_track) {
    (void)slot; (void)track; (void)adf_track; return false;
}
```

In `track_cache.h`, before `bool track_cache_image_complete(void);`, add:

```c
// Drop any SRAM copy of `track`. Needed after a write rewrites that track in
// PSRAM: track_cache_get() keys its copies on (track, token), and a write
// changes neither, so without this the OLD bytes would keep being served.
void track_cache_invalidate(int track);
```

In `track_cache.c`, add the stub `void track_cache_invalidate(int track) { (void)track; }`.

- [ ] **Step 2: Write the failing tests.** Create `test/test_write_back.c`:

```c
#include "harness.h"
#include "../src/write_back.h"
#include "../src/mfm.h"
#include "../src/flux_bits.h"
#include "../src/psram_image.h"
#include "../src/track_cache.h"
#include <stdlib.h>
#include <string.h>

/*
 * Write-back piece 1: whether a captured write may touch the disk, and what
 * applying one does. The capture-shaped test drives the same chain the
 * board runs -- flux intervals -> bits -> sectors -> verdict -> encode ->
 * PSRAM -> served track -- and checks the Amiga would read back exactly what
 * it wrote.
 */

#define CELL_NS 2000u

static mfm_decode_result_t whole(int track) {
    mfm_decode_result_t d;
    memset(&d, 0, sizeof d);
    d.found = 0x7ff; d.track_no = (uint8_t)track; d.track_no_consistent = true;
    return d;
}

static int32_t mounted_token(void) {
    psram_publish_slot(0);
    return psram_active_token();
}

static void verdict_applies_a_whole_clean_track(void) {
    int32_t tok = mounted_token();
    mfm_decode_result_t d = whole(80);
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_APPLY);
}

static void verdict_rejects_each_fault(void) {
    int32_t tok = mounted_token();
    mfm_decode_result_t d = whole(80);

    CHECK_EQ_INT(write_back_verdict(&d, 80, true, tok, tok), WB_REJECT_OVERFLOW);

    d.found = 0x7fe;                        // sector 0 missing
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_REJECT_PARTIAL);
    d.found = 0x3ff;                        // the last sector missing (2026-09-15's bug)
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_REJECT_PARTIAL);

    d = whole(80); d.track_no_consistent = false;
    CHECK_EQ_INT(write_back_verdict(&d, 80, false, tok, tok), WB_REJECT_INCONSISTENT);

    d = whole(69);                          // "track says 69, head is on 70"
    CHECK_EQ_INT(write_back_verdict(&d, 70, false, tok, tok), WB_REJECT_WRONG_TRACK);
}

static void verdict_rejects_a_write_that_outlived_its_disk(void) {
    psram_publish_slot(0);
    int32_t before = psram_active_token();
    psram_publish_slot(1);                  // a swap landed during the write
    int32_t after = psram_active_token();
    mfm_decode_result_t d = whole(10);
    CHECK_EQ_INT(write_back_verdict(&d, 10, false, before, after), WB_REJECT_DISK_CHANGED);

    psram_publish_slot(SLOT_NONE);          // an eject
    int32_t none = psram_active_token();
    CHECK_EQ_INT(write_back_verdict(&d, 10, false, none, none), WB_REJECT_NO_DISK);
}

static void every_verdict_has_a_reason(void) {
    for (int v = WB_APPLY; v <= WB_REJECT_WRONG_TRACK; v++)
        CHECK(write_back_reason((wb_verdict_t)v)[0] != '\0', "a log line needs a reason");
}

/* A disk in slot 0 whose track `t` holds the encoding of `data`. */
static void seed_track(int t, const uint8_t *data) {
    static uint8_t mfm[MFM_TRACK_BYTES];
    uint32_t bits = mfm_encode_track(data, (uint8_t)t, mfm);
    psram_image_write_at(0, t, 0, mfm, MFM_TRACK_BYTES);
    psram_image_commit(0, t, bits);
    psram_publish_slot(0);
}

static void decode_served(int t, uint8_t *out) {
    uint32_t bits = 0;
    const uint8_t *m = track_cache_get(t, &bits);
    memset(out, 0, MFM_TRACK_DATA_BYTES);
    if (!m) { CHECK(0, "track must be served"); return; }
    mfm_decode_result_t r;
    mfm_decode_track(m, (bits + 7u) / 8u, out, &r);
    CHECK_EQ_INT(r.found, 0x7ff);
    CHECK_EQ_INT(r.track_no, t);
}

static void apply_stores_dirty_and_the_new_bytes_are_served(void) {
    static uint8_t oldt[MFM_TRACK_DATA_BYTES], newt[MFM_TRACK_DATA_BYTES], got[MFM_TRACK_DATA_BYTES];
    memset(oldt, 0x11, sizeof oldt);
    for (size_t i = 0; i < sizeof newt; i++) newt[i] = (uint8_t)(i * 7u);
    seed_track(40, oldt);

    decode_served(40, got);                 // caches the OLD copy in SRAM
    CHECK(memcmp(got, oldt, sizeof got) == 0, "before: old bytes");

    CHECK(write_back_apply(0, 40, newt), "apply must land");
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_DIRTY);

    // Without invalidation the SRAM copy is stale -- this is WHY the
    // function exists. Asserted so that deleting it is a test failure.
    decode_served(40, got);
    CHECK(memcmp(got, oldt, sizeof got) == 0, "SRAM still holds the old copy");

    track_cache_invalidate(40);
    decode_served(40, got);
    CHECK(memcmp(got, newt, sizeof got) == 0, "after invalidate: the written bytes");
}

/* ---- the whole chain, from flux, on a capture shaped like a real one ---- */

static bool bit_at(const uint8_t *b, size_t i) { return (b[i >> 3] >> (7 - (i & 7))) & 1u; }

static void capture_shaped_write_applies_and_reads_back(void) {
    // What the Amiga writes: a standard track of NEW data. The capture starts
    // `skew` bits in (any edge after WGATE) -- 1-7 bits off byte alignment is
    // exactly what hid the byte-only sync search (2026-09-15).
    static uint8_t oldt[MFM_TRACK_DATA_BYTES], newt[MFM_TRACK_DATA_BYTES], got[MFM_TRACK_DATA_BYTES];
    static uint8_t wire[MFM_TRACK_BYTES], bitsbuf[MFM_TRACK_BYTES + 16];
    memset(oldt, 0, sizeof oldt);
    for (size_t i = 0; i < sizeof newt; i++) newt[i] = (uint8_t)(i ^ 0x5a);
    const int t = 123;
    seed_track(t, oldt);
    int32_t tok = psram_active_token();
    mfm_encode_track(newt, (uint8_t)t, wire);

    for (unsigned skew = 1; skew <= 7; skew++) {
        flux_bits_t f;
        flux_bits_init(&f, bitsbuf, sizeof bitsbuf);
        size_t prev = SIZE_MAX;
        for (size_t i = skew; i < sizeof wire * 8u; i++) {
            if (!bit_at(wire, i)) continue;
            if (prev != SIZE_MAX) flux_bits_feed(&f, (uint32_t)(i - prev) * CELL_NS);
            prev = i;
        }
        static uint8_t decoded[MFM_TRACK_DATA_BYTES];
        memset(decoded, 0, sizeof decoded);
        mfm_decode_result_t d;
        mfm_decode_track(bitsbuf, flux_bits_bytes(&f), decoded, &d);

        CHECK_EQ_INT(write_back_verdict(&d, t, f.overflowed, tok, psram_active_token()), WB_APPLY);
        CHECK(write_back_apply(0, t, decoded), "apply");
        track_cache_invalidate(t);
        decode_served(t, got);
        CHECK(memcmp(got, newt, sizeof got) == 0, "the Amiga reads back what it wrote");
    }
}

int main(void) {
    size_t len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS * SLOT_COUNT;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);
    track_cache_init();
    RUN(verdict_applies_a_whole_clean_track);
    RUN(verdict_rejects_each_fault);
    RUN(verdict_rejects_a_write_that_outlived_its_disk);
    RUN(every_verdict_has_a_reason);
    RUN(apply_stores_dirty_and_the_new_bytes_are_served);
    RUN(capture_shaped_write_applies_and_reads_back);
    free(mem);
    return REPORT();
}
```

Note: calling `psram_image_set_backing()` before `track_cache_init()` is correct.
`psram_image_init()` resets only the track metadata under `WFMF_HOST_TEST` and keeps the
backing (`psram_image.c`, the `#else` branch of `psram_image_init`).

- [ ] **Step 3: Run the tests and confirm they fail.**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | grep -E "test_write_back|FAIL" | head -20`

Expected: `test_write_back.c: ... failed` with a non-zero count. The stub verdict always says
`WB_APPLY`, the reasons are empty, and apply returns false.

- [ ] **Step 4: Implement.** Replace `src/write_back.c`:

```c
#include "write_back.h"
#include "psram_image.h"

wb_verdict_t write_back_verdict(const mfm_decode_result_t *d, int head_track,
                                bool overflowed, int32_t token_at_wgate,
                                int32_t token_now) {
    // Disk identity first: a write belongs to the disk that was mounted when
    // WGATE asserted, and to no other -- however good its sectors are.
    if (psram_token_slot(token_now) == SLOT_NONE) return WB_REJECT_NO_DISK;
    if (token_now != token_at_wgate)              return WB_REJECT_DISK_CHANGED;
    if (overflowed)                               return WB_REJECT_OVERFLOW;
    if (d->found != 0x7ffu)                       return WB_REJECT_PARTIAL;
    if (!d->track_no_consistent)                  return WB_REJECT_INCONSISTENT;
    // The one corruption a checksum cannot see: a valid track for a cylinder
    // the head is not on.
    if ((int)d->track_no != head_track)           return WB_REJECT_WRONG_TRACK;
    return WB_APPLY;
}

const char *write_back_reason(wb_verdict_t v) {
    switch (v) {
    case WB_APPLY:               return "applied";
    case WB_REJECT_NO_DISK:      return "no disk mounted";
    case WB_REJECT_DISK_CHANGED: return "disk changed during the write";
    case WB_REJECT_OVERFLOW:     return "capture overflowed";
    case WB_REJECT_PARTIAL:      return "not all 11 sectors verified";
    case WB_REJECT_INCONSISTENT: return "sector headers disagree about the track";
    case WB_REJECT_WRONG_TRACK:  return "sectors name another track";
    }
    return "unknown";
}

bool write_back_apply(int slot, int track, const uint8_t *adf_track) {
    // Static: 12.6 KB would not fit core0's frame. Not re-entrant, and only
    // ever called from core0's service loop.
    static uint8_t mfm[MFM_TRACK_BYTES];
    const uint32_t bits = mfm_encode_track(adf_track, (uint8_t)track, mfm);
    psram_image_mark_dirty(slot, track, mfm, bits);
    return psram_image_state(slot, track) == TRK_DIRTY;
}
```

Replace the `track_cache_invalidate` stub in `track_cache.c`:

```c
void track_cache_invalidate(int track) {
    for (int i = 0; i < 2; i++)
        if (buf[i].track == track) buf[i].track = -1;
}
```

- [ ] **Step 5: Run the tests and confirm they pass.**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | grep -E "checks,|FAIL|CRASH"`

Expected: every file `0 failed`, `test_write_back.c` listed, exit 0.

- [ ] **Step 6: Mutation checks.** Each must turn a check red; revert each one after.
1. Delete the body of `track_cache_invalidate`. Expect "after invalidate: the written bytes"
   to fail.
2. In the verdict, change `d->found != 0x7ffu` to `d->found == 0`. Expect
   `verdict_rejects_each_fault` to fail.
3. Remove the `token_now != token_at_wgate` line. Expect
   `verdict_rejects_a_write_that_outlived_its_disk` to fail.

- [ ] **Step 7: Commit.**

```bash
cd /Users/sfs/Devel/webadf && git status --short
git add wifi-floppy/firmware/src/write_back.h wifi-floppy/firmware/src/write_back.c \
        wifi-floppy/firmware/src/track_cache.h wifi-floppy/firmware/src/track_cache.c \
        wifi-floppy/firmware/test/test_write_back.c
git commit -m "firmware: decide and apply a captured write; drop stale SRAM copies

write_back_verdict applies only a whole, clean track on the disk that was
mounted at WGATE (spec D5); write_back_apply re-encodes and stores it dirty.
track_cache_invalidate exists because SRAM copies are keyed on (track, token)
and a write changes neither. Tested from flux at every bit skew.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Wire it into the firmware behind `WF_WRITE_BACK`

**Files:**
- Modify: `wifi-floppy/firmware/CMakeLists.txt` (next to the `WF_WRITE_CAPTURE` option,
  around line 103)
- Modify: `wifi-floppy/firmware/src/main.c`:
  - the flag block around line 205-273;
  - the WGATE ISR around line 521-560;
  - the service loop's write-capture block around line 1455-1525.

**Interfaces:**
- Consumes: everything Task 2 produces, plus `psram_active_token`, `psram_token_slot`.
- Produces: `-DWF_WRITE_BACK=ON` builds a firmware that applies writes. Log lines:
  `write: trk N applied`, `write: trk N rejected: <reason>`, `write: trk N apply failed (PSRAM)`.

- [ ] **Step 1: Add the CMake option.** After the `WF_WRITE_CAPTURE` block in
`CMakeLists.txt`, add:

```cmake
# Write-back piece 1 (docs/superpowers/specs/2026-09-18-write-back-and-disk-history-design.md
# §2): a whole, clean captured track is written into the board's copy of the disk, so the
# Amiga reads its own writes back. NOTHING is sent upstream yet -- writes are lost at eject.
# Implies write capture. Removed in piece 2, when writes reach the server.
option(WF_WRITE_BACK "Apply captured writes to the board's copy (lost at eject)" OFF)
if (WF_WRITE_BACK)
  target_compile_definitions(wifi_floppy PRIVATE WF_WRITE_BACK=1)
  message(WARNING "WF_WRITE_BACK is ON: writes change the board's copy of the disk and are LOST at eject.")
endif()
```

- [ ] **Step 2: Main.c flags.** After the `#ifndef WF_WRITE_CAPTURE ... #endif` block, add:

```c
/*
 * WF_WRITE_BACK -- write-back piece 1: a whole, clean captured track is
 * re-encoded and written into the ACTIVE disk copy in PSRAM, so the Amiga
 * reads back what it wrote. Nothing goes upstream: the write is lost at eject
 * or power-off. Piece 2 (upload, sessions) removes this flag.
 */
#ifndef WF_WRITE_BACK
#define WF_WRITE_BACK 0
#endif
```

Change the `WF_ACCEPTS_WRITES` definition to:

```c
#define WF_ACCEPTS_WRITES (WRITE_BACK_IMPLEMENTED || WF_WRITE_CAPTURE || WF_WRITE_BACK)
```

Add `#include "write_back.h"` beside `#include "mfm.h"`.

- [ ] **Step 3: Record the disk at WGATE.** Beside `static volatile int write_track;`, add:

```c
// The disk that was mounted when WGATE asserted. A write belongs to that disk
// and no other; write_back_verdict() rejects it if a swap landed since.
static volatile int32_t write_token;
```

In the WGATE ISR's `if (writing) {` branch, directly after `write_track = cur_cyl * 2 + cur_side;`,
add:

```c
            write_token = psram_active_token();
```

- [ ] **Step 4: Apply in the service loop.** In the write-capture block, directly after the
existing `if (d.found && !d.track_no_consistent) { ... } else if (...) { ... }` warnings and
still inside `} else if (took) {`, add:

```c
#if WF_WRITE_BACK
                {
                    const int32_t now_tok = psram_active_token();
                    const wb_verdict_t v = write_back_verdict(&d, write_track, cap.overflowed,
                                                              write_token, now_tok);
                    if (v != WB_APPLY) {
                        wf_logf(WF_WARN, "write: trk %d rejected: %s",
                                write_track, write_back_reason(v));
                    } else if (write_back_apply(psram_token_slot(now_tok), write_track, decoded)) {
                        // The SRAM copy is keyed on (track, token) and a write
                        // changes neither: drop it, and if the head is still on
                        // this track re-serve it now rather than at the next seek.
                        track_cache_invalidate(write_track);
                        if (loaded == write_track) loaded = -1;
                        wf_logf(WF_INFO, "write: trk %d applied", write_track);
                    } else {
                        wf_logf(WF_ERR, "write: trk %d apply failed (PSRAM)", write_track);
                    }
                }
#endif
```

Then replace the block comment above `flux_capture_poll();`, the one beginning "Write capture.
Two bounded steps", with:

```c
        /*
         * Write capture. Two bounded steps, both of which do nothing at all
         * unless the Amiga is writing.
         *
         * With WF_WRITE_BACK, a whole, clean track is applied to the board's
         * copy of the disk (write-back spec §2); anything else is rejected and
         * logged. Without it, the capture is decoded and LOGGED only -- the
         * behaviour of the WF_WRITE_CAPTURE diagnostic build.
         *
         * Re-serving a rewritten track restarts the stream mid-revolution: one
         * torn revolution if the Amiga reads that track at that instant, which
         * trackdisk retries. It has just finished writing it, so it rarely is.
         */
```

Also update the `WRITE_BACK_IMPLEMENTED` comment (around line 205). Replace its first sentence
with: "Write-back to the SERVER does not exist yet (piece 2 of the write-back spec). With
WF_WRITE_BACK the board applies writes to its own copy, and they are lost at eject."

- [ ] **Step 5: Host tests still green.**

Run: `cd wifi-floppy/firmware/test && ./run.sh 2>&1 | grep -E "FAIL|CRASH"; echo exit=$?`

Expected: no output lines before `exit=`. `main.c` is not in the host build, so this only
proves nothing else broke.

- [ ] **Step 6: Build all variants.** Run each in the foreground:

```bash
cd /Users/sfs/Devel/webadf/wifi-floppy/firmware && export PICO_SDK_PATH=/Users/sfs/pico-sdk
cmake -S . -B build -DWF_BUS_SNIFF=OFF -DWF_WRITE_CAPTURE=OFF -DWF_VERIFY_TRACKS=OFF -DWF_WRITE_BACK=OFF >/dev/null && cmake --build build -j8 2>&1 | grep -E "error:|warning:"; ls -la build/wifi_floppy.uf2
cmake -S . -B "$TMPDIR/wf-wb" -G Ninja -DPICO_BOARD=pimoroni_pico_plus2_w_rp2350 -DWF_BUS_SNIFF=OFF -DWF_WRITE_CAPTURE=OFF -DWF_VERIFY_TRACKS=OFF -DWF_WRITE_BACK=ON >/dev/null && cmake --build "$TMPDIR/wf-wb" -j8 2>&1 | grep -E "error:|warning:"; ls -la "$TMPDIR/wf-wb/wifi_floppy.uf2"
```

Expected: no `error:` or `warning:` lines, and both `.uf2` files exist. The write-back build
goes to `$TMPDIR`, **not** into the repo tree: variant build directories are not gitignored.

- [ ] **Step 7: The normal build is unchanged in behaviour.** Confirm that
`grep -c "write_back_verdict" build/wifi_floppy.dis` prints `0`, where
`build/wifi_floppy.dis` is the disassembly the pico build emits. If the build emits no `.dis`,
use `arm-none-eabi-nm build/wifi_floppy.elf | grep -c write_back_verdict` instead. Either way,
the verdict must not be linked without the flag.

- [ ] **Step 8: Commit.**

```bash
cd /Users/sfs/Devel/webadf && git status --short
git add wifi-floppy/firmware/CMakeLists.txt wifi-floppy/firmware/src/main.c
git commit -m "firmware: apply captured writes to the board's copy (WF_WRITE_BACK)

Behind -DWF_WRITE_BACK=ON: a whole, clean track is re-encoded into the active
PSRAM slot, its SRAM copy dropped, and re-served if the head is still on it.
The disk at WGATE is recorded so a write never lands on a disk swapped in
since. Nothing goes upstream; writes are lost at eject. Default build
unchanged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Hardware acceptance and handoff

This task needs the operator: only they can power the Amiga and type on it. **End the turn
with the request; never ask mid-turn.**

**Files:**
- Modify: `HANDOFF.md` (a new `### 4f` above `### 4e`)

- [ ] **Step 1: Prepare the disk on the server.** In the web UI, mark a **scratch** Workbench
disk writable. That is the disk's write-protect toggle; it must be a disk the operator does
not mind, even though the server copy is never changed in piece 1. Then mount it on the board.
The flag is read at mount: live propagation is piece 2.

- [ ] **Step 2: Flash the write-back build and start the capture in the same command.** Run
it in the background, writing the log to the scratchpad:

```bash
picotool load -f -x "$TMPDIR/wf-wb/wifi_floppy.uf2"; for i in $(seq 1 40); do [ -e /dev/cu.usbmodem101 ] && break; sleep 0.25; done; stty -f /dev/cu.usbmodem101 115200 raw -echo; exec cat /dev/cu.usbmodem101 > <scratchpad>/wb.log
```

Confirm that the log shows `wprot: RELEASED` for the mounted disk, and read the
`pio claims:` line.

- [ ] **Step 3: Ask the operator** (as the last thing in the turn) to:
1. Power on the Amiga and boot Workbench from DF0.
2. In a Shell, run `echo "written by the amiga" >SYS:wb-test`, then `type SYS:wb-test`.
3. **Reset the Amiga** (Ctrl-Amiga-Amiga). This throws away AmigaDOS's own buffers, so the
   next read must come from the board. After the reboot, run `type SYS:wb-test` again.
4. Run `Copy SYS:Utilities RAM:u ALL`, then `Delete SYS:Utilities ALL`, then
   `Copy RAM:u SYS:Utilities ALL`, reset again, and `dir SYS:Utilities`.
5. Report what each command printed.

- [ ] **Step 4: Check the log.**
- There must be zero `rejected` lines. If there are any, quote each one with its reason.
- Count the `applied` lines.
- There must be 0 `TRACK-MISS` and 0 `record(s) dropped` in the write window.
- There must be 0 `apply failed`.

Acceptance passes when step 3's text survives both resets and the `Utilities` listing is
complete.

- [ ] **Step 5: Restore the normal firmware.** Flash `build/wifi_floppy.uf2` (without
`WF_WRITE_BACK`) and confirm `wprot: ASSERTED`. Tell the operator that the writes existed only
on the board and are gone. Suggest they set the scratch disk back to write-protected.

- [ ] **Step 6: Record it.** Add HANDOFF `### 4f. THE BOARD APPLIES WRITES — <date>` with:
- the acceptance steps and their results, with counts;
- the commits;
- what is still not done: pieces 2 and 3 of the spec.

Commit and push. Pushing `master` deploys production; the web app is unchanged by this piece,
so say so in the report.
