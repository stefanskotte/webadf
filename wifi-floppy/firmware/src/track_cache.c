// Track store: SRAM double buffer fed from the PSRAM disk image.
// The bus read path NEVER touches the network: the whole image is loaded
// into PSRAM at mount by image_loader.c. A miss here means the image is
// incomplete, which is a fault, not a reason to stall the floppy bus.
#include "track_cache.h"
#include "psram_image.h"
#include <string.h>

// Tier 0: double buffer. One is feeding the PIO while the other is being
// filled for the next track, so a seek never tears the live stream.
typedef struct {
    int      track;
    uint32_t bit_count;
    uint8_t  data[TRACK_MFM_MAX] __attribute__((aligned(4)));
} sram_buf_t;

static sram_buf_t buf[2];
static int        active;              // index of the buffer feeding the PIO

void track_cache_init(void) {
    buf[0].track = buf[1].track = -1;
    active = 0;
    psram_image_init();
}

void track_cache_flush(void) {
    buf[0].track = buf[1].track = -1;
    psram_image_reset();
}

const uint8_t *track_cache_get(int track, uint32_t *bit_count) {
    if (track < 0 || track >= NUM_TRACKS) return 0;

    // Already sitting in SRAM?
    for (int i = 0; i < 2; i++)
        if (buf[i].track == track) {
            active = i;
            *bit_count = buf[i].bit_count;
            return buf[i].data;
        }

    sram_buf_t *dst = &buf[active ^ 1];        // fill the idle half

    // Tier 1: PSRAM.
    if (psram_image_have(track) &&
        psram_image_read(track, dst->data, &dst->bit_count)) {
        dst->track = track;
        active ^= 1;
        *bit_count = dst->bit_count;
        return dst->data;
    }

    return 0;      // not in PSRAM: image incomplete, caller must not stream
}

bool track_cache_image_complete(void) {
    return psram_image_available() && psram_image_missing_count() == 0;
}

int track_cache_fill_percent(void) {
    if (!psram_image_available()) return 0;
    return (NUM_TRACKS - psram_image_missing_count()) * 100 / NUM_TRACKS;
}
