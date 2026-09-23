#include "harness.h"
#include "fw_fixture.h"
#include "../src/fw_offer.h"
#include "../src/fw_verify.h"
#include "../src/fw_pubkey.h"
#include <string.h>

static const char *OFFER_JSON =
    "{\"version\":\"" FIX_VERSION "\",\"sequence\":7,\"sha256\":\"" FIX_SHA256 "\","
    "\"sizeBytes\":533624,\"signature\":\"" FIX_SIGNATURE_B64 "\",\"keyId\":\"" FIX_KEY_ID "\"}";

static fw_offer_t parsed(void) {
    fw_offer_t o; memset(&o, 0, sizeof o);
    CHECK(fw_offer_parse(OFFER_JSON, &o), "the fixture offer parses");
    return o;
}

// The one test that matters most: node:crypto signed the SERVER's manifest; Monocypher
// must verify it over the FIRMWARE's manifest. If the two manifests differ by one byte,
// this fails.
static void test_cross_implementation_signature_verifies(void) {
    fw_offer_t o = parsed();
    char m[256];
    CHECK(fw_manifest(&o, m, sizeof m) == (int)strlen(FIX_MANIFEST), "manifest length");
    CHECK(strcmp(m, FIX_MANIFEST) == 0, "the firmware builds the server's manifest exactly");
    CHECK_EQ_INT(fw_check_offer_with_key(&o, 0, FIX_KEY_ID, FIX_PUBKEY), FW_OK);
}
// RFC 8032 section 7.1, TEST 2: proves the SHA-512 Ed25519 variant, not Monocypher's
// default BLAKE2b EdDSA, is what is linked.
static void test_rfc8032_test2(void) {
    static const uint8_t pk[32] = {
        0x3d,0x40,0x17,0xc3,0xe8,0x43,0x89,0x5a,0x92,0xb7,0x0a,0xa7,0x4d,0x1b,0x7e,0xbc,
        0x9c,0x98,0x2c,0xcf,0x2e,0xc4,0x96,0x8c,0xc0,0xcd,0x55,0xf1,0x2a,0xf4,0x66,0x0c };
    static const uint8_t sig[64] = {
        0x92,0xa0,0x09,0xa9,0xf0,0xd4,0xca,0xb8,0x72,0x0e,0x82,0x0b,0x5f,0x64,0x25,0x40,
        0xa2,0xb2,0x7b,0x54,0x16,0x50,0x3f,0x8f,0xb3,0x76,0x22,0x23,0xeb,0xdb,0x69,0xda,
        0x08,0x5a,0xc1,0xe4,0x3e,0x15,0x99,0x6e,0x45,0x8f,0x36,0x13,0xd0,0xf1,0x1d,0x8c,
        0x38,0x7b,0x2e,0xae,0xb4,0x30,0x2a,0xee,0xb0,0x0d,0x29,0x16,0x12,0xbb,0x0c,0x00 };
    static const uint8_t msg[1] = { 0x72 };
    CHECK(fw_ed25519_check(sig, pk, msg, 1), "RFC 8032 TEST 2 verifies");
    uint8_t bad[64]; memcpy(bad, sig, 64); bad[0] ^= 1;
    CHECK(!fw_ed25519_check(bad, pk, msg, 1), "and a flipped bit does not");
}
static void test_tampered_sequence_is_refused(void) {
    fw_offer_t o = parsed(); o.sequence = 99;   // a server lying about the sequence
    CHECK_EQ_INT(fw_check_offer_with_key(&o, 0, FIX_KEY_ID, FIX_PUBKEY), FW_BAD_SIGNATURE);
}
static void test_tampered_sha_is_refused(void) {
    fw_offer_t o = parsed(); o.sha256[0] = 'c';
    CHECK_EQ_INT(fw_check_offer_with_key(&o, 0, FIX_KEY_ID, FIX_PUBKEY), FW_BAD_SIGNATURE);
}
static void test_rollback_is_refused_before_the_signature(void) {
    fw_offer_t o = parsed();
    CHECK_EQ_INT(fw_check_offer_with_key(&o, 7, FIX_KEY_ID, FIX_PUBKEY), FW_ROLLBACK);
    CHECK_EQ_INT(fw_check_offer_with_key(&o, 8, FIX_KEY_ID, FIX_PUBKEY), FW_ROLLBACK);
    CHECK_EQ_INT(fw_check_offer_with_key(&o, 6, FIX_KEY_ID, FIX_PUBKEY), FW_OK);
}
static void test_unknown_key_is_refused(void) {
    fw_offer_t o = parsed();
    CHECK_EQ_INT(fw_check_offer_with_key(&o, 0, "wf-someoneelse", FIX_PUBKEY), FW_UNKNOWN_KEY);
}
static void test_too_big_is_refused(void) {
    fw_offer_t o = parsed(); o.size_bytes = FW_MAX_IMAGE_BYTES + 1;
    CHECK_EQ_INT(fw_check_offer_with_key(&o, 0, FIX_KEY_ID, FIX_PUBKEY), FW_TOO_BIG);
}
static void test_the_release_key_is_compiled_in(void) {
    CHECK(strcmp(FW_PUBKEY_ID, "wf-1138f25902223da4") == 0, "the committed release key");
    fw_offer_t o = parsed();   // signed by the TEST key: the real key must refuse it
    CHECK_EQ_INT(fw_check_offer(&o, 0), FW_UNKNOWN_KEY);
}
static void test_malformed_offers_do_not_parse(void) {
    fw_offer_t o;
    CHECK(!fw_offer_parse("{\"version\":\"1.0.0+g\",\"sequence\":7}", &o), "missing fields");
    CHECK(!fw_offer_parse("{\"version\":\"1.0.0+g\",\"sequence\":7,\"sha256\":\"xyz\","
                          "\"sizeBytes\":1,\"signature\":\"" FIX_SIGNATURE_B64 "\",\"keyId\":\"k\"}", &o),
          "a sha256 that is not 64 hex");
    CHECK(!fw_offer_parse("{\"version\":\"1.0.0+g\",\"sequence\":7,\"sha256\":\"" FIX_SHA256 "\","
                          "\"sizeBytes\":1,\"signature\":\"AA==\",\"keyId\":\"k\"}", &o),
          "a signature that is not 64 bytes");
    CHECK(!fw_offer_parse("{\"version\":\"\",\"sequence\":7,\"sha256\":\"" FIX_SHA256 "\","
                          "\"sizeBytes\":1,\"signature\":\"" FIX_SIGNATURE_B64 "\",\"keyId\":\"k\"}", &o),
          "an empty version");
}

int main(void) {
    RUN(test_cross_implementation_signature_verifies);
    RUN(test_rfc8032_test2);
    RUN(test_tampered_sequence_is_refused);
    RUN(test_tampered_sha_is_refused);
    RUN(test_rollback_is_refused_before_the_signature);
    RUN(test_unknown_key_is_refused);
    RUN(test_too_big_is_refused);
    RUN(test_the_release_key_is_compiled_in);
    RUN(test_malformed_offers_do_not_parse);
    return REPORT();
}
