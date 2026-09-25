#include "nfc_tag.h"
#include <string.h>

// Content layout inside the 48-byte block 4..6 payload:
//   [0..3]   marker "WFDK"
//   [4]      version (1)
//   [5]      length (36 -- NFC_DISK_ID_LEN)
//   [6..41]  the disk id, ASCII, NOT NUL-terminated on the tag
//   [42..43] CRC-16/CCITT-FALSE over [0..41], big-endian
//   [44..47] padding, always zero
//
// 42 content bytes + 2 CRC bytes = 44; the last 4 of the 48 are padding
// rather than part of the checksum, so a future field could be added there
// without invalidating every tag already in the field -- not used yet, but
// zero is a value worth being deliberate about rather than "whatever CRC
// happened to be").
#define NFC_CONTENT_BYTES 42

uint16_t nfc_crc16(const uint8_t *b, int n) {
    uint16_t crc = 0xFFFF;
    for (int i = 0; i < n; i++) {
        crc ^= (uint16_t)b[i] << 8;
        for (int bit = 0; bit < 8; bit++) {
            crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
        }
    }
    return crc;
}

bool nfc_disk_id_valid(const char *id) {
    // ^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$
    if (strlen(id) != NFC_DISK_ID_LEN) return false;
    for (int i = 0; i < NFC_DISK_ID_LEN; i++) {
        char c = id[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (c != '-') return false;
        } else if (i == 14) {
            if (c != '5') return false;
        } else if (i == 19) {
            if (c != '8' && c != '9' && c != 'a' && c != 'b') return false;
        } else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
            return false;
        }
    }
    return true;
}

bool nfc_tag_encode(const char *disk_id, uint8_t out[NFC_TAG_BYTES]) {
    // Refuse before touching `out` at all -- never leave a caller holding a
    // half-built payload for an id that doesn't have the shape it's meant to.
    if (!nfc_disk_id_valid(disk_id)) return false;

    memset(out, 0, NFC_TAG_BYTES);
    memcpy(out, "WFDK", 4);
    out[4] = 1;
    out[5] = NFC_DISK_ID_LEN;
    memcpy(out + 6, disk_id, NFC_DISK_ID_LEN);

    uint16_t crc = nfc_crc16(out, NFC_CONTENT_BYTES);
    out[42] = (uint8_t)(crc >> 8);
    out[43] = (uint8_t)crc;
    // out[44..47] are already zero from the memset above.
    return true;
}

nfc_tag_result_t nfc_tag_decode(const uint8_t in[NFC_TAG_BYTES], char disk_id[NFC_DISK_ID_LEN + 1]) {
    // 1. No marker at all: a blank tag, or someone else's -- not an error,
    //    just not ours.
    if (memcmp(in, "WFDK", 4) != 0) return NFC_TAG_NOT_OURS;

    // 2. Our marker, but a version or length we don't understand.
    if (in[4] != 1 || in[5] != NFC_DISK_ID_LEN) return NFC_TAG_BAD_DATA;

    // 3. Integrity: catches a flipped bit, and a tag pulled away mid-write
    //    (block 4 of one id over blocks 5-6 of another -- the CRC was
    //    computed over the whole 42 bytes together, so a mismatched half
    //    almost never lands on a value that still checksums).
    uint16_t crc = nfc_crc16(in, NFC_CONTENT_BYTES);
    uint16_t stored = ((uint16_t)in[42] << 8) | in[43];
    if (crc != stored) return NFC_TAG_BAD_DATA;

    // 4. The CRC covers only that the bytes weren't corrupted in transit --
    //    it says nothing about whether they were ever a valid disk id in the
    //    first place (a correct CRC over garbage is still a correct CRC).
    //    Re-check the shape independently.
    memcpy(disk_id, in + 6, NFC_DISK_ID_LEN);
    disk_id[NFC_DISK_ID_LEN] = '\0';
    if (!nfc_disk_id_valid(disk_id)) return NFC_TAG_BAD_DATA;

    return NFC_TAG_OK;
}
