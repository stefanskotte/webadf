/*
 * PaulaNET LZ4, board -> Amiga (spec 2026-10-18 §2, §5): which frames make a batch and how each goes. Without LZ4 the
 * batch is 1.15.0's to the byte, so Rob's stock driver sees nothing new -- but for one case: a swap to his driver
 * mid-session can lose the ONE LZ4 batch already out (ruling F5; the_driver_stops_asking_mid_session).
 */
#include "harness.h"
#include "lz4_corpus.h"
#include "../src/pnet_pack.h"
#include "../src/pnet_link.h"
#include "../src/pnet_mfm.h"
#include "../src/psram_image.h"
#include <stdint.h>
#include <string.h>

#define CAP (25344u - 80u)       /* a WF_DF1_HD buffer less the extra lead-in, as test_pnet_link.c */
/* Fix round 1 (review I1): the release buffer. Release builds have WF_DF1_HD off, so DF1's buffer is TRACK_MAX_BYTES
 * (main.c DF1_WORD_BUF_BYTES) and, with the 120-byte lead-in (PNET_TX_LEAD_BYTES == PNET_LEAD_BYTES), PNET_BATCH_CAP is
 * all of it. There the buffer binds before the 16,128-byte payload limit -- at CAP it never does. */
#define CAP_DD ((size_t)TRACK_MAX_BYTES)
static uint8_t g_win[PNET_LZ4_WINDOW], g_blk[PNET_LZ4_WINDOW], g_track[25344], g_old[25344];
static uint8_t g_dec[PNET_LZ4_WINDOW], g_scr[PNET_LZ4_BLOCK_MAX];
static uint16_t g_tab[PNET_LZ4_TABLE_ENTRIES];
static uint8_t g_f[25][PNET_ETH_MTU];
static const pnet_pack_mem_t MEM = { g_win, g_blk, g_tab, PNET_LZ4_TABLE_ENTRIES };
static pnet_pack_t g_pk;
/* SAME_SIZE (20 bytes whose LZ4 block is 20 bytes) comes from lz4_corpus.h. */

static void frames(pnet_frame_ref_t *in, unsigned n, const int *kinds, const uint16_t *lens) {
    for (unsigned i = 0; i < n; i++) {
        lc_frame(g_f[i], lens[i], kinds[i], i + 1u);
        in[i].data = g_f[i];
        in[i].len = lens[i];
    }
}

/* The track read as the variant reads it, frame by frame into a window: how many frames came back whole (*lz4: how
 * many of them were LZ4). */
static unsigned read_back(const uint8_t *track, size_t bytes, const pnet_frame_ref_t *in, unsigned *lz4) {
    static uint8_t out[PNET_ETH_MTU];
    *lz4 = 0;
    const long sync = pnet_find_sync(track, bytes, bytes);
    pnet_hdr_t h;
    if (sync <= 0 || sync % 8 != 0) return 0;
    const size_t at = (size_t)sync / 8u;
    if (pnet_parse_hdr_to_amiga(track + at, bytes - at, &h, true) != PNET_OK) return 0;
    pnet_frame_iter_t it;
    if (pnet_frame_iter_init(&it, track + at + PNET_HDR_MFM_BYTES, h.data_size, PNET_TO_AMIGA) != PNET_OK) return 0;
    pnet_lz4_win_t w = { g_dec, 0, g_scr };
    unsigned k = 0;
    while (it.i < it.count) {
        uint16_t len = 0;
        bool z = false;
        if (pnet_lz4_iter_next(&it, &w, out, sizeof out, &len, &z) != PNET_OK) break;
        if (len != in[k].len || memcmp(out, in[k].data, len) != 0) break;
        if (z) (*lz4)++;
        k++;
    }
    return k;
}

/* Rob's stock driver against 1.16.0 sees 1.15.0's bytes (spec §1): same count as pnet_link_fit, same track -- in the
 * release buffer (CAP_DD, where the buffer binds) and the HD one (CAP, where the payload limit binds). */
static void without_lz4_a_batch_is_1_15_0s_byte_for_byte(void) {
    uint32_t s = 4242;
    unsigned bad = 0;
    for (unsigned t = 0; t < 400; t++) {
        const size_t cap = t & 1u ? CAP : CAP_DD;
        pnet_frame_ref_t in[25];
        uint16_t lens[25];
        int kinds[25];
        const unsigned avail = 1u + lc_next(&s) % 25u;
        for (unsigned i = 0; i < avail; i++) {
            lens[i] = (uint16_t)(1u + lc_next(&s) % PNET_ETH_MTU);
            kinds[i] = (int)(lc_next(&s) % 5u);
        }
        frames(in, avail, kinds, lens);
        const unsigned n0 = pnet_link_fit(lens, avail, cap);
        const unsigned n = pnet_pack(&g_pk, &MEM, false, in, avail, cap);
        const size_t a = pnet_build_to_amiga_out(g_track, sizeof g_track, 3, 4, 1, g_pk.f, n);
        const size_t b = pnet_build_to_amiga(g_old, sizeof g_old, 3, 4, 1, in, n0);
        if (n != n0 || g_pk.lz4 != 0 || a == 0 || a != b || memcmp(g_track, g_old, a) != 0) bad++;
        if (g_pk.wire != pnet_out_payload_bytes(g_pk.f, n)) bad++;
    }
    CHECK_EQ_INT(bad, 0);
}

static void lz4_frames_go_0xc000_and_carry_more_frames(void) {
    pnet_frame_ref_t in[12];
    int kinds[12];
    uint16_t lens[12];
    for (unsigned i = 0; i < 12; i++) { kinds[i] = LC_TEXT; lens[i] = 1200; }
    frames(in, 12, kinds, lens);
    CHECK_EQ_INT(pnet_link_fit(lens, 12, CAP), 6);        /* MFM: 6 frames of 1,200 B */
    const unsigned n = pnet_pack(&g_pk, &MEM, true, in, 12, CAP);
    CHECK(n > 6 && n <= 12, "packing by the real size carries more frames");
    CHECK_EQ_INT(g_pk.lz4, n);
    CHECK(g_pk.saved > 0, "bytes saved");
    const size_t bytes = pnet_build_to_amiga_out(g_track, sizeof g_track, 0, 0, 0, g_pk.f, n);
    CHECK(bytes != 0, "built");
    unsigned z = 0;
    CHECK_EQ_INT(read_back(g_track, bytes, in, &z), n);
    CHECK_EQ_INT(z, n);
    uint8_t ch[4];                                        /* the first frame's size word */
    const long sync = pnet_find_sync(g_track, bytes, bytes);
    pnet_mfm_decode(g_track + sync / 8 + PNET_HDR_MFM_BYTES + 4, 4, ch);
    CHECK_EQ_INT(ch[0] & 0xC0, 0xC0);
    CHECK_EQ_INT(((ch[0] & 0x3F) << 8 | ch[1]), g_pk.f[0].lz4_len);
}

/* Review Focus, mixed batches: random frames go MFM and still sit in the window the later LZ4 frames link to. */
static void a_batch_mixes_lz4_and_mfm(void) {
    static const int kinds[7] = { LC_TEXT, LC_RANDOM, LC_TEXT, LC_ZEROS, LC_HTML, LC_RANDOM, LC_TEXT };
    static const uint16_t lens[7] = { 800, 800, 800, 800, 800, 800, 800 };
    pnet_frame_ref_t in[7];
    frames(in, 7, kinds, lens);
    CHECK_EQ_INT(pnet_pack(&g_pk, &MEM, true, in, 7, CAP), 7);
    CHECK_EQ_INT(g_pk.lz4, 5);
    CHECK(g_pk.f[1].lz4 == NULL && g_pk.f[5].lz4 == NULL, "random bytes go MFM");
    const size_t bytes = pnet_build_to_amiga_out(g_track, sizeof g_track, 0, 0, 0, g_pk.f, 7);
    unsigned z = 0;
    CHECK_EQ_INT(read_back(g_track, bytes, in, &z), 7);
    CHECK_EQ_INT(z, 5);
}

/* Spec §2: never larger than today. Review Focus, sizes at the edges: a block as long as its frame goes MFM. Ruling
 * F11: each kind's encoding is pinned too -- random bytes MFM, text, HTML and zeros LZ4 -- so a packer that sent
 * everything MFM (which never grows a frame either) fails here. */
static void the_choice_never_grows_a_frame(void) {
    static const int kinds[6] = { LC_TEXT, LC_RANDOM, LC_HTML, LC_ZEROS, LC_TEXT_ZERO_TAIL, LC_RANDOM };
    static const uint16_t lens[6] = { 1518, 1518, 20, 13, 1200, 64 };
    static const bool want_lz4[6] = { true, false, true, true, true, false };
    pnet_frame_ref_t in[6];
    frames(in, 6, kinds, lens);
    CHECK_EQ_INT(pnet_pack(&g_pk, &MEM, true, in, 6, CAP), 6);
    unsigned bad = 0, wrong = 0;
    for (unsigned i = 0; i < g_pk.n; i++) {
        if (g_pk.f[i].lz4 && g_pk.f[i].lz4_len >= g_pk.f[i].len) bad++;
        if ((g_pk.f[i].lz4 != NULL) != want_lz4[i]) {
            wrong++;
            printf("  frame %u (kind %d): %s\n", i, kinds[i], g_pk.f[i].lz4 ? "LZ4" : "MFM");
        }
    }
    CHECK_EQ_INT(bad, 0);
    CHECK_EQ_INT(wrong, 0);
    CHECK_EQ_INT(g_pk.lz4, 4);
    pnet_frame_ref_t same = { SAME_SIZE, 20 };
    CHECK_EQ_INT(pnet_pack(&g_pk, &MEM, true, &same, 1, CAP), 1);
    CHECK(g_pk.f[0].lz4 == NULL && g_pk.lz4 == 0, "a 20-byte block for a 20-byte frame: MFM");
}

/* Review Focus, sizes at the edges (ruling F12: named for what it packs). 25 incompressible MTU frames on offer, but
 * the MFM payload limit binds first -- 5 x (8 + 3,036) + 4 = 15,224, a sixth would pass 16,128 -- so the batch is 5
 * frames, every one MFM, and the track is 1.15.0's byte for byte. */
static void five_incompressible_mtu_frames_are_1_15_0s(void) {
    pnet_frame_ref_t in[25];
    int kinds[25];
    uint16_t lens[25];
    for (unsigned i = 0; i < 25; i++) { kinds[i] = LC_RANDOM; lens[i] = PNET_ETH_MTU; }
    frames(in, 25, kinds, lens);
    CHECK_EQ_INT(pnet_pack(&g_pk, &MEM, true, in, 25, CAP), 5);
    CHECK_EQ_INT(g_pk.lz4, 0);
    const size_t a = pnet_build_to_amiga_out(g_track, sizeof g_track, 7, 8, 1, g_pk.f, 5);
    const size_t b = pnet_build_to_amiga(g_old, sizeof g_old, 7, 8, 1, in, 5);
    CHECK(a != 0 && a == b && memcmp(g_track, g_old, a) == 0, "the same track");
    CHECK(g_pk.wire <= PNET_TO_AMIGA_MAX_PAYLOAD, "inside the driver's read");
    /* The release buffer binds first: 4 frames (4 x 3,044 + 4 + 271 = 12,451; a fifth is 15,495 > 14,336). */
    CHECK_EQ_INT(pnet_link_fit(lens, 25, CAP_DD), 4);
    CHECK_EQ_INT(pnet_pack(&g_pk, &MEM, true, in, 25, CAP_DD), 4);
    CHECK_EQ_INT(g_pk.lz4, 0);
    const size_t c = pnet_build_to_amiga_out(g_track, CAP_DD, 7, 8, 1, g_pk.f, 4);
    const size_t d = pnet_build_to_amiga(g_old, CAP_DD, 7, 8, 1, in, 4);
    CHECK(c != 0 && c == d && c <= CAP_DD && memcmp(g_track, g_old, c) == 0, "the same track, release buffer");
}

/* Fix round 1 (review I1): in the release buffer a batch never exceeds it on the wire, LZ4 or not, and it is as full
 * as packing by real size allows: the next frame on offer would not have fit. Mixed kinds and lengths. */
static void a_batch_never_exceeds_the_release_buffer(void) {
    uint32_t s = 9001;
    unsigned over = 0, short_ = 0, packed = 0;
    for (unsigned t = 0; t < 400; t++) {
        pnet_frame_ref_t in[25];
        uint16_t lens[25];
        int kinds[25];
        const unsigned avail = 1u + lc_next(&s) % 25u;
        for (unsigned i = 0; i < avail; i++) {
            lens[i] = (uint16_t)(1u + lc_next(&s) % PNET_ETH_MTU);
            kinds[i] = (int)(lc_next(&s) % 5u);
        }
        frames(in, avail, kinds, lens);
        const bool lz4 = (t & 1u) != 0;
        const unsigned n = pnet_pack(&g_pk, &MEM, lz4, in, avail, CAP_DD);
        packed += n;
        /* Built into a buffer of exactly CAP_DD bytes: the builder refuses (0) anything that might not fit it. */
        const size_t bytes = pnet_build_to_amiga_out(g_track, CAP_DD, 1, 2, 0, g_pk.f, n);
        if (bytes == 0 || bytes > CAP_DD) over++;
        /* Full: with one more frame (as it would go, MFM or LZ4) the track would pass the buffer or a limit. */
        if (n < avail && n < PNET_MAX_FRAMES) {
            pnet_pack_t more;
            const unsigned m = pnet_pack(&more, &MEM, lz4, in, n + 1u, CAP);   /* the same frames, HD room */
            unsigned dec = 0;
            for (unsigned i = 0; i < m; i++) dec += more.f[i].len;
            const size_t need = PNET_LEAD_BYTES + 4u + PNET_HDR_MFM_BYTES + more.wire + PNET_TRAIL_BYTES + 3u;
            if (m == n + 1u && need <= CAP_DD && more.wire <= PNET_TO_AMIGA_MAX_PAYLOAD && dec <= PNET_LZ4_WINDOW)
                short_++;
        }
    }
    CHECK_EQ_INT(over, 0);
    CHECK_EQ_INT(short_, 0);
    CHECK(packed > 400, "batches were packed");
}

/* Fix round 1 (review I2): at most PNET_MAX_FRAMES (20) frames, with LZ4 and without, however many fit: 25 small
 * frames on offer give 20, and nothing past pk->f[] -- its counts, and what follows the struct -- is written past. */
static void a_batch_holds_at_most_twenty_frames(void) {
    static struct { pnet_pack_t pk; uint8_t guard[256]; } g;
    pnet_frame_ref_t in[25];
    int kinds[25];
    uint16_t lens[25];
    for (unsigned i = 0; i < 25; i++) { kinds[i] = (int)(i % 2u ? LC_TEXT : LC_RANDOM); lens[i] = 60; }
    frames(in, 25, kinds, lens);
    for (unsigned k = 0; k < 2; k++) {
        memset(&g, 0xA5, sizeof g);
        CHECK_EQ_INT(pnet_pack(&g.pk, &MEM, k != 0, in, 25, CAP_DD), PNET_MAX_FRAMES);
        CHECK_EQ_INT(g.pk.n, PNET_MAX_FRAMES);
        CHECK_EQ_INT(g.pk.wire, pnet_out_payload_bytes(g.pk.f, PNET_MAX_FRAMES));
        unsigned touched = 0;
        for (unsigned i = 0; i < sizeof g.guard; i++) touched += g.guard[i] != 0xA5u;
        CHECK_EQ_INT(touched, 0);
        unsigned whole = 0;
        for (unsigned i = 0; i < PNET_MAX_FRAMES; i++) whole += g.pk.f[i].data != NULL && g.pk.f[i].len == 60;
        CHECK_EQ_INT(whole, PNET_MAX_FRAMES);
        const size_t bytes = pnet_build_to_amiga_out(g_track, CAP_DD, 0, 0, 0, g.pk.f, g.pk.n);
        unsigned z = 0;
        CHECK_EQ_INT(read_back(g_track, bytes, in, &z), PNET_MAX_FRAMES);
    }
}

/* Review Focus, sizes at the edges: exactly 16,128 decoded bytes link; one more byte stops the batch. */
static void packing_stops_at_16128_decoded_bytes(void) {
    pnet_frame_ref_t in[12];
    int kinds[12];
    uint16_t lens[12];
    for (unsigned i = 0; i < 12; i++) { kinds[i] = LC_ZEROS; lens[i] = PNET_ETH_MTU; }
    lens[10] = 948;                                       /* 10 x 1,518 + 948 = 16,128 */
    lens[11] = 1;
    frames(in, 12, kinds, lens);
    CHECK_EQ_INT(pnet_pack(&g_pk, &MEM, true, in, 12, CAP), 11);
    unsigned sum = 0;
    for (unsigned i = 0; i < g_pk.n; i++) sum += g_pk.f[i].len;
    CHECK_EQ_INT(sum, PNET_LZ4_WINDOW);
    CHECK_EQ_INT(g_pk.lz4, 11);
    const size_t bytes = pnet_build_to_amiga_out(g_track, sizeof g_track, 0, 0, 0, g_pk.f, 11);
    unsigned z = 0;
    CHECK_EQ_INT(read_back(g_track, bytes, in, &z), 11);
    CHECK_EQ_INT(pnet_pack(&g_pk, &MEM, false, in, 12, CAP), 5);   /* MFM: the payload limit, as before */
}

/* The batch out is rebuilt unchanged until acknowledged (pnet_link.h): the same frames give the same bytes. */
static void rebuilds_are_byte_identical(void) {
    pnet_frame_ref_t in[12];
    int kinds[12];
    uint16_t lens[12];
    for (unsigned i = 0; i < 12; i++) { kinds[i] = i % 3u ? LC_TEXT : LC_HTML; lens[i] = (uint16_t)(700u + 61u * i); }
    frames(in, 12, kinds, lens);
    const unsigned n = pnet_pack(&g_pk, &MEM, true, in, 12, CAP);
    const size_t a = pnet_build_to_amiga_out(g_old, sizeof g_old, 1, 2, 0, g_pk.f, n);
    /* The table now holds the first pack's positions. For the same frames that cannot change the bytes (the encoder
     * checks every candidate's bytes and would have found these itself); the_table_is_cleared_only_for_frames shows
     * the clear that matters, after a different batch. */
    CHECK_EQ_INT(pnet_pack(&g_pk, &MEM, true, in, 12, CAP), n);
    const size_t b = pnet_build_to_amiga_out(g_track, sizeof g_track, 1, 2, 0, g_pk.f, n);
    CHECK(a != 0 && a == b && memcmp(g_old, g_track, a) == 0, "byte-identical");
}

/* Ruling F18: the table is cleared when an LZ4 pack has frames to encode -- a batch packed after another batch is the
 * bytes it is alone -- and not on a call with nothing waiting (pnet_prepare_echo with an empty ring), which would
 * clear 8 KB of PSRAM for nothing. */
static void the_table_is_cleared_only_for_frames(void) {
    pnet_frame_ref_t in[6];
    int kinds[6];
    uint16_t lens[6];
    for (unsigned i = 0; i < 6; i++) { kinds[i] = LC_TEXT; lens[i] = 1000; }
    frames(in, 6, kinds, lens);
    memset(g_tab, 0, sizeof g_tab);
    const unsigned n = pnet_pack(&g_pk, &MEM, true, in, 6, CAP);
    const size_t a = pnet_build_to_amiga_out(g_old, sizeof g_old, 1, 2, 0, g_pk.f, n);
    /* Another batch leaves real positions in the table: the same frames but the first, which is random bytes. Its
     * positions inside the frames both batches share hold the same bytes, so a table left uncleared would hand the
     * encoder matches it would not have found on its own (probed: the same frames, rotated, or wholly different
     * frames, do not show a missing clear -- the encoder checks every candidate's bytes). */
    static uint8_t first[1000];
    lc_frame(first, 1000, LC_RANDOM, 42);
    pnet_frame_ref_t other[6];
    for (unsigned i = 0; i < 6; i++) other[i] = in[i];
    other[0].data = first;
    pnet_pack(&g_pk, &MEM, true, other, 6, CAP);
    CHECK_EQ_INT(pnet_pack(&g_pk, &MEM, true, in, 6, CAP), n);
    const size_t b = pnet_build_to_amiga_out(g_track, sizeof g_track, 1, 2, 0, g_pk.f, n);
    CHECK(a != 0 && a == b && memcmp(g_old, g_track, a) == 0, "after another batch: the same bytes");
    memset(g_tab, 0x5A, sizeof g_tab);
    CHECK_EQ_INT(pnet_pack(&g_pk, &MEM, true, in, 0, CAP), 0);
    CHECK_EQ_INT(g_pk.wire, 0);
    unsigned kept = 0;
    for (unsigned i = 0; i < PNET_LZ4_TABLE_ENTRIES; i++) kept += g_tab[i] == 0x5A5Au;
    CHECK_EQ_INT(kept, PNET_LZ4_TABLE_ENTRIES);           /* nothing to encode: the table is not touched */
}

/* Review Focus, the driver swap (ruling F5): an LZ4 batch is out, then Rob's stock driver writes (no 0x10). His driver
 * reads before it writes, so it may already have read that LZ4 batch and lost it: ONE LZ4 batch can be lost at a swap
 * mid-session. Unacknowledged, the batch is re-packed MFM: it holds the frames that fit, the rest stay waiting, and
 * the acknowledgement frees exactly those. Every batch after the swap is MFM. */
static void the_driver_stops_asking_mid_session(void) {
    pnet_frame_ref_t in[12];
    int kinds[12];
    uint16_t lens[12];
    for (unsigned i = 0; i < 12; i++) { kinds[i] = LC_TEXT; lens[i] = 1200; }
    frames(in, 12, kinds, lens);
    pnet_link_t s;
    pnet_link_init(&s);
    pnet_link_start(&s, pnet_pack(&g_pk, &MEM, true, in, 12, CAP));
    const unsigned out = s.nframes;
    CHECK(out > 6, "an LZ4 batch is out");
    pnet_link_shrink(&s, pnet_pack(&g_pk, &MEM, false, in, s.nframes, CAP));
    CHECK_EQ_INT(s.nframes, 6);
    CHECK_EQ_INT(g_pk.lz4, 0);
    const size_t bytes = pnet_build_to_amiga_out(g_track, sizeof g_track, 0, s.pico, 0, g_pk.f, s.nframes);
    unsigned z = 9;
    CHECK_EQ_INT(read_back(g_track, bytes, in, &z), 6);
    CHECK_EQ_INT(z, 0);                                   /* the re-packed batch is all MFM */
    pnet_link_shrink(&s, 10);                             /* never grows */
    CHECK_EQ_INT(s.nframes, 6);
    pnet_link_shrink(&s, 0);                              /* never empties */
    CHECK_EQ_INT(s.nframes, 6);
    pnet_hdr_t h;
    memset(&h, 0, sizeof h);
    h.pico_ctr = s.pico;
    CHECK_EQ_INT(pnet_link_ack(&s, &h), 6);
}

int main(void) {
    RUN(without_lz4_a_batch_is_1_15_0s_byte_for_byte);
    RUN(lz4_frames_go_0xc000_and_carry_more_frames);
    RUN(a_batch_mixes_lz4_and_mfm);
    RUN(the_choice_never_grows_a_frame);
    RUN(five_incompressible_mtu_frames_are_1_15_0s);
    RUN(a_batch_never_exceeds_the_release_buffer);
    RUN(a_batch_holds_at_most_twenty_frames);
    RUN(packing_stops_at_16128_decoded_bytes);
    RUN(rebuilds_are_byte_identical);
    RUN(the_table_is_cleared_only_for_frames);
    RUN(the_driver_stops_asking_mid_session);
    return REPORT();
}
