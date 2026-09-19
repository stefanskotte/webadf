#ifndef SHA256_H
#define SHA256_H
// FIPS 180-4 SHA-256, pure C, so the host tests and the board run the same
// code. The board uses it once per write session: the digest of the whole
// 901,120-byte image it holds, sent with the close so the server can confirm
// it recorded exactly those bytes (write-back spec §3.1).
#include <stdint.h>
#include <stddef.h>

typedef struct { uint32_t h[8]; uint64_t len; uint8_t buf[64]; size_t n; } sha256_t;

void sha256_init(sha256_t *s);
void sha256_update(sha256_t *s, const uint8_t *p, size_t len);
void sha256_final(sha256_t *s, uint8_t out[32]);
/** Lowercase hex, NUL-terminated -- the form the server's routes compare. */
void sha256_hex(const uint8_t digest[32], char out[65]);
#endif
