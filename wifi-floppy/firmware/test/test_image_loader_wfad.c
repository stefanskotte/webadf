#include "harness.h"
#include "../src/image_loader.h"
#include "../src/psram_image.h"
#include <stdlib.h>
#include <string.h>

// WFAD (HD spec §4.4, §5.1): the loader takes an HD ADF whole or not at all.
// The slot it fills becomes ADF_HD; a rejected image leaves the slot empty
// AND back to MFM, so nothing half-loaded can ever be published.

#define WFAD_TOTAL (16u + WFAD_BODY_BYTES)
static uint8_t *img;    // WFAD_TOTAL + 1 bytes: room for the one-too-many case

static void put_u32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}

// A valid WFAD whose every byte says where it is.
static void build(void) {
    put_u32(img, WFAD_MAGIC); put_u32(img + 4, WFAD_VERSION);
    put_u32(img + 8, WFAD_TRACKS); put_u32(img + 12, WFAD_SECTORS);
    for (uint32_t t = 0; t < WFAD_TRACKS; t++)
        for (uint32_t i = 0; i < WFAD_TRACK_BYTES; i++)
            img[16 + t * WFAD_TRACK_BYTES + i] = (uint8_t)(t ^ (i * 7u));
}

static void the_spec_header_is_what_the_loader_reads(void) {
    // Spelled out from the spec's table, as src/lib/adfmfm/wfad.test.ts does
    // on the server side: both ends are held to the same 16 bytes.
    static const uint8_t hdr[16] = { 0x57, 0x46, 0x41, 0x44, 1, 0, 0, 0,
                                     0xa0, 0, 0, 0, 0x16, 0, 0, 0 };
    build();
    CHECK(memcmp(img, hdr, sizeof hdr) == 0, "WFAD header bytes match the spec table");
    CHECK_EQ_INT(WFAD_TOTAL, 1802256);
    CHECK_EQ_INT(WFAD_TRACKS, NUM_TRACKS);
}

static void a_valid_wfad_loads_every_track_as_adf_hd(void) {
    build();
    CHECK(image_parse_buffer(0, img, WFAD_TOTAL), "a valid WFAD must load");
    CHECK_EQ_INT(psram_image_slot_kind(0), SLOT_KIND_ADF_HD);
    CHECK_EQ_INT(psram_image_missing_count(0), 0);
    for (int t = 0; t < NUM_TRACKS; t += 53) {
        const uint8_t *p = psram_image_track_data(0, t);
        CHECK(p != NULL, "track present");
        CHECK(p && memcmp(p, img + 16 + (uint32_t)t * WFAD_TRACK_BYTES, WFAD_TRACK_BYTES) == 0,
              "the track's ADF bytes, in place");
        CHECK_EQ_INT(psram_image_bits(0, t), WFAD_TRACK_BYTES * 8u);
    }
    // These bytes are ADF, not MFM: the copy-out path must never hand them
    // to something that would stream them.
    static uint8_t dst[TRACK_MAX_BYTES];
    uint32_t bits = 0;
    CHECK(!psram_image_read(0, 0, dst, &bits), "an ADF_HD slot is never read out as MFM");
}

static void one_byte_at_a_time_is_the_same_and_a_trailing_byte_is_not(void) {
    build();
    image_parse_begin(1);
    for (uint32_t i = 0; i < WFAD_TOTAL; i++) image_parse_feed(img + i, 1);
    CHECK(image_parse_end(), "fed one byte at a time");
    CHECK_EQ_INT(psram_image_slot_kind(1), SLOT_KIND_ADF_HD);

    image_parse_begin(1);
    for (uint32_t i = 0; i < WFAD_TOTAL; i++) image_parse_feed(img + i, 1);
    image_parse_feed(img, 1);          // one byte after the last track
    CHECK(!image_parse_end(), "a byte after the last track rejects the image");
    CHECK_EQ_INT(psram_image_missing_count(1), NUM_TRACKS);
}

static void rejected_whole(const char *why, size_t len) {
    CHECK(!image_parse_buffer(0, img, len), why);
    CHECK_EQ_INT(psram_image_missing_count(0), NUM_TRACKS);   // nothing left behind
    CHECK_EQ_INT(psram_image_slot_kind(0), SLOT_KIND_MFM);    // and the kind reset with it
}

static void malformed_containers_are_rejected_whole(void) {
    build(); put_u32(img + 4, 2);   rejected_whole("version 2", WFAD_TOTAL);
    build(); put_u32(img + 8, 159); rejected_whole("159 tracks", WFAD_TOTAL);
    build(); put_u32(img + 12, 11); rejected_whole("11 sectors (DD geometry)", WFAD_TOTAL);
    build();                        rejected_whole("one byte short", WFAD_TOTAL - 1);
    build();                        rejected_whole("the header alone", 16);
    build(); img[WFAD_TOTAL] = 0;   rejected_whole("one byte too many", WFAD_TOTAL + 1);
}

static void a_wfmf_after_a_wfad_in_the_same_slot_is_mfm_again(void) {
    build();
    CHECK(image_parse_buffer(0, img, WFAD_TOTAL), "WFAD first");
    // The smallest valid WFMF: 160 tracks of 16 bytes (128 bits), no padding.
    size_t at = 16;
    put_u32(img, IMAGE_MAGIC); put_u32(img + 4, IMAGE_VERSION);
    put_u32(img + 8, NUM_TRACKS); put_u32(img + 12, 0);
    for (int t = 0; t < NUM_TRACKS; t++) {
        put_u32(img + at, 128u); at += 4;
        memset(img + at, t, 16); at += 16;
    }
    CHECK(image_parse_buffer(0, img, at), "then a WFMF into the same slot");
    CHECK_EQ_INT(psram_image_slot_kind(0), SLOT_KIND_MFM);
    static uint8_t dst[TRACK_MAX_BYTES];
    uint32_t bits = 0;
    CHECK(psram_image_read(0, 3, dst, &bits) && bits == 128u && dst[0] == 3, "an MFM slot reads out as before");
    // Phase 3: SLOT_NET holds sectors only -- the same valid WFMF is refused there, and leaves it empty.
    CHECK(!image_parse_buffer(SLOT_NET, img, at), "a WFMF never goes into SLOT_NET");
    CHECK_EQ_INT(psram_image_missing_count(SLOT_NET), NUM_TRACKS);
}

// Phase 3: the PaulaNET driver disk arrives as a DD WFAD (11 sectors), into SLOT_NET only.
static void a_dd_wfad_loads_into_the_net_slot_only(void) {
    const uint32_t tb = WFAD_SECTORS_DD * 512u, total = 16u + WFAD_TRACKS * tb;
    uint8_t *dd = malloc(total);
    put_u32(dd, WFAD_MAGIC); put_u32(dd + 4, WFAD_VERSION); put_u32(dd + 8, WFAD_TRACKS); put_u32(dd + 12, WFAD_SECTORS_DD);
    for (uint32_t t = 0; t < WFAD_TRACKS; t++)
        for (uint32_t i = 0; i < tb; i++) dd[16 + t * tb + i] = (uint8_t)(t + i);
    CHECK(image_parse_buffer(SLOT_NET, dd, total), "a DD WFAD loads into SLOT_NET");
    CHECK_EQ_INT(psram_image_slot_kind(SLOT_NET), SLOT_KIND_ADF_DD);
    CHECK(memcmp(psram_image_track_data(SLOT_NET, 77 * 2 + 1), dd + 16 + 155u * tb, tb) == 0, "track 155 in place");
    CHECK(!image_parse_buffer(0, dd, total), "a DD WFAD never goes into DF0's slots");
    build();
    CHECK(!image_parse_buffer(SLOT_NET, img, WFAD_TOTAL), "an HD WFAD never goes into SLOT_NET");
    CHECK_EQ_INT(psram_image_slot_kind(SLOT_NET), SLOT_KIND_MFM);   // rejected: empty and MFM again
    CHECK_EQ_INT(psram_image_missing_count(SLOT_NET), NUM_TRACKS);
    free(dd);
}

int main(void) {
    size_t len = (size_t)SLOT_COUNT * NUM_TRACKS * TRACK_MAX_BYTES;
    psram_image_set_backing(malloc(len), len);
    psram_image_init();
    img = malloc(WFAD_TOTAL + 1);
    RUN(the_spec_header_is_what_the_loader_reads);
    RUN(a_valid_wfad_loads_every_track_as_adf_hd);
    RUN(one_byte_at_a_time_is_the_same_and_a_trailing_byte_is_not);
    RUN(malformed_containers_are_rejected_whole);
    RUN(a_wfmf_after_a_wfad_in_the_same_slot_is_mfm_again);
    RUN(a_dd_wfad_loads_into_the_net_slot_only);
    free(img);
    return REPORT();
}
