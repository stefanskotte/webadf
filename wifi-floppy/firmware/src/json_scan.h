#ifndef JSON_SCAN_H
#define JSON_SCAN_H
// A minimal, allocation-free JSON scanner for exactly the shapes the device
// contract needs: a poll response with a handful of top-level and one
// level of nested keys (device_client.c reads four of them). A full parser
// is not warranted for that, but the scanner must still be honest about
// string boundaries -- see json_scan.c's header comment.
#include <stdint.h>
#include <stdbool.h>

// Extract a string value by key. Returns false if absent. Handles the value
// being null (returns true with out[0] == 0).
bool json_str(const char *json, const char *key, char *out, int out_len);
bool json_u32(const char *json, const char *key, uint32_t *out);
// Like json_u32, but refuses what json_u32 silently accepts: trailing
// garbage right after the digits (a decimal point, an exponent, a stray
// letter -- "7.9" and "7e2" both read as 7 through json_u32) and a value
// that overflows uint32_t (json_u32 wraps -- 4294967303 reads as 7).
// Existing callers of json_u32 are unaffected; this is a new, additive
// entry point, added for fw_offer.c, where a wrapped or truncated number
// is a spoofing surface rather than a cosmetic parsing quirk.
bool json_u32_strict(const char *json, const char *key, uint32_t *out);
bool json_bool(const char *json, const char *key, bool *out);
// True if `key` is present with a literal null value.
bool json_is_null(const char *json, const char *key);
// True if `key` is present at all, whatever its value (null included).
bool json_has(const char *json, const char *key);

// Copies the {...} value of `key` (brace-matched, strings respected) into out.
// If `blank` is true the object is overwritten with spaces in `json` afterwards, so
// later flat key lookups can no longer see keys nested inside it.
bool json_object(char *json, const char *key, char *out, int out_len, bool blank);

#endif
