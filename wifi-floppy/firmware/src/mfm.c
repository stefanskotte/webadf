#include "mfm.h"
#include <string.h>

/*
 * A flux interval, in ns, to the number of MFM bitcells it spans.
 *
 * Amiga DD uses a 2 us bitcell and MFM guarantees one transition every 2, 3 or
 * 4 cells -- so the only intervals a healthy stream produces are 4, 6 and 8 us.
 *
 * THE THRESHOLDS MUST SIT BETWEEN THOSE VALUES, not at them. The version this
 * replaces used 3000 and 5000 while its own comments said "~4us -> 10", which
 * meant a textbook-perfect 4 us gap was classified as a 3-cell gap: the code
 * and the comment beside it disagreed, and the code was wrong. It had never
 * run -- mfm_decode_track was a stub returning -1 -- so nothing caught it.
 *
 *   < 5000  a 4 us gap (2 cells), tolerant to +25% / -25%
 *   < 7000  a 6 us gap (3 cells)
 *   else    an 8 us gap (4 cells)
 *
 * Midpoints give every bucket a full 1 us of margin either side, which is far
 * more than the few percent a drive's speed actually varies by.
 */
int mfm_interval_to_bits(uint32_t ns) {
    if (ns < 5000) return 2;        //  ~4us  -> 10
    if (ns < 7000) return 3;        //  ~6us  -> 100
    return 4;                       //  ~8us  -> 1000
}

uint32_t mfm_checksum(const uint8_t *src, size_t len) {
    uint32_t c = 0;
    for (size_t i = 0; i + 3 < len; i += 4) {
        c ^= ((uint32_t)src[i] << 24) | ((uint32_t)src[i + 1] << 16)
           | ((uint32_t)src[i + 2] << 8) | (uint32_t)src[i + 3];
    }
    return (c ^ (c >> 1)) & 0x55555555u;
}

void mfm_join_odd_even(const uint8_t *src, size_t n, uint8_t *dst) {
    for (size_t i = 0; i < n; i++) {
        dst[i] = (uint8_t)(((src[i] << 1) & 0xaa) | (src[n + i] & 0x55));
    }
}

static uint32_t be32(const uint8_t *b) {
    return ((uint32_t)b[0] << 24) | ((uint32_t)b[1] << 16)
         | ((uint32_t)b[2] << 8)  | (uint32_t)b[3];
}

void mfm_decode_track(const uint8_t *mfm, size_t len, uint8_t *adf_out,
                      mfm_decode_result_t *out) {
    memset(out, 0, sizeof *out);
    out->track_no_consistent = true;
    bool have_track_no = false;

    // Sector fields, decoded per candidate. Stack, not static: this runs on
    // core0 and is not re-entrant anyway, and 1 KB of frame is affordable
    // there in a way it would not be on core1's 2 KB stack.
    uint8_t header[4], label[16], hdrsum_raw[4], datsum_raw[4];
    uint8_t data[MFM_SECTOR_DATA_BYTES];
    uint8_t header_and_label[20];

    for (size_t i = 0; i + MFM_SECTOR_MFM_BYTES <= len; ) {
        // 0x4489 twice. The sync word cannot occur in encoded data: it
        // deliberately breaks the MFM clock rule, which is the whole reason
        // Paula can lock onto it.
        if (!(mfm[i] == 0x44 && mfm[i + 1] == 0x89 &&
              mfm[i + 2] == 0x44 && mfm[i + 3] == 0x89)) {
            i++;
            continue;
        }

        size_t at = i + 4;
        mfm_join_odd_even(mfm + at, 4,   header);      at += 8;
        mfm_join_odd_even(mfm + at, 16,  label);       at += 32;
        mfm_join_odd_even(mfm + at, 4,   hdrsum_raw);  at += 8;
        mfm_join_odd_even(mfm + at, 4,   datsum_raw);  at += 8;
        mfm_join_odd_even(mfm + at, MFM_SECTOR_DATA_BYTES, data);

        memcpy(header_and_label, header, 4);
        memcpy(header_and_label + 4, label, 16);

        bool ok = mfm_checksum(header_and_label, 20) == be32(hdrsum_raw)
               && mfm_checksum(data, MFM_SECTOR_DATA_BYTES) == be32(datsum_raw);

        uint8_t sector_id = header[2];
        if (!ok || sector_id >= MFM_SECTORS) {
            // Advance by ONE, not by a sector: a false sync inside data would
            // otherwise skip 1088 bytes and step over the real sector that
            // follows it. Only a sector that verifies earns the long stride.
            out->bad_checksums++;
            i++;
            continue;
        }

        // The track number every sector header carries. A write that landed
        // on the wrong cylinder produces a perfectly valid track whose id is
        // not the one the head is on -- the one corruption a checksum cannot
        // see, because every sector of it is internally consistent.
        if (!have_track_no) { out->track_no = header[1]; have_track_no = true; }
        else if (header[1] != out->track_no) { out->track_no_consistent = false; }

        // First good copy wins. A capture over more than one revolution sees
        // each sector twice; both copies are the same bytes, and taking the
        // first keeps this independent of where the capture happened to
        // start.
        if (!(out->found & (1u << sector_id))) {
            out->found |= (uint16_t)(1u << sector_id);
            memcpy(adf_out + (size_t)sector_id * MFM_SECTOR_DATA_BYTES,
                   data, MFM_SECTOR_DATA_BYTES);
        }
        i += MFM_SECTOR_MFM_BYTES;
    }
}
