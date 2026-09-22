#ifndef FW_STATE_H
#define FW_STATE_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#define FW_STATE_VERSION_MAX 64
#define FW_STATE_REASON_MAX  48
#define FW_STATE_RECORD_BYTES 132

typedef struct {
    uint32_t installed_sequence;                    // 0 = none recorded (hand-flashed / first install)
    bool     pending;                               // flashed + rebooted into, not yet confirmed
    uint32_t pending_sequence;
    char     pending_version[FW_STATE_VERSION_MAX + 1];
    char     failure[FW_STATE_REASON_MAX + 1];      // why the trial image gave up, "" if unknown
} fw_state_t;

bool fw_state_encode(const fw_state_t *s, uint8_t out[FW_STATE_RECORD_BYTES]);
bool fw_state_decode(const uint8_t *p, fw_state_t *out);   // false => *out zeroed
bool fw_state_load(fw_state_t *out);                        // false => *out zeroed
bool fw_state_save(const fw_state_t *s);                    // false while a disk is mounted
void fw_state_test_erase(void);                             // host build only
uint8_t *fw_state_test_raw(void);                           // host build only

#endif
