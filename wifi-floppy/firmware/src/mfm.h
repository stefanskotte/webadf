#ifndef MFM_H
#define MFM_H
// Amiga MFM, the WRITE direction: turning what the Amiga wrote back into ADF
// bytes. The read direction never needs any of this -- the server ships
// pre-encoded MFM and the DMA streams it verbatim.
//
// Pure C, no pico-sdk: the same rule device_client.h states, and for the same
// reason. All of this is host-tested against src/lib/adfmfm, the TypeScript
// encoder that was itself verified against Greaseweazle's amigados codec --
// so this decoder is checked against an independent implementation rather
// than against fixtures written by the same hand.
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#define MFM_SECTORS            11
#define MFM_SECTOR_DATA_BYTES  512
#define MFM_TRACK_DATA_BYTES   (MFM_SECTORS * MFM_SECTOR_DATA_BYTES)   /* 5632 */
/* sync(4) + header(8) + label(32) + hdrsum(8) + datasum(8) + data(1024) + 4 */
#define MFM_SECTOR_MFM_BYTES   1088

/** Flux interval (ns) -> number of MFM bitcells at a 2 us nominal cell.
 *  An Amiga MFM stream only ever produces 4, 6 or 8 us gaps. */
int mfm_interval_to_bits(uint32_t ns);

typedef struct {
    /** Bitmap of sectors recovered, bit n = sector n. All 11 means a complete
     *  track; anything less names exactly which are missing, which is the
     *  difference between "retry" and "this disk is damaged". */
    uint16_t found;
    /** Sectors whose header or data checksum failed. Counted rather than
     *  fatal: a capture spanning more than one revolution sees every sector
     *  more than once, and one bad copy alongside a good one is a recoverable
     *  read, not a failed track. */
    uint16_t bad_checksums;
    /** The track number the sector headers claim. Meaningful only when
     *  `found` is non-zero. The caller compares it with the track it THINKS
     *  the head is on -- a mismatch means the write landed on the wrong
     *  cylinder, which must never be written back to the image. */
    uint8_t  track_no;
    bool     track_no_consistent;
} mfm_decode_result_t;

/**
 * Scan `len` bytes of captured MFM and recover whatever sectors are in it.
 *
 * `mfm` is a LINEAR capture that may start anywhere in the revolution and
 * should cover a little over one full revolution, so that every sector
 * appears at least once without wrapping. Duplicates are expected and are not
 * an error -- unlike the fixed-buffer decoder on the web side, which is fed
 * exactly one aligned track and treats a repeat as corruption.
 *
 * Writes recovered sectors into `adf_out` (MFM_TRACK_DATA_BYTES). Sectors that
 * were not recovered are left untouched, so the caller can seed the buffer
 * with what it already holds and have a partial read update only what it
 * actually saw.
 */
void mfm_decode_track(const uint8_t *mfm, size_t len, uint8_t *adf_out,
                      mfm_decode_result_t *out);

/** Amiga checksum: XOR of the big-endian u32 words, folded to the 0x55555555
 *  lanes. `len` must be a multiple of 4. */
uint32_t mfm_checksum(const uint8_t *src, size_t len);

/** Inverse of the odd/even bit split. `dst` holds `n` bytes, `src` holds 2n. */
void mfm_join_odd_even(const uint8_t *src, size_t n, uint8_t *dst);

#endif
