#include "image_loader.h"
#include "psram_image.h"
#include <string.h>
#include <stddef.h>

// Incremental parser: bytes arrive in arbitrary chunks, so the header and
// each track length are reassembled a byte at a time, and payload bytes go
// straight into the PSRAM slot without an intermediate buffer.
typedef enum { S_HDR, S_LEN, S_PAYLOAD, S_PAD, S_ERR, S_EOF } state_t;

typedef struct {
    state_t  st;
    uint8_t  hdr[16];
    int      hdr_got;
    uint8_t  lenb[4];
    int      len_got;
    int      track, track_count;
    uint32_t bits, payload_bytes, payload_got, pad_left;
} loader_t;

static loader_t L;

static uint32_t le32(const uint8_t *p) {
    return p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24;
}

static void sink(void *ctx, const uint8_t *d, int n) {
    loader_t *l = ctx;
    while (n > 0 && l->st != S_ERR && l->st != S_EOF) {
        switch (l->st) {
        case S_HDR: {
            int want = 16 - l->hdr_got, take = n < want ? n : want;
            memcpy(l->hdr + l->hdr_got, d, take);
            l->hdr_got += take; d += take; n -= take;
            if (l->hdr_got < 16) return;
            if (le32(l->hdr) != IMAGE_MAGIC || le32(l->hdr + 4) != IMAGE_VERSION) {
                l->st = S_ERR; return;
            }
            l->track_count = (int)le32(l->hdr + 8);
            if (l->track_count <= 0 || l->track_count > NUM_TRACKS) { l->st = S_ERR; return; }
            l->track = 0; l->st = S_LEN; l->len_got = 0;
            break;
        }
        case S_LEN: {
            int want = 4 - l->len_got, take = n < want ? n : want;
            memcpy(l->lenb + l->len_got, d, take);
            l->len_got += take; d += take; n -= take;
            if (l->len_got < 4) return;
            l->bits = le32(l->lenb);
            // Bound `bits` BEFORE the arithmetic below. (bits + 7) on a
            // uint32_t wraps for bits >= 0xFFFFFFF9, yielding
            // payload_bytes == 0, which would otherwise slip past the
            // payload_bytes > TRACK_MAX_BYTES check that follows and mark
            // the track present with a nonsense bit count -- the firmware
            // would present a disk of empty tracks instead of refusing the
            // image.
            if (l->bits > (uint32_t)TRACK_MAX_BYTES * 8u) { l->st = S_ERR; return; }
            l->payload_bytes = (l->bits + 7) / 8;
            if (l->payload_bytes > TRACK_MAX_BYTES) { l->st = S_ERR; return; }
            l->payload_got = 0;
            l->pad_left = (4 - (l->payload_bytes & 3)) & 3;
            l->st = S_PAYLOAD;
            break;
        }
        case S_PAYLOAD: {
            uint32_t want = l->payload_bytes - l->payload_got;
            int take = (uint32_t)n < want ? n : (int)want;
            psram_image_write_at(l->track, l->payload_got, d, take);
            l->payload_got += take; d += take; n -= take;
            if (l->payload_got < l->payload_bytes) return;
            psram_image_commit(l->track, l->bits);
            l->st = l->pad_left ? S_PAD : S_LEN;
            l->len_got = 0;
            if (l->st == S_LEN && ++l->track >= l->track_count) l->st = S_EOF;
            break;
        }
        case S_PAD: {
            int take = (uint32_t)n < l->pad_left ? n : (int)l->pad_left;
            l->pad_left -= take; d += take; n -= take;
            if (l->pad_left) return;
            l->st = S_LEN; l->len_got = 0;
            if (++l->track >= l->track_count) l->st = S_EOF;
            break;
        }
        default: return;
        }
    }
}

bool image_parse_buffer(int slot, const uint8_t *data, size_t len) {
    (void)slot;   // no per-slot state yet -- there is only one active PSRAM
                  // image today; the parameter exists so a future multi-image
                  // cache doesn't need a signature change.
    if (!psram_image_available()) return false;   // no PSRAM, no disk
    psram_image_reset();
    memset(&L, 0, sizeof L);
    L.st = S_HDR;

    sink(&L, data, (int)len);

    bool ok = (L.st == S_EOF) && (psram_image_missing_count() == 0);
    if (!ok) psram_image_reset();                 // never present a half disk
    return ok;
}

int image_load_percent(void) {
    if (L.track_count <= 0) return 0;
    return L.track * 100 / L.track_count;
}
