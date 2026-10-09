#include "tls_mem.h"
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

// Every mbedTLS allocation happens on core1 -- in its thread and in the lwIP
// background IRQ the radio runs on that same core -- so a plain `held += n`
// could be torn by that IRQ. The __atomic builtins are LDREX/STREX on the
// Cortex-M33 (and RP2350 SRAM supports exclusives across both cores), so the
// counters stay right whoever calls. No lock is taken: the allocation itself
// is already serialised by pico_malloc's mutex.
static uint32_t g_held, g_peak, g_fails, g_last_fail;
static int g_test_fail_next;

// 8 bytes, not 4: newlib hands out 8-aligned blocks, and the pointer
// returned to mbedTLS must stay 8-aligned (it stores uint64_t in some).
typedef union { size_t size; uint64_t align; } tls_mem_hdr_t;

static void note_fail(size_t bytes) {
    __atomic_fetch_add(&g_fails, 1u, __ATOMIC_RELAXED);
    __atomic_store_n(&g_last_fail, (uint32_t)bytes, __ATOMIC_RELAXED);
}

void *wf_tls_calloc(size_t n, size_t size) {
    // mbedtls_calloc's contract is calloc's: an overflowing product is a
    // NULL, not a short block.
    if (size != 0 && n > (SIZE_MAX - sizeof(tls_mem_hdr_t)) / size) {
        note_fail(SIZE_MAX);
        return NULL;
    }
    const size_t bytes = n * size;
    tls_mem_hdr_t *h = NULL;
    if (g_test_fail_next > 0) {
        g_test_fail_next--;
    } else {
        h = calloc(1, sizeof *h + bytes);
    }
    if (!h) {
        note_fail(bytes);
        return NULL;
    }
    h->size = bytes;
    const uint32_t now = __atomic_add_fetch(&g_held, (uint32_t)bytes, __ATOMIC_RELAXED);
    uint32_t peak = __atomic_load_n(&g_peak, __ATOMIC_RELAXED);
    while (now > peak &&
           !__atomic_compare_exchange_n(&g_peak, &peak, now, true,
                                        __ATOMIC_RELAXED, __ATOMIC_RELAXED)) {
        // `peak` was reloaded by the failed exchange; try again while still higher.
    }
    return h + 1;
}

void wf_tls_free(void *p) {
    if (!p) return;
    tls_mem_hdr_t *h = (tls_mem_hdr_t *)p - 1;
    __atomic_fetch_sub(&g_held, (uint32_t)h->size, __ATOMIC_RELAXED);
    free(h);
}

void tls_mem_stats(tls_mem_stats_t *out) {
    out->held            = __atomic_load_n(&g_held, __ATOMIC_RELAXED);
    out->peak            = __atomic_load_n(&g_peak, __ATOMIC_RELAXED);
    out->fails           = __atomic_load_n(&g_fails, __ATOMIC_RELAXED);
    out->last_fail_bytes = __atomic_load_n(&g_last_fail, __ATOMIC_RELAXED);
}

void tls_mem_test_fail_next(int n) { g_test_fail_next = n; }
void tls_mem_test_reset(void) {
    g_held = g_peak = g_fails = g_last_fail = 0;
    g_test_fail_next = 0;
}
