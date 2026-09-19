#include "harness.h"
#include "../src/sha256.h"
#include <stdlib.h>
#include <string.h>

static void hex_of(const uint8_t *p, size_t n, char out[65]) {
    sha256_t s; uint8_t d[32];
    sha256_init(&s); sha256_update(&s, p, n); sha256_final(&s, d); sha256_hex(d, out);
}

static void fips_vectors(void) {
    char h[65];
    hex_of((const uint8_t *)"", 0, h);
    CHECK(strcmp(h, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855") == 0, "empty");
    hex_of((const uint8_t *)"abc", 3, h);
    CHECK(strcmp(h, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") == 0, "abc");
    const char *m = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    hex_of((const uint8_t *)m, strlen(m), h);
    CHECK(strcmp(h, "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1") == 0,
          "two-block message (padding crosses a block)");
}

static void million_a(void) {
    uint8_t *p = malloc(1000000); memset(p, 'a', 1000000);
    char h[65]; hex_of(p, 1000000, h); free(p);
    CHECK(strcmp(h, "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0") == 0,
          "one million 'a'");
}

// The board hashes a disk track by track: 160 updates of 5,632 bytes. The
// digest must not depend on how the bytes were split.
static void chunked_equals_one_shot(void) {
    const size_t len = 901120;
    uint8_t *p = malloc(len);
    for (size_t i = 0; i < len; i++) p[i] = (uint8_t)(i * 31 + (i >> 9));
    char one[65]; hex_of(p, len, one);
    sha256_t s; uint8_t d[32]; char chunked[65];
    sha256_init(&s);
    for (size_t off = 0; off < len; off += 5632) sha256_update(&s, p + off, 5632);
    sha256_final(&s, d); sha256_hex(d, chunked);
    CHECK(strcmp(one, chunked) == 0, "track-sized chunks give the one-shot digest");
    free(p);
}

int main(void) {
    RUN(fips_vectors);
    RUN(million_a);
    RUN(chunked_equals_one_shot);
    return REPORT();
}
