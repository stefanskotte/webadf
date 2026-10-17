#include "swap_phase.h"

void swap_phase_init(swap_phase_t *p) {
    p->empty = false;
    p->until_ms = 0;
}

swap_phase_action_t swap_phase_on_change(swap_phase_t *p, uint32_t now,
                                         bool was_mounted, bool now_mounted) {
    if (!now_mounted) {
        p->empty = false;
        return SWAP_PHASE_EJECT;
    }
    if (!was_mounted) {
        p->empty = false;
        return SWAP_PHASE_INSERT_NOW;
    }
    p->empty = true;
    p->until_ms = now + SWAP_EMPTY_MS;
    return SWAP_PHASE_GO_EMPTY;
}

bool swap_phase_insert_due(swap_phase_t *p, uint32_t now) {
    if (!p->empty || (int32_t)(now - p->until_ms) < 0) return false;
    p->empty = false;
    return true;
}

bool swap_phase_empty(const swap_phase_t *p) { return p->empty; }

void swap_phase_cancel(swap_phase_t *p) { p->empty = false; }
