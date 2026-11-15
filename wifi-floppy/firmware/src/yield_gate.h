#ifndef YIELD_GATE_H
#define YIELD_GATE_H
// When a request's wait may give way to the setup page opened on request (transport_tls.c tls_set_yield; review of
// 7f3de257). After it gave way once, it does not again for `quiet_ms`: should the event not be handled at once, a
// request per pass would otherwise give way on its first wait -- a new pcb, a SYN and a close each time, a hot spin.
// Pure, header-only: test/test_wifi_ctl.c. Wrap-safe on the ms clock.
#include <stdbool.h>
#include <stdint.h>

typedef struct {
    bool     quiet;
    uint32_t until;
} yield_gate_t;

// `want`: the event is there now. True: give way (and start the quiet period).
static inline bool yield_gate_try(yield_gate_t *g, uint32_t now, bool want, uint32_t quiet_ms) {
    if (g->quiet && (int32_t)(now - g->until) < 0) return false;
    g->quiet = false;
    if (!want) return false;
    g->quiet = true;
    g->until = now + quiet_ms;
    return true;
}

#endif
