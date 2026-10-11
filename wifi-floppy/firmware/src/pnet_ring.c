/* PaulaNET Phase 1's frame rings (pnet_ring.h). */
#include "pnet_ring.h"
#include <string.h>
#ifdef WFMF_HOST_TEST
#define RING_BARRIER() __atomic_thread_fence(__ATOMIC_SEQ_CST)
#else
#include "hardware/sync.h"
#define RING_BARRIER() __dmb()
#endif

#define LEN_AT  0u
#define DATA_AT 16u
_Static_assert(DATA_AT + PNET_RING_MTU <= PNET_RING_SLOT, "a frame fits its slot");

static uint8_t *slot(const pnet_ring_t *r, uint32_t i) {
    return r->slots + (size_t)(i & (r->n - 1u)) * PNET_RING_SLOT;
}

bool pnet_ring_init(pnet_ring_t *r, uint8_t *mem, uint32_t n) {
    const bool ok = n != 0u && (n & (n - 1u)) == 0u;
    r->slots = mem;
    r->n = ok ? n : 0u;
    r->head = r->tail = 0u;
    r->drops = 0u;
    return ok;
}

uint32_t pnet_ring_count(const pnet_ring_t *r) {
    const uint32_t h = r->head, t = r->tail;
    RING_BARRIER();                       /* acquire: slot reads (or overwrites) come after */
    return h - t;
}

uint32_t pnet_ring_space(const pnet_ring_t *r) { return r->n - pnet_ring_count(r); }

uint8_t *pnet_ring_claim(pnet_ring_t *r) {
    if (pnet_ring_space(r) == 0u) { r->drops = r->drops + 1u; return NULL; }
    return slot(r, r->head) + DATA_AT;
}

void pnet_ring_commit(pnet_ring_t *r, uint16_t len) {
    memcpy(slot(r, r->head) + LEN_AT, &len, sizeof len);
    RING_BARRIER();                       /* release: the bytes before the index that publishes them */
    r->head = r->head + 1u;
}

bool pnet_ring_push(pnet_ring_t *r, const uint8_t *f, uint16_t len) {
    if (len == 0u || len > PNET_RING_MTU) { r->drops = r->drops + 1u; return false; }
    uint8_t *d = pnet_ring_claim(r);
    if (!d) return false;
    memcpy(d, f, len);
    pnet_ring_commit(r, len);
    return true;
}

const uint8_t *pnet_ring_peek(const pnet_ring_t *r, uint32_t i, uint16_t *len) {
    if (i >= pnet_ring_count(r)) return NULL;
    const uint8_t *s = slot(r, r->tail + i);
    memcpy(len, s + LEN_AT, sizeof *len);
    return s + DATA_AT;
}

void pnet_ring_drop(pnet_ring_t *r, uint32_t k) {
    const uint32_t c = pnet_ring_count(r);
    if (k > c) k = c;
    RING_BARRIER();                       /* release: every read of these slots before freeing them */
    r->tail = r->tail + k;
}
