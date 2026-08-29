#ifndef MFM_H
#define MFM_H
#include <stdint.h>
int mfm_interval_to_bits(uint32_t ns);
int mfm_decode_track(const uint32_t *intervals, int n, uint8_t *adf_out);
#endif
