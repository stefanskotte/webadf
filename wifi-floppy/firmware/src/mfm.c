// MFM helpers for the write-back path. The read path never needs these —
// the server ships pre-encoded MFM. Decode here is a skeleton for turning
// captured flux intervals back into an ADF track for POSTing upstream.
#include "mfm.h"

// Convert a flux interval (ns) into 1..3 MFM bitcells at 2us nominal.
int mfm_interval_to_bits(uint32_t ns) {
    if (ns < 3000) return 2;        //  ~4us  -> 10
    if (ns < 5000) return 3;        //  ~6us  -> 100
    return 4;                       //  ~8us  -> 1000
}

// TODO: full Amiga sector decode (odd/even split, 0x4489 sync, checksums).
// See http://lclevy.free.fr/adflib/adf_info.html for the layout reference.
int mfm_decode_track(const uint32_t *intervals, int n, uint8_t *adf_out) {
    (void)intervals; (void)n; (void)adf_out;
    return -1;
}
