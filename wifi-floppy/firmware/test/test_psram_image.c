#include "harness.h"
#include "../src/psram_image.h"
#include <stdlib.h>

static void test_written_track_reads_back(void) {
    size_t len = (size_t)TRACK_SLOT_BYTES * NUM_TRACKS;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);
    psram_image_reset();

    uint8_t src[64];
    for (int i = 0; i < 64; i++) src[i] = (uint8_t)i;
    psram_image_write_at(5, 0, src, 64);
    psram_image_commit(5, 512);

    CHECK(psram_image_have(5), "track 5 should be present after commit");
    CHECK_EQ_INT(psram_image_bits(5), 512);

    uint8_t dst[64] = {0};
    uint32_t bits = 0;
    CHECK(psram_image_read(5, dst, &bits), "read should succeed");
    CHECK_EQ_INT(bits, 512);
    CHECK(memcmp(src, dst, 64) == 0, "bytes should round-trip");

    CHECK(!psram_image_have(6), "an uncommitted track must not read as present");
    free(mem);
}

int main(void) { RUN(test_written_track_reads_back); return REPORT(); }
