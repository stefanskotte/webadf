#include "fw_apply.h"
#include "sha256.h"
#include <string.h>

static bool program_chunk(const fw_flash_t *f, uint32_t off, const uint8_t *src, uint32_t n) {
    static uint8_t sector[FW_SECTOR_BYTES];   // static: 4 KB is too much for core1's stack
    memset(sector, 0xFF, sizeof sector);
    memcpy(sector, src, n);
    return f->program_sector(f->ctx, off, sector);
}

fw_apply_result_t fw_apply_image(const fw_flash_t *f, uint32_t slot_off, uint32_t slot_len,
                                 const uint8_t *img, uint32_t len, const char *sha_hex) {
    uint32_t nsec = (len + FW_SECTOR_BYTES - 1) / FW_SECTOR_BYTES;
    if (len == 0 || nsec * FW_SECTOR_BYTES > slot_len) return FWA_TOO_BIG;
    // Header first: from here until the very last program, the slot holds no
    // valid IMAGE_DEF -- neither the old image's nor a half-written new one.
    if (!f->erase_sector(f->ctx, slot_off)) return FWA_ERASE_FAILED;
    for (uint32_t i = 1; i < nsec; i++) {
        uint32_t off = slot_off + i * FW_SECTOR_BYTES;
        uint32_t n = len - i * FW_SECTOR_BYTES;
        if (n > FW_SECTOR_BYTES) n = FW_SECTOR_BYTES;
        if (!f->erase_sector(f->ctx, off)) return FWA_ERASE_FAILED;
        if (!program_chunk(f, off, img + i * FW_SECTOR_BYTES, n)) return FWA_PROGRAM_FAILED;
    }
    if (!program_chunk(f, slot_off, img, len < FW_SECTOR_BYTES ? len : FW_SECTOR_BYTES))
        return FWA_PROGRAM_FAILED;
    sha256_t s; uint8_t d[32]; char hex[65];
    sha256_init(&s);
    sha256_update(&s, f->raw(f->ctx, slot_off), len);
    sha256_final(&s, d);
    sha256_hex(d, hex);
    return strcmp(hex, sha_hex) == 0 ? FWA_OK : FWA_READBACK_MISMATCH;
}

const char *fw_apply_text(fw_apply_result_t r) {
    switch (r) {
    case FWA_OK:                return "ok";
    case FWA_TOO_BIG:           return "image does not fit the slot";
    case FWA_ERASE_FAILED:      return "flash erase failed";
    case FWA_PROGRAM_FAILED:    return "flash write failed";
    case FWA_READBACK_MISMATCH: return "flash readback did not match the signed hash";
    }
    return "unknown";
}
