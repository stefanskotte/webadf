#ifndef TLS_MEM_H
#define TLS_MEM_H
// mbedTLS's allocator, counted. mbedtls_config.h routes mbedtls_calloc/
// mbedtls_free here (MBEDTLS_PLATFORM_CALLOC_MACRO / _FREE_MACRO), and these
// pass straight through to the system calloc/free -- the same heap, the same
// pico_malloc mutex -- adding only a size header and four counters.
//
// Why: OTA downloads stalled on boards up for hours and nothing said why.
// The suspicion is that a TLS allocation fails (a record buffer is one
// contiguous ~16 KB chunk), and main.c's "heap: free low-water" line cannot
// see that: a malloc whose sbrk is refused leaves the break where it was, so
// the low-water figure stays put while the allocation fails. These counters
// see it directly -- every failed mbedtls_calloc and the size it asked for.
//
// Pure C, no SDK: test/test_tls_mem.c drives it on the host.
#include <stddef.h>
#include <stdint.h>

void *wf_tls_calloc(size_t n, size_t size);
void  wf_tls_free(void *p);

typedef struct {
    uint32_t held;            // bytes mbedTLS holds right now (payload, not headers)
    uint32_t peak;            // the most it has ever held at once
    uint32_t fails;           // mbedtls_calloc calls that returned NULL
    uint32_t last_fail_bytes; // the size the most recent of those asked for
} tls_mem_stats_t;

// A snapshot. Each field is read atomically; the four together are not one
// consistent instant (an allocation may land between them) -- it is a
// diagnostic, not an accounting system.
void tls_mem_stats(tls_mem_stats_t *out);

// Host tests only: make the next `n` allocations fail, as an exhausted heap would.
void tls_mem_test_fail_next(int n);
void tls_mem_test_reset(void);

#endif
