#include "harness.h"
#include "../src/nfc_tag.h"

static const char *ID = "a1b2c3d4-e5f6-5a7b-8c9d-0e1f2a3b4c5d";

static void crc_check_value(void) {
    // The standard check value for CRC-16/CCITT-FALSE over "123456789".
    CHECK_EQ_INT(nfc_crc16((const uint8_t *)"123456789", 9), 0x29B1);
}
static void round_trip(void) {
    uint8_t b[NFC_TAG_BYTES]; char out[NFC_DISK_ID_LEN + 1];
    CHECK(nfc_tag_encode(ID, b), "encode");
    CHECK(memcmp(b, "WFDK", 4) == 0, "marker");
    CHECK_EQ_INT(b[4], 1); CHECK_EQ_INT(b[5], 36);
    CHECK_EQ_INT(b[44], 0); CHECK_EQ_INT(b[47], 0);          // padding
    CHECK_EQ_INT(nfc_tag_decode(b, out), NFC_TAG_OK);
    CHECK(strcmp(out, ID) == 0, "id back");
}
static void refuses_bad_ids(void) {
    uint8_t b[NFC_TAG_BYTES];
    CHECK(!nfc_tag_encode("A1B2C3D4-E5F6-5A7B-8C9D-0E1F2A3B4C5D", b), "uppercase");
    CHECK(!nfc_tag_encode("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d", b), "not v5 shape");
    CHECK(!nfc_tag_encode("short", b), "short");
}
static void blank_tag_is_not_ours(void) {
    uint8_t b[NFC_TAG_BYTES] = {0}; char out[NFC_DISK_ID_LEN + 1];
    CHECK_EQ_INT(nfc_tag_decode(b, out), NFC_TAG_NOT_OURS);
}
static void flipped_bit_is_bad_data(void) {
    uint8_t b[NFC_TAG_BYTES]; char out[NFC_DISK_ID_LEN + 1];
    nfc_tag_encode(ID, b); b[20] ^= 0x01;
    CHECK_EQ_INT(nfc_tag_decode(b, out), NFC_TAG_BAD_DATA);
}
static void wrong_version_or_length_is_bad_data(void) {
    uint8_t b[NFC_TAG_BYTES]; char out[NFC_DISK_ID_LEN + 1];
    nfc_tag_encode(ID, b); b[4] = 2;
    CHECK_EQ_INT(nfc_tag_decode(b, out), NFC_TAG_BAD_DATA);
    nfc_tag_encode(ID, b); b[5] = 35;
    CHECK_EQ_INT(nfc_tag_decode(b, out), NFC_TAG_BAD_DATA);
}
static void half_written_tag_is_bad_data(void) {
    // Block 4 of a new id over blocks 5-6 of an old one: what a tag pulled
    // away mid-write leaves. Must never decode as either id.
    uint8_t a[NFC_TAG_BYTES], b[NFC_TAG_BYTES]; char out[NFC_DISK_ID_LEN + 1];
    nfc_tag_encode(ID, a); nfc_tag_encode("ffffffff-0000-5000-9000-000000000000", b);
    memcpy(b, a, 16);
    CHECK_EQ_INT(nfc_tag_decode(b, out), NFC_TAG_BAD_DATA);
}
static void decoded_id_is_revalidated(void) {
    // A correct CRC over a malformed id (a tag written by something else
    // using our marker) must still be refused.
    uint8_t b[NFC_TAG_BYTES]; char out[NFC_DISK_ID_LEN + 1];
    nfc_tag_encode(ID, b); b[6] = 'Z';
    uint16_t crc = nfc_crc16(b, 42); b[42] = (uint8_t)(crc >> 8); b[43] = (uint8_t)crc;
    CHECK_EQ_INT(nfc_tag_decode(b, out), NFC_TAG_BAD_DATA);
}
int main(void) {
    RUN(crc_check_value); RUN(round_trip); RUN(refuses_bad_ids); RUN(blank_tag_is_not_ours);
    RUN(flipped_bit_is_bad_data); RUN(wrong_version_or_length_is_bad_data);
    RUN(half_written_tag_is_bad_data); RUN(decoded_id_is_revalidated);
    return REPORT();
}
