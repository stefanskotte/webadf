#ifndef FW_VERIFY_H
#define FW_VERIFY_H
// Whether a parsed fw_offer_t should be trusted (spec D4/D5): the exact
// manifest a release's signature covers, anti-rollback, key identity, and
// the ed25519 check itself (Monocypher, src/vendor/monocypher).
#include "fw_offer.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef enum { FW_OK, FW_BAD_FIELDS, FW_TOO_BIG, FW_ROLLBACK, FW_UNKNOWN_KEY, FW_BAD_SIGNATURE } fw_verdict_t;

// Builds the exact ASCII bytes a release's signature covers (spec D4):
// "webadf-fw-v1\n<version>\n<sequence>\n<sha256 hex>\n<sizeBytes>", no
// trailing newline. Returns the length written, or -1 if it would not fit
// in out_len.
int fw_manifest(const fw_offer_t *o, char *out, int out_len);

// A thin wrapper over Monocypher's crypto_ed25519_check, so the RFC 8032
// test vector exercises the exact same linked function as the offer path.
bool fw_ed25519_check(const uint8_t sig[64], const uint8_t pk[32], const uint8_t *msg, size_t len);

fw_verdict_t fw_check_offer_with_key(const fw_offer_t *o, uint32_t installed_sequence,
                                     const char *key_id, const uint8_t pubkey[32]);
// Verifies against the compiled-in release key (fw_pubkey.h, FW_PUBKEY_ID/FW_PUBKEY).
fw_verdict_t fw_check_offer(const fw_offer_t *o, uint32_t installed_sequence);

const char *fw_verdict_text(fw_verdict_t v);

#endif
