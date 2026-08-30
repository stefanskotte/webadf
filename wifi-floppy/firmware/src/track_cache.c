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
    // The FULL published token (psram_active_token()) this copy was read
    // under -- NOT just the slot index. A slot index repeats across disk
    // generations (there are only SLOT_COUNT of them), so tagging with the
    // bare slot cannot tell today's occupant of slot 0 apart from
    // yesterday's: a swap that ejects and later republishes the same slot
    // index for a DIFFERENT disk, or a third disk that reuses a slot two
    // disks back used with no eject in between, would both let a stale
    // copy be served under the wrong disk's name. The token's generation
    // counter (see psram_image.c) makes every publish distinguishable from
    // every other one, including from itself across an eject and back.
    // 0 is never produced by a real publish (see psram_image.c), so it
    // safely means "never cached" here.
    int32_t  token;
    int      track;
    uint32_t bit_count;
    uint8_t  data[TRACK_MAX_BYTES] __attribute__((aligned(4)));
} sram_buf_t;

static sram_buf_t buf[2];
static int        active;              // index of the buffer feeding the PIO

void track_cache_init(void) {
    buf[0].track = buf[1].track = -1;
    buf[0].token = buf[1].token = 0;
    active = 0;
    psram_image_init();
}

void track_cache_flush(void) {
    buf[0].track = buf[1].track = -1;
    buf[0].token = buf[1].token = 0;
    for (int s = 0; s < SLOT_COUNT; s++) psram_image_reset_slot(s);
    psram_publish_slot(SLOT_NONE);
}

const uint8_t *track_cache_get(int track, uint32_t *bit_count) {
    if (track < 0 || track >= NUM_TRACKS) return 0;

    // One read of the swap word for the whole call (with the acquire
    // barrier psram_active_token() applies), so a publish landing mid-call
    // can't mix a cache-hit check against one generation with a PSRAM read
    // from another. See psram_publish_slot()'s comment in psram_image.c
    // for why any single token names a whole disk (or no disk).
    int32_t token = psram_active_token();
    int slot = psram_token_slot(token);
    if (slot == SLOT_NONE) return 0;       // nothing mounted

    // Already sitting in SRAM? Compare the whole token, not the slot --
    // see sram_buf_t's comment above for why a bare slot match is not
    // enough.
    for (int i = 0; i < 2; i++)
        if (buf[i].track == track && buf[i].token == token) {
            active = i;
            *bit_count = buf[i].bit_count;
            return buf[i].data;
        }

    sram_buf_t *dst = &buf[active ^ 1];        // fill the idle half

    // Tier 1: PSRAM.
    if (psram_image_have(slot, track) &&
        psram_image_read(slot, track, dst->data, &dst->bit_count)) {
        dst->track = track;
        dst->token = token;
        active ^= 1;
        *bit_count = dst->bit_count;
        return dst->data;
    }

    return 0;      // not in PSRAM: image incomplete, caller must not stream
}

bool track_cache_image_complete(void) {
    int slot = psram_active_slot();
    return slot != SLOT_NONE && psram_image_available() &&
           psram_image_missing_count(slot) == 0;
}

// Test-only: the true size of the SRAM buffer track_cache_get() copies each
// track into, read via sizeof rather than echoing a macro, so this reflects
// buf[]'s actual layout even if a future change stops using TRACK_MAX_BYTES
// to declare it. See track_cache.h for what invariant this backs.
size_t track_cache_buf_bytes(void) {
    return sizeof buf[0].data;
}

int track_cache_fill_percent(void) {
    int slot = psram_active_slot();
    if (slot == SLOT_NONE || !psram_image_available()) return 0;
    return (NUM_TRACKS - psram_image_missing_count(slot)) * 100 / NUM_TRACKS;
}
