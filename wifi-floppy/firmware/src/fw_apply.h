#ifndef FW_APPLY_H
#define FW_APPLY_H
// D7: write a downloaded image into the other flash slot so a power cut
// leaves nothing half-bootable. The header (first) sector is erased FIRST
// and programmed LAST -- until the very last write, the slot holds no valid
// IMAGE_DEF, neither the old image's nor a half-written new one, so the boot
// ROM can never pick it up mid-write. Pure: driven through fw_flash_t so the
// host tests exercise it against a fake, and the device (fw_rom.c) supplies
// the real flash_range_erase/flash_range_program ops.
#include <stdint.h>
#include <stdbool.h>

#define FW_SECTOR_BYTES 4096u

typedef struct {
    bool (*erase_sector)(void *ctx, uint32_t flash_off);
    bool (*program_sector)(void *ctx, uint32_t flash_off, const uint8_t data[4096]);
    const uint8_t *(*raw)(void *ctx, uint32_t flash_off);     // physical flash, readable
    void *ctx;
} fw_flash_t;

typedef enum { FWA_OK, FWA_TOO_BIG, FWA_ERASE_FAILED, FWA_PROGRAM_FAILED, FWA_READBACK_MISMATCH } fw_apply_result_t;

fw_apply_result_t fw_apply_image(const fw_flash_t *f, uint32_t slot_off, uint32_t slot_len,
                                 const uint8_t *img, uint32_t len, const char *sha_hex);
const char *fw_apply_text(fw_apply_result_t r);

#endif // FW_APPLY_H
