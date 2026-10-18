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
 * not trap an odd word access, so the alignment is guaranteed here, not left to the linker. */
static ULONG g_mem_l[(MEM_BYTES + 3) / 4];
static ULONG g_track_l[26000 / 4];
#define g_mem   ((UBYTE *)g_mem_l)
#define g_track ((UBYTE *)g_track_l)
static pnet_pack_t g_pk;

static void gate(void) {
    struct WlRx rx; struct WlTx tx;
    CHECK(WL_WINDOW == PNET_LZ4_WINDOW && WL_BLOCK_MAX == PNET_LZ4_BLOCK_MAX, "the board's sizes");
    CHECK(wl_table_entries(0) == 0, "68000: no LZ4 upload");
    CHECK(wl_table_entries(AFF_68010) == 0, "68010: no LZ4 upload");
    CHECK(wl_table_entries(AFF_68010 | AFF_68020) == 1024, "68020: 1,024 entries");
    CHECK(wl_table_entries(AFF_68010 | AFF_68020 | AFF_68030) == 1024, "68030: 1,024 entries");
    CHECK(wl_table_entries(ALL40) == 4096, "68040: 4,096 entries");
    CHECK(wl_mem_bytes(0) == WL_WINDOW + WL_BLOCK_MAX, "68000: the download window only");
    CHECK(wl_mem_bytes(ALL40) <= sizeof g_mem_l, "the 68040 allocation");
    wl_init(&rx, &tx, g_mem, ALL40);
    wl_tx_begin(&tx, 0);
    CHECK(!tx.on, "a board without byte 155's bit 1 (1.15.0, Rob's): RLE, even on a 68040");
    wl_tx_begin(&tx, WL_ST_LZ4_IN);
    CHECK(tx.on, "a board that takes LZ4");
    wl_init(&rx, &tx, g_mem, 0);
    wl_tx_begin(&tx, WL_ST_LZ4_IN);
    CHECK(!tx.on, "a 68000 never uploads LZ4");
    CHECK(wl_wire_bytes(0xC000 | 700) == 1400 && wl_wire_bytes(0x8000 | 2400) == 2400 && wl_wire_bytes(0x0123) == 0x123,
          "wire bytes");
}

/* Review Focus, sizes at the edges: a block as long as the RLE goes as the RLE. */
static void equal(void) {
    struct WlRx rx; struct WlTx tx;
    UBYTE body[32];
    wl_init(&rx, &tx, g_mem, AFF_68010 | AFF_68020);
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
    wl_init(&rx, &tx, g_mem, AFF_68010 | AFF_68020);
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
    wl_init(&rx, &tx, g_mem, AFF_68010 | AFF_68020);
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

/* Board -> Amiga: the board packs and builds; the driver reads the payload as paulaNetReceivePackets does
 * (wl_wire_bytes, wl_rx_frame) and gets every frame back. */
static void down(int lz4, const int *kinds, const UWORD *lens, unsigned n, unsigned *nlz4) {
    pnet_frame_ref_t in[PNET_MAX_FRAMES];
    const pnet_pack_mem_t m = { g_win, g_blk, g_tab, PNET_LZ4_TABLE_ENTRIES };
    struct WlRx rx; struct WlTx tx;
    const UBYTE *pay;
    UBYTE ph[2];
    size_t pos = 4;
    unsigned i;
    for (i = 0; i < n; i++) {
        lc_frame(g_frames[i], lens[i], kinds[i], i + 1u);
        in[i].data = g_frames[i];
        in[i].len = lens[i];
    }
    pnet_pack(&g_pk, &m, lz4 != 0, in, n, sizeof g_track_l);
    CHECK(g_pk.n == n, "the whole set is one batch");
    CHECK(pnet_build_to_amiga_out(g_track, sizeof g_track_l, 1, 2, 0, g_pk.f, g_pk.n) != 0, "built");
    pay = g_track + PNET_LEAD_BYTES + 4 + PNET_HDR_MFM_BYTES;   /* past the lead-in, the sync and the header */
    pnet_mfm_decode(pay, 2, ph);
    CHECK(ph[0] == g_pk.n, "frame count");
    wl_init(&rx, &tx, g_mem, SysBase->AttnFlags);
    wl_rx_begin(&rx);
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
        got = wl_rx_frame(&rx, field, pay + pos + 8, orig);
        CHECK(got != 0 && orig == in[i].len && memcmp(got, in[i].data, orig) == 0, "the frame back on the Amiga");
        pos += 8u + wire + (wire & 1u);
    }
}

/* Amiga -> board: the driver's half packs as paulaNetAddPacket does (RLE first -- pnet_rle_encode is Rob's format --
 * then wl_tx_frame) and the board's pnet_lz4_iter_next reads every frame back, linked. Returns frames sent LZ4. */
static unsigned up(UWORD attn, const int *kinds, const UWORD *lens, unsigned n) {
    struct WlRx rx; struct WlTx tx;
    pnet_frame_iter_t it;
    pnet_lz4_win_t w;
    const UBYTE ph[2] = { (UBYTE)n, 0 };
    uint16_t last = 0;
    size_t pos;
    unsigned i, nz = 0;
    wl_init(&rx, &tx, g_mem, attn);
    wl_tx_begin(&tx, WL_ST_LZ4_IN);
    pos = pnet_mfm_encode(ph, 2, g_track, &last);
    for (i = 0; i < n; i++) {
        UBYTE *body = g_track + pos + 8;
        UWORD rle, z, field, wire;
        UBYTE ch[4];
        lc_frame(g_frames[i], lens[i], kinds[i], 100u + i);
        rle = (UWORD)pnet_rle_encode(g_frames[i], lens[i], body);
        z = wl_tx_frame(&tx, g_frames[i], lens[i], body, rle);
        field = z ? (UWORD)(WL_SIZE_LZ4 | z) : (UWORD)(0x8000 | rle);
        wire = z ? (UWORD)((z + 1) & ~1) : rle;
        ch[0] = (UBYTE)(field >> 8); ch[1] = (UBYTE)field; ch[2] = (UBYTE)(lens[i] >> 8); ch[3] = (UBYTE)lens[i];
        last = 0;
        pnet_mfm_encode(ch, 4, g_track + pos, &last);
        pos += 8u + wire;
        if (z) {
            nz++;
            CHECK(wl_zero_run(body, wire) <= WL_ZERO_RUN_MAX, "a raw block on the wire, pad included, within the run");
        }
        if (kinds[i] == LC_TEXT_ZERO_TAIL) CHECK(z == 0, "a block with a long zero run never goes raw");
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
