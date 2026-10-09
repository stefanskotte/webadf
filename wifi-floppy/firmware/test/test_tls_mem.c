#include "harness.h"
#include "../src/tls_mem.h"
#include <stdint.h>
#include <string.h>

// tls_mem.c is mbedTLS's allocator on the device (mbedtls_config.h). What it
// must get right: hand back zeroed, aligned memory exactly as calloc would,
// and count what is held, the peak, and every failure with its size.

static void test_counts_held_and_peak(void) {
    tls_mem_test_reset();
    tls_mem_stats_t m;
    uint8_t *a = wf_tls_calloc(1, 16429);
    uint8_t *b = wf_tls_calloc(4, 100);
    CHECK(a && b, "allocations succeed");
    CHECK(((uintptr_t)a & 7u) == 0 && ((uintptr_t)b & 7u) == 0, "8-byte aligned");
    int zero = 1;
    for (int i = 0; i < 16429; i++) if (a[i]) zero = 0;
    CHECK(zero, "calloc semantics: zeroed");
    tls_mem_stats(&m);
    CHECK_EQ_INT(m.held, 16429 + 400);
    CHECK_EQ_INT(m.peak, 16429 + 400);
    wf_tls_free(a);
    tls_mem_stats(&m);
    CHECK_EQ_INT(m.held, 400);
    CHECK_EQ_INT(m.peak, 16429 + 400);
    wf_tls_free(b);
    wf_tls_free(NULL);
    tls_mem_stats(&m);
    CHECK_EQ_INT(m.held, 0);
    CHECK_EQ_INT(m.fails, 0);
}

static void test_counts_failures_with_their_size(void) {
    tls_mem_test_reset();
    tls_mem_test_fail_next(1);
    CHECK(wf_tls_calloc(1, 16429) == NULL, "an exhausted heap returns NULL");
    tls_mem_stats_t m;
    tls_mem_stats(&m);
    CHECK_EQ_INT(m.fails, 1);
    CHECK_EQ_INT(m.last_fail_bytes, 16429);
    CHECK_EQ_INT(m.held, 0);
    void *p = wf_tls_calloc(1, 32);
    CHECK(p != NULL, "the next one succeeds again");
    wf_tls_free(p);
}

static void test_overflowing_product_is_null(void) {
    tls_mem_test_reset();
    CHECK(wf_tls_calloc(SIZE_MAX / 2, 4) == NULL, "n*size overflow is refused, like calloc");
    tls_mem_stats_t m;
    tls_mem_stats(&m);
    CHECK_EQ_INT(m.fails, 1);
}

int main(void) {
    RUN(test_counts_held_and_peak);
    RUN(test_counts_failures_with_their_size);
    RUN(test_overflowing_product_is_null);
    return REPORT();
}
