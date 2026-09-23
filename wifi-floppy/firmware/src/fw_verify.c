#include "fw_verify.h"
#include "fw_pubkey.h"
#include "monocypher-ed25519.h"
#include <stdio.h>
#include <string.h>

int fw_manifest(const fw_offer_t *o, char *out, int out_len) {
    int n = snprintf(out, (size_t)out_len, "webadf-fw-v1\n%s\n%lu\n%s\n%lu",
                     o->version, (unsigned long)o->sequence, o->sha256, (unsigned long)o->size_bytes);
    return (n < 0 || n >= out_len) ? -1 : n;
}

bool fw_ed25519_check(const uint8_t sig[64], const uint8_t pk[32], const uint8_t *msg, size_t len) {
    return crypto_ed25519_check(sig, pk, msg, len) == 0;
}

fw_verdict_t fw_check_offer_with_key(const fw_offer_t *o, uint32_t installed_sequence,
                                     const char *key_id, const uint8_t pubkey[32]) {
    if (o->version[0] == '\0' || strlen(o->sha256) != 64 || o->sequence == 0 || o->size_bytes == 0) return FW_BAD_FIELDS;
    if (o->size_bytes > FW_MAX_IMAGE_BYTES) return FW_TOO_BIG;
    if (o->sequence <= installed_sequence) return FW_ROLLBACK;
    if (strcmp(o->key_id, key_id) != 0) return FW_UNKNOWN_KEY;
    char m[192];
    int n = fw_manifest(o, m, sizeof m);
    if (n < 0) return FW_BAD_FIELDS;
    return fw_ed25519_check(o->signature, pubkey, (const uint8_t *)m, (size_t)n) ? FW_OK : FW_BAD_SIGNATURE;
}

fw_verdict_t fw_check_offer(const fw_offer_t *o, uint32_t installed_sequence) {
    return fw_check_offer_with_key(o, installed_sequence, FW_PUBKEY_ID, FW_PUBKEY);
}

const char *fw_verdict_text(fw_verdict_t v) {
    switch (v) {
    case FW_OK:            return "ok";
    case FW_BAD_FIELDS:    return "malformed update instruction";
    case FW_TOO_BIG:       return "image larger than 2 MB";
    case FW_ROLLBACK:      return "not newer than the installed release (anti-rollback)";
    case FW_UNKNOWN_KEY:   return "signed by an unknown key";
    case FW_BAD_SIGNATURE: return "signature does not verify";
    }
    return "unknown";
}
