#ifndef NFC_TAG_H
#define NFC_TAG_H
// The WFDK v1 tag payload: what nfc_reader.c writes into (and reads back
// from) MIFARE Classic 1K sector 1, blocks 4-6, and nothing about the
// reader itself. Pure C so it can be host-tested -- see the RULE in
// display.h/device_client.h for why that split exists project-wide.
//
// RULE: this file and nfc_tag.c may include only C standard headers.
#include <stdint.h>
#include <stdbool.h>

// Three MIFARE Classic blocks (4, 5, 6), 16 bytes each. Block 7 (the sector
// trailer -- keys and access bits) is never part of this payload; it is
// never written (see global-constraints.md).
#define NFC_TAG_BYTES   48
// stableId is a UUIDv5, 36 characters including hyphens.
#define NFC_DISK_ID_LEN 36

typedef enum {
    NFC_TAG_OK,         // marker, version, length and CRC all check out, and
                         // the id inside has the disk-id shape
    NFC_TAG_NOT_OURS,   // no WFDK marker -- a blank tag, or someone else's
    NFC_TAG_BAD_DATA,   // WFDK marker present, but version/length/CRC/shape
                         // don't check out: corrupt, foreign, or a tag pulled
                         // away mid-write
} nfc_tag_result_t;

// CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no xorout.
uint16_t nfc_crc16(const uint8_t *b, int n);

// The DISK_ID_RE shape (global-constraints.md):
// ^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$
bool nfc_disk_id_valid(const char *id);

// Encodes `disk_id` into the 48-byte block-4..6 payload. Fails (returns
// false, leaves `out` untouched) if `disk_id` doesn't have the disk-id
// shape -- nothing is ever written to a tag for an id that couldn't be
// read back.
bool nfc_tag_encode(const char *disk_id, uint8_t out[NFC_TAG_BYTES]);

// Decodes a 48-byte block-4..6 read into `disk_id` (NUL-terminated, so the
// caller's buffer must be at least NFC_DISK_ID_LEN + 1 bytes). See
// nfc_tag.c for the exact check order.
nfc_tag_result_t nfc_tag_decode(const uint8_t in[NFC_TAG_BYTES], char disk_id[NFC_DISK_ID_LEN + 1]);

#endif
