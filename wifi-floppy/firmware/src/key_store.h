#ifndef KEY_STORE_H
#define KEY_STORE_H
// The board key (spec 2026-10-18 §5-6): 16 random bytes made once (pico_rand, seeded by the RP2350's TRNG), in a
// flash sector of their own (sector -8), so re-pairing and a server change -- which erase config_store -- keep it,
// and an OTA never touches it (plan 2026-10-19 ruling P2). Receive trusts the board by it. Same two backings and
// record shape as drive_store.c. When to write is the caller's decision (drive_store_should_write's rule).
#include <stdbool.h>
#include <stdint.h>
#define KEY_STORE_BYTES 16
bool key_store_load(uint8_t out[KEY_STORE_BYTES]);        // false: nothing valid stored
bool key_store_save(const uint8_t k[KEY_STORE_BYTES]);    // false on a flash error
void key_store_hex(const uint8_t k[KEY_STORE_BYTES], char out[2 * KEY_STORE_BYTES + 1]);   // lower-case hex
#ifdef WFMF_HOST_TEST
void key_store_erase_for_test(void);
void key_store_corrupt_for_test(void);
#endif
#endif
