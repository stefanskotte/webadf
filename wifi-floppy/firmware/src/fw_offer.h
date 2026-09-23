#ifndef FW_OFFER_H
#define FW_OFFER_H
// A parsed, not-yet-verified firmware update offer (spec D4/D5). Parsing here
// only checks shape (fields present, right lengths, a path-safe version);
// fw_verify.h checks whether it should be trusted.
#include <stdint.h>
#include <stdbool.h>

#define FW_MAX_IMAGE_BYTES (2u * 1024u * 1024u)
#define FW_KEY_ID_MAX 32

typedef struct {
    char     version[65];
    uint32_t sequence;
    char     sha256[65];
    uint32_t size_bytes;
    uint8_t  signature[64];
    char     key_id[FW_KEY_ID_MAX + 1];
} fw_offer_t;

// Parses `update_json` (the poll response's "update" object) into `out`.
// Returns false if any field is missing or malformed: a wrong-length hex
// sha256, a signature that does not decode to exactly 64 bytes, an empty
// version or key id, or a version with any character outside [A-Za-z0-9.+-],
// a leading '.', or no alphanumeric at all (it becomes part of the firmware
// GET's request path).
bool fw_offer_parse(const char *update_json, fw_offer_t *out);

#endif
