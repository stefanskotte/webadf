#ifndef TOKEN_STORE_H
#define TOKEN_STORE_H
// Persists the one device bearer token issued by POST /api/device/register
// (device_client.h's dc_register) across power cycles. PSRAM does not
// survive a reset (psram_image.h), and neither does device_client_t's RAM
// state, so without this every boot would have to re-register -- and each
// pairing code is single-use server-side, so that would strand the device
// after its first reboot.
//
// Host build (WFMF_HOST_TEST): a static in-process buffer.
// Device build: a dedicated flash sector via hardware/flash.h, written
// with pico/flash.h's flash_safe_execute. See token_store.c's header
// comment and main.c's DMA IRQ comment for why a flash write needs that
// much care on this board -- it is not just "slow", it can make the
// floppy bus look intermittently broken.
#include <stdbool.h>

// Longest token this store holds, not counting the NUL terminator.
// Comfortably under a single 256-byte flash program page, with room to
// spare for whatever the server actually issues.
#define TOKEN_STORE_MAX_LEN 127

// False if nothing is stored (a freshly erased sector, or erase() was
// called and nothing has been saved since). On success `out` is
// NUL-terminated, truncated to fit `out_len` if the stored token were
// somehow longer (it never should be -- token_store_save() itself refuses
// anything over TOKEN_STORE_MAX_LEN).
bool token_store_load(char *out, int out_len);

// False if `token` is longer than TOKEN_STORE_MAX_LEN, or if a disk is
// currently mounted (psram_active_slot() != SLOT_NONE -- see psram_image.h).
// Registration always happens before anything is mounted, so the mounted
// check should never fire in normal operation; it exists purely to catch
// a future caller that tries to write a token while a disk is streaming,
// which -- see main.c's DMA IRQ comment -- risks a stall the Amiga would
// see as a malformed revolution.
bool token_store_save(const char *token);

// Clears whatever is stored. token_store_load() returns false afterwards
// until the next successful token_store_save(). Refuses (a silent no-op)
// under the same mounted-disk guard as token_store_save() -- erasing is
// still a flash write, not merely forgetting something in RAM.
void token_store_erase(void);

// Host tests only (declared unconditionally, like psram_image_set_backing()
// above it in spirit -- see psram_image.h): never called on device.
// Simulates a flash program that started but was interrupted before it
// finished (e.g. a power loss mid-write), so a test can prove
// token_store_load() reports "nothing stored" for a torn write instead of
// surfacing whatever partial bytes happen to look like a token.
void token_store_test_simulate_torn_write(void);

#endif
