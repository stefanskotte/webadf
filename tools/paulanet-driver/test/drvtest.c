/*
 * drvtest: the driver variant's LZ4 half (src/webadf_lz4.c, with m68k/lz4/lz4_68k.asm) against the board's own C
 * (wifi-floppy/firmware/src: pnet_pack.c, pnet_lz4.c, pnet_frame.c, pnet_mfm.c), on the CPU vamos emulates
 * (tools/paulanet-driver/test.sh: a 68000, a 68020, a 68040). Copyright (c) 2026 Stefan Skotte and contributors. MIT.
 */
#include <exec/types.h>
#include <exec/execbase.h>
#include <stdio.h>
#include <string.h>
#include "webadf_lz4.h"
#include "lz4_68k.h"
#include "pnet_pack.h"
#include "pnet_mfm.h"
#include "lz4_corpus.h"   /* lc_frame, the LC_ kinds, SAME_SIZE */

extern struct ExecBase *SysBase;
static int checks, failed;
#define CHECK(c, m) do { checks++; if (!(c)) { failed++; printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, (m)); } } while (0)

#define ALL40 (AFF_68010 | AFF_68020 | AFF_68030 | AFF_68040)
#define MEM_BYTES (2UL * 4096 + 2UL * (16128 + 1540))
static UBYTE g_frames[PNET_MAX_FRAMES][WL_MTU];
static UBYTE g_win[PNET_LZ4_WINDOW], g_blk[PNET_LZ4_WINDOW], g_scr[PNET_LZ4_BLOCK_MAX];
static uint16_t g_tab[PNET_LZ4_TABLE_ENTRIES];
/* ULONG arrays: long aligned, as the driver's AllocMem block is and as Rob's UWORD *pkt is word aligned. vamos does
 * not trap an odd word access, so the alignment is guaranteed here, not left to the linker. The driver's block sits in
 * an arena with GUARD canary bytes either side of exactly wl_mem_bytes(attn) bytes (mem_for): a write outside the
 * allocation, below it or past it, shows in guards_ok. */
#define GUARD 2048UL
static ULONG g_arena_l[(2 * GUARD + MEM_BYTES) / 4];
static ULONG g_track_l[26000 / 4];
static ULONG g_wire_l[4096 / 4];
#define g_arena ((UBYTE *)g_arena_l)
#define g_track ((UBYTE *)g_track_l)
#define g_wire  ((UBYTE *)g_wire_l)
static ULONG g_memb;
static pnet_pack_t g_pk;

static UBYTE *mem_for(UWORD attn) {
    g_memb = wl_mem_bytes(attn);
    memset(g_arena, 0xA5, GUARD);
    memset(g_arena + GUARD + g_memb, 0xA5, GUARD);
    return g_arena + GUARD;
}
static int guards_ok(void) {
    ULONG i;
    for (i = 0; i < GUARD; i++)
        if (g_arena[i] != 0xA5 || g_arena[GUARD + g_memb + i] != 0xA5) return 0;
    return 1;
}

static void gate(void) {
    struct WlRx rx; struct WlTx tx;
    CHECK(WL_WINDOW == PNET_LZ4_WINDOW && WL_BLOCK_MAX == PNET_LZ4_BLOCK_MAX, "the board's sizes");
    CHECK(wl_table_entries(0) == 0, "68000: no LZ4 upload");
    CHECK(wl_table_entries(AFF_68010) == 0, "68010: no LZ4 upload");
    CHECK(wl_table_entries(AFF_68010 | AFF_68020) == 1024, "68020: 1,024 entries");
    CHECK(wl_table_entries(AFF_68010 | AFF_68020 | AFF_68030) == 1024, "68030: 1,024 entries");
    CHECK(wl_table_entries(ALL40) == 4096, "68040: 4,096 entries");
    CHECK(wl_mem_bytes(0) == WL_WINDOW + WL_BLOCK_MAX, "68000: the download window only");
    CHECK(wl_mem_bytes(ALL40) == MEM_BYTES, "the 68040 allocation");
    wl_init(&rx, &tx, mem_for(ALL40), ALL40);
    wl_tx_begin(&tx, 0);
    CHECK(!tx.on, "a board without byte 155's bit 1 (1.15.0, Rob's): RLE, even on a 68040");
    wl_tx_begin(&tx, WL_ST_LZ4_IN);
    CHECK(tx.on, "a board that takes LZ4");
    wl_init(&rx, &tx, mem_for(0), 0);
    wl_tx_begin(&tx, WL_ST_LZ4_IN);
    CHECK(!tx.on, "a 68000 never uploads LZ4");
    CHECK(wl_wire_bytes(0xC000 | 700) == 1400 && wl_wire_bytes(0x8000 | 2400) == 2400 && wl_wire_bytes(0x0123) == 0x123,
          "wire bytes");
}

/* Review Focus, sizes at the edges: a block as long as the RLE goes as the RLE. */
static void equal(void) {
    struct WlRx rx; struct WlTx tx;
    UBYTE body[32];
    wl_init(&rx, &tx, mem_for(AFF_68010 | AFF_68020), AFF_68010 | AFF_68020);
    memset(tx.table, 0, 2 * tx.entries);
    wl_tx_begin(&tx, WL_ST_LZ4_IN);
    CHECK(wl_tx_frame(&tx, SAME_SIZE, 20, body, 20) == 0, "LZ4 20 B against RLE 20 B: RLE");
    memset(tx.table, 0, 2 * tx.entries);
    wl_tx_begin(&tx, WL_ST_LZ4_IN);
    CHECK(wl_tx_frame(&tx, SAME_SIZE, 20, body, 21) == 20, "against RLE 21 B: LZ4");
}

/* Review Focus, zero runs: text ending in 11 zero bytes compresses, but its block ends in a run the board cannot time. */
static void zerorun(void) {
    struct WlRx rx; struct WlTx tx;
    static UBYTE body[WL_MTU + 16];
    ULONG z;
    wl_init(&rx, &tx, mem_for(AFF_68010 | AFF_68020), AFF_68010 | AFF_68020);
    lc_frame(g_frames[0], 1200, LC_TEXT_ZERO_TAIL, 7);
    memset(tx.table, 0, 2 * tx.entries);
    z = lz4_encode_linked(g_frames[0], 1200, g_blk, 1199, tx.table, tx.entries, g_frames[0]);
    CHECK(z != 0 && wl_zero_run(g_blk, z) > WL_ZERO_RUN_MAX, "the fixture's block carries 6+ zero bytes in a row");
    memset(tx.table, 0, 2 * tx.entries);
    wl_tx_begin(&tx, WL_ST_LZ4_IN);
    CHECK(wl_tx_frame(&tx, g_frames[0], 1200, body, 1210) == 0, "so the frame goes RLE");
}

/* The zero-run guard counts the word pad (pre-flight F7): a block ending in exactly 5 zero bytes is fine at an even
 * length, but at an odd length its 0x00 pad makes the run on the wire 6. Text frames ending in 5 zeros are searched
 * for one block of each parity (the last 5 bytes of a block are always literals, so the block ends in those zeros). */
static void padtail(void) {
    struct WlRx rx; struct WlTx tx;
    static UBYTE body[WL_MTU + 16];
    int found[2] = { 0, 0 };
    UWORD len;
    wl_init(&rx, &tx, mem_for(AFF_68010 | AFF_68020), AFF_68010 | AFF_68020);
    for (len = 200; len < 1400 && !(found[0] && found[1]); len++) {
        ULONG z, odd;
        UWORD got;
        lc_frame(g_frames[0], len, LC_TEXT, len);
        memset(g_frames[0] + len - 5, 0, 5);
        memset(tx.table, 0, 2 * tx.entries);
        z = lz4_encode_linked(g_frames[0], len, g_blk, (ULONG)len - 1, tx.table, tx.entries, g_frames[0]);
        if (z < 6 || wl_zero_run(g_blk, z) != 5 || g_blk[z - 6] == 0) continue;   /* exactly 5 zeros, at the tail */
        odd = z & 1;
        if (found[odd]) continue;
        found[odd] = 1;
        memset(tx.table, 0, 2 * tx.entries);
        wl_tx_begin(&tx, WL_ST_LZ4_IN);
        got = wl_tx_frame(&tx, g_frames[0], len, body, (UWORD)(z + 10));
        if (odd) {
            CHECK(got == 0, "5 zeros at the end of an odd block, plus the 0x00 pad, are 6 on the wire: RLE");
        } else {
            CHECK(got == z && memcmp(body, g_blk, z) == 0, "5 zeros at the end of an even block (no pad): LZ4");
            CHECK(wl_zero_run(body, z) == WL_ZERO_RUN_MAX, "the run it carries is the limit, no more");
        }
    }
    CHECK(found[0] && found[1], "a block of each parity ending in 5 zero bytes");
}

/* Board -> Amiga, one batch on `rx` (wl_rx_begin'd here, as the glue does per batch): the board packs and builds; the
 * driver reads the payload as paulaNetReceivePackets does (wl_wire_bytes, wl_rx_frame) and gets every frame back. */
static void down_batch(struct WlRx *rx, int lz4, const int *kinds, const UWORD *lens, unsigned n, unsigned seed,
                       unsigned *nlz4) {
    pnet_frame_ref_t in[PNET_MAX_FRAMES];
    const pnet_pack_mem_t m = { g_win, g_blk, g_tab, PNET_LZ4_TABLE_ENTRIES };
    const UBYTE *pay;
    UBYTE ph[2];
    size_t pos = 4;
    unsigned i;
    for (i = 0; i < n; i++) {
        lc_frame(g_frames[i], lens[i], kinds[i], seed + i);
        in[i].data = g_frames[i];
        in[i].len = lens[i];
    }
    pnet_pack(&g_pk, &m, lz4 != 0, in, n, sizeof g_track_l);
    CHECK(g_pk.n == n, "the whole set is one batch");
    CHECK(pnet_build_to_amiga_out(g_track, sizeof g_track_l, 1, 2, 0, g_pk.f, g_pk.n) != 0, "built");
    pay = g_track + PNET_LEAD_BYTES + 4 + PNET_HDR_MFM_BYTES;   /* past the lead-in, the sync and the header */
    pnet_mfm_decode(pay, 2, ph);
    CHECK(ph[0] == g_pk.n, "frame count");
    wl_rx_begin(rx);
    *nlz4 = 0;
    for (i = 0; i < g_pk.n; i++) {
        UBYTE ch[4];
        UWORD field, orig, wire;
        const UBYTE *got;
        pnet_mfm_decode(pay + pos, 4, ch);
        field = (UWORD)(ch[0] << 8 | ch[1]);
        orig = (UWORD)(ch[2] << 8 | ch[3]);
        wire = wl_wire_bytes(field);
        CHECK((field & 0x8000) != 0, "toward the Amiga every frame is MFM on the wire");
        CHECK((((ULONG)(pay + pos + 8)) & 1) == 0, "the frame's wire is word aligned, as Rob's UWORD *pkt is");
        if ((field & 0xC000) == 0xC000) (*nlz4)++;
        got = wl_rx_frame(rx, field, pay + pos + 8, orig);
        CHECK(got != 0 && orig == in[i].len && memcmp(got, in[i].data, orig) == 0, "the frame back on the Amiga");
        pos += 8u + wire + (wire & 1u);
    }
}

static void down(int lz4, const int *kinds, const UWORD *lens, unsigned n, unsigned *nlz4) {
    struct WlRx rx; struct WlTx tx;
    wl_init(&rx, &tx, mem_for(SysBase->AttnFlags), SysBase->AttnFlags);
    down_batch(&rx, lz4, kinds, lens, n, 1, nlz4);
    CHECK(guards_ok(), "down: nothing written outside the driver's allocation");
}

/* Review I2, down: two full batches on one WlRx. 6 x 1,518 B a batch: the second only fits the window, so only
 * decodes, when wl_rx_begin started it at 0 again. */
static void down2(void) {
    static const int k[6] = { LC_TEXT, LC_HTML, LC_TEXT, LC_HTML, LC_TEXT, LC_HTML };
    static const UWORD l[6] = { 1518, 1518, 1518, 1518, 1518, 1518 };
    struct WlRx rx; struct WlTx tx;
    unsigned b, nz;
    wl_init(&rx, &tx, mem_for(SysBase->AttnFlags), SysBase->AttnFlags);
    for (b = 0; b < 2; b++) {
        down_batch(&rx, 1, k, l, 6, 40, &nz);
        CHECK(nz == 6, "two batches down: every frame LZ4, every frame back");
    }
    CHECK(guards_ok(), "two batches down: nothing written outside the allocation");
}

/* One frame's LZ4 block (standalone), MFM-encoded into g_wire. Returns the block's length. */
static ULONG lz4_wire(const UBYTE *f, UWORD len) {
    uint16_t last = 0;
    ULONG z = lz4_encode_linked(f, len, g_blk, PNET_LZ4_BLOCK_MAX, g_tab, PNET_LZ4_TABLE_ENTRIES, f);
    pnet_mfm_encode(g_blk, z, g_wire, &last);
    return z;
}
static void mfm_wire(const UBYTE *f, UWORD len) {
    uint16_t last = 0;
    pnet_mfm_encode(f, len, g_wire, &last);
}

/* Review I1: a board that sends what it should not. Each frame is refused (0), leaves the window broken, and writes
 * nothing outside the exact-size allocation (a 68000's: the download window and the scratch, nothing after). */
static void hostile(void) {
    struct WlRx rx; struct WlTx tx;
    static const UBYTE below[10] = { 0x10, 'A', 0x05, 0x00, 0x50, 'a', 'b', 'c', 'd', 'e' };  /* offset 5 after 1 B */
    UBYTE *const rnd = g_frames[0], *const txt = g_frames[1];
    ULONG z, zt;
    const UBYTE *got;
    wl_init(&rx, &tx, mem_for(0), 0);
    lc_frame(rnd, 1000, LC_RANDOM, 9);
    lc_frame(txt, 100, LC_TEXT, 9);
    z = lz4_wire(rnd, 1000);
    CHECK(z > 1000 && z <= WL_BLOCK_MAX, "the random frame's block: literals only");
    wl_rx_begin(&rx);
    got = wl_rx_frame(&rx, (UWORD)(0xC000 | z), g_wire, 1000);
    CHECK(got != 0 && memcmp(got, rnd, 1000) == 0 && rx.pos == 1000, "baseline: the well-formed frame decodes");

    rx.pos = 16000;                                       /* A: an LZ4 frame that would end past the window */
    CHECK(wl_rx_frame(&rx, (UWORD)(0xC000 | z), g_wire, 1000) == 0 && rx.pos == WL_BROKEN,
          "an LZ4 frame past the window's end: refused");
    CHECK(wl_rx_frame(&rx, (UWORD)(0xC000 | z), g_wire, 1000) == 0 && rx.pos == WL_BROKEN,
          "an LZ4 frame after the window broke: refused");
    wl_rx_begin(&rx);
    CHECK(wl_rx_frame(&rx, (UWORD)(0xC000 | (WL_BLOCK_MAX + 1)), g_wire, 1000) == 0 && rx.pos == WL_BROKEN,
          "a block of 1,541 B: refused");
    wl_rx_begin(&rx);
    CHECK(wl_rx_frame(&rx, (UWORD)(0xC000 | z), g_wire, 0) == 0 && rx.pos == WL_BROKEN, "LZ4, orig 0: refused");
    mfm_wire(rnd, 1000);
    wl_rx_begin(&rx);
    CHECK(wl_rx_frame(&rx, (UWORD)(0x8000 | 2000), g_wire, 0) == 0 && rx.pos == WL_BROKEN, "MFM, orig 0: refused");
    wl_rx_begin(&rx);                                     /* I: 1,519 bytes, MFM, as long as it says */
    CHECK(wl_rx_frame(&rx, (UWORD)(0x8000 | 3038), g_wire, 1519) == 0 && rx.pos == WL_BROKEN,
          "MFM, orig 1,519 (over the MTU): refused");
    wl_rx_begin(&rx);                                     /* B: 100 bytes said, 50 sent */
    CHECK(wl_rx_frame(&rx, (UWORD)(0x8000 | 100), g_wire, 100) == 0 && rx.pos == WL_BROKEN,
          "MFM, size word under 2 x orig: refused");

    z = lz4_wire(txt, 100);                               /* truncated and corrupt blocks */
    wl_rx_begin(&rx);
    CHECK(wl_rx_frame(&rx, (UWORD)(0xC000 | (z - 1)), g_wire, 100) == 0 && rx.pos == WL_BROKEN, "a truncated block");
    g_blk[0] ^= 0xFF;
    { uint16_t last = 0; pnet_mfm_encode(g_blk, z, g_wire, &last); }
    wl_rx_begin(&rx);
    CHECK(wl_rx_frame(&rx, (UWORD)(0xC000 | z), g_wire, 100) == 0 && rx.pos == WL_BROKEN, "a corrupt token");
    { uint16_t last = 0; pnet_mfm_encode(below, sizeof below, g_wire, &last); }
    wl_rx_begin(&rx);
    CHECK(wl_rx_frame(&rx, (UWORD)(0xC000 | sizeof below), g_wire, 10) == 0 && rx.pos == WL_BROKEN,
          "a match reaching below the window");

    /* J: an MFM frame that does not fit is handed over (from the scratch) but breaks the window: an LZ4 frame after it
     * that would fit the space left is refused. */
    zt = lz4_wire(txt, 100);
    memcpy(g_wire + 2048, g_wire, 2 * zt);
    mfm_wire(rnd, 500);
    wl_rx_begin(&rx);
    rx.pos = 16000;
    got = wl_rx_frame(&rx, (UWORD)(0x8000 | 1000), g_wire, 500);
    CHECK(got != 0 && memcmp(got, rnd, 500) == 0 && rx.pos == WL_BROKEN, "an MFM frame past the window: handed over");
    CHECK(wl_rx_frame(&rx, (UWORD)(0xC000 | zt), g_wire + 2048, 100) == 0, "...and no LZ4 frame after it");
    CHECK(guards_ok(), "hostile input: nothing written outside the 68000's exact allocation");
}

/* Amiga -> board, one batch on `tx` (wl_tx_begin'd here; the table is kept, as the driver keeps it): the frames in
 * g_frames[0..n) are packed as paulaNetAddPacket does (RLE first -- pnet_rle_encode is Rob's format -- then
 * wl_tx_frame) and the board's pnet_lz4_iter_next, its window reset for the batch, reads every frame back. z[i] gets
 * each frame's block length (0: RLE). Returns frames sent LZ4. */
static unsigned up_batch(struct WlTx *tx, const UWORD *lens, unsigned n, UWORD *zs) {
    pnet_frame_iter_t it;
    pnet_lz4_win_t w;
    const UBYTE ph[2] = { (UBYTE)n, 0 };
    uint16_t last = 0;
    size_t pos;
    unsigned i, nz = 0;
    wl_tx_begin(tx, WL_ST_LZ4_IN);
    pos = pnet_mfm_encode(ph, 2, g_track, &last);
    for (i = 0; i < n; i++) {
        UBYTE *body = g_track + pos + 8;
        UWORD rle, z, field, wire;
        UBYTE ch[4];
        rle = (UWORD)pnet_rle_encode(g_frames[i], lens[i], body);
        z = wl_tx_frame(tx, g_frames[i], lens[i], body, rle);
        field = z ? (UWORD)(WL_SIZE_LZ4 | z) : (UWORD)(0x8000 | rle);
        wire = z ? z : rle;
        if (wire & 1) body[wire++] = 0;                   /* the word pad (wl_tx_frame wrote it already for a block) */
        ch[0] = (UBYTE)(field >> 8); ch[1] = (UBYTE)field; ch[2] = (UBYTE)(lens[i] >> 8); ch[3] = (UBYTE)lens[i];
        last = 0;
        pnet_mfm_encode(ch, 4, g_track + pos, &last);
        pos += 8u + wire;
        zs[i] = z;
        if (z) {
            nz++;
            CHECK(wl_zero_run(body, wire) <= WL_ZERO_RUN_MAX, "a raw block on the wire, pad included, within the run");
        }
    }
    w.win = g_win; w.pos = 0; w.scratch = g_scr;
    CHECK(pnet_frame_iter_init(&it, g_track, pos, PNET_TO_BOARD) == PNET_OK, "the board reads the batch");
    for (i = 0; i < n; i++) {
        static UBYTE out[WL_MTU];
        uint16_t l = 0;
        bool was = false;
        CHECK(pnet_lz4_iter_next(&it, &w, out, sizeof out, &l, &was) == PNET_OK, "a frame");
        CHECK(l == lens[i] && memcmp(out, g_frames[i], l) == 0, "the frame back on the board");
    }
    return nz;
}

static unsigned up(UWORD attn, const int *kinds, const UWORD *lens, unsigned n) {
    struct WlRx rx; struct WlTx tx;
    UWORD zs[PNET_MAX_FRAMES];
    unsigned i, nz;
    wl_init(&rx, &tx, mem_for(attn), attn);
    for (i = 0; i < n; i++) lc_frame(g_frames[i], lens[i], kinds[i], 100u + i);
    nz = up_batch(&tx, lens, n, zs);
    for (i = 0; i < n; i++)
        if (kinds[i] == LC_TEXT_ZERO_TAIL) CHECK(zs[i] == 0, "a block with a long zero run never goes raw");
    CHECK(guards_ok(), "up: nothing written outside the driver's allocation");
    return nz;
}

#define UP_ATTN (AFF_68010 | AFF_68020)

/* Review I3: uploads link. A copy of an earlier frame of random bytes goes LZ4 in a few bytes in the same batch; in a
 * batch of its own it does not compress (RLE, or a literals-only block: 1,005 B beats Rob's RLE's 1,008). */
static void uplink(void) {
    static const UWORD l2[2] = { 1000, 1000 };
    struct WlRx rx; struct WlTx tx;
    UWORD zs[2];
    wl_init(&rx, &tx, mem_for(UP_ATTN), UP_ATTN);
    lc_frame(g_frames[0], 1000, LC_RANDOM, 77);
    memcpy(g_frames[1], g_frames[0], 1000);
    up_batch(&tx, l2, 2, zs);
    CHECK(zs[0] == 0 || zs[0] >= 1000, "random bytes alone: no smaller");
    CHECK(zs[1] != 0 && zs[1] < 40, "their copy, linked to them: a block of a few bytes");
    up_batch(&tx, l2, 1, zs);
    CHECK(zs[0] == 0 || zs[0] >= 1000, "the copy in a batch of its own: nothing to link to, no smaller");
    CHECK(guards_ok(), "uplink: nothing written outside the allocation");
}

/* Review I2, up: two batches of the same text on one WlTx, its table kept. Batch 2's blocks must not reach into batch
 * 1, which the board's window (reset per batch) does not hold. */
static void up2(void) {
    static const UWORD l3[3] = { 1200, 1200, 1200 };
    struct WlRx rx; struct WlTx tx;
    UWORD zs[3];
    unsigned b, i;
    wl_init(&rx, &tx, mem_for(UP_ATTN), UP_ATTN);
    for (i = 0; i < 3; i++) lc_frame(g_frames[i], 1200, LC_TEXT, 200u + i);
    for (b = 0; b < 2; b++)
        CHECK(up_batch(&tx, l3, 3, zs) == 3, "two batches up: every frame LZ4, every frame back on the board");
    CHECK(guards_ok(), "two batches up: nothing written outside the allocation");
}

/* Review I4: Rob's buffer takes 20 frames, RLE making them small, so a batch can offer more than the window. 12 x
 * 1,518 B = 18,216 B: frames 0-9 (15,180 B) go LZ4, 10 and 11 do not fit and go RLE, nothing lands past the window. */
static void upfull(void) {
    static const UWORD l12[12] = { 1518, 1518, 1518, 1518, 1518, 1518, 1518, 1518, 1518, 1518, 1518, 1518 };
    struct WlRx rx; struct WlTx tx;
    UWORD zs[12];
    unsigned i, nz;
    wl_init(&rx, &tx, mem_for(UP_ATTN), UP_ATTN);
    for (i = 0; i < 12; i++) lc_frame(g_frames[i], 1518, (i & 1) ? LC_HTML : LC_TEXT, 300u + i);
    nz = up_batch(&tx, l12, 12, zs);
    for (i = 0; i < 10; i++) CHECK(zs[i] != 0, "a frame inside the window: LZ4");
    CHECK(zs[10] == 0 && zs[11] == 0 && nz == 10, "the frames past the window: RLE");
    CHECK(tx.pos == WL_BROKEN, "the window broke at frame 10");
    CHECK(guards_ok(), "a batch past the window: nothing written outside the allocation");
}

int main(void) {
    const UWORD attn = SysBase->AttnFlags;
    const ULONG entries = wl_table_entries(attn);
    static const int mixed[6] = { LC_TEXT, LC_RANDOM, LC_HTML, LC_ZEROS, LC_TEXT, LC_RANDOM };
    static const UWORD mixed_len[6] = { 1200, 1400, 1300, 900, 1518, 600 };
    static const int upk[7] = { LC_TEXT, LC_RANDOM, LC_HTML, LC_TEXT_ZERO_TAIL, LC_ZEROS, LC_TEXT, LC_HTML };
    static const UWORD up_len[7] = { 1200, 900, 1400, 1100, 1518, 700, 1300 };
    unsigned nz;
    printf("drvtest: cpu attn %04x, upload table %lu\n", (unsigned)attn, (unsigned long)entries);
    gate();
    equal();
    zerorun();
    padtail();
    hostile();
    down2();
    uplink();
    up2();
    upfull();
    down(1, mixed, mixed_len, 6, &nz);
    printf("drvtest: down %u of 6 frames LZ4\n", nz);
    CHECK(nz == 4, "text, HTML and zeros go LZ4; random bytes MFM (Review Focus: a mixed batch)");
    down(0, mixed, mixed_len, 6, &nz);
    CHECK(nz == 0, "a board that sends no LZ4: all MFM, read as before");
    nz = up(attn, upk, up_len, 7);
    printf("drvtest: up %u of 7 frames LZ4\n", nz);
    CHECK(entries ? nz >= 4 : nz == 0, "LZ4 uploads on a 68020 or better only");
    printf("drvtest: %d checks, %d failed\nRESULT: %s\n", checks, failed, failed ? "FAIL" : "PASS");
    return failed ? 20 : 0;
}
