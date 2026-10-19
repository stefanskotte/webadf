#ifndef A2B_DISCARD_H
#define A2B_DISCARD_H
// Increment 0 of plan 2026-10-19 (spec 2026-10-18 §10 step 0), WF_A2B_DISCARD TEST builds only: a TCP discard service
// the Amiga copies a file to, so the Amiga -> board bulk rate and the lwIP heap with full-size frames are measured
// before any upload code exists. Device-only (lwIP); test/run.sh excludes it.
#include <stdbool.h>
#include <stdint.h>

#define A2B_DISCARD_PORT 6801

typedef struct {
    uint32_t bytes;      // this connection's bytes so far
    uint32_t ms;         // from its first byte to its last
    uint32_t chunk_max;  // the most bytes delivered to the receive callback at once (in-order data incl. drained ooseq)
    uint32_t ooseq_max;  // the deepest out-of-order queue seen on it, bytes -- a LOWER BOUND (sampled, see .c)
    uint32_t ooseq_pbufs_max; // ...and the most pbufs it held (same lower bound)
    uint32_t conns;      // connections accepted since boot
    uint32_t mem_max;    // lwIP heap (MEM_SIZE 16 KB): the most ever in use
    uint32_t mem_err;    // ...and allocations it refused
    bool open;
} a2b_stats_t;

void a2b_discard_start(void);             // core1, after pnet_bridge_start()
void a2b_discard_stats(a2b_stats_t *out); // core1, any time (takes the lwIP lock)
#endif
