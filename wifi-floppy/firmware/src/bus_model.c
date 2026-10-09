// Host-only model of floppy.pio's status_gate and flux_out, one SM per drive
// on one PIO. See bus_model.h. Pin writes of one cycle are applied in SM order
// 0..n-1, so the highest-numbered SM's write wins (RP2350 datasheet §11.2.6);
// a pin no SM writes in a cycle keeps its level.
#include "bus_model.h"
#include <string.h>

void bus_model_init(bus_model_t *m, unsigned n) { memset(m, 0, sizeof *m); m->n = n; }
void bus_model_set_word(bus_model_t *m, unsigned d, uint32_t w) { m->word[d] = w; }
void bus_model_select(bus_model_t *m, uint32_t s) { m->sel = s; }
uint32_t bus_model_pads(const bus_model_t *m) { return m->pads; }
unsigned bus_model_released_writes(const bus_model_t *m, unsigned d) { return m->released_writes[d]; }
bool bus_model_rdata(const bus_model_t *m) { return m->rdata; }
void bus_model_feed_bits(bus_model_t *m, unsigned d, uint32_t w) { m->fifo[d] = w; m->fifo_full[d] = true; }

// status_gate, one loop pass (cycle-insensitive at this level):
//   top:      pull noblock; mov x, osr      (X = this drive's word)
//             jmp pin, released             (our select high)
//             mov pins, x; set y, 1; jmp top
//   released: jmp !y, top                   (already released: NO write)
//             mov pins, null; set y, 0      (once, on the deselect edge)
static void gate_pass(bus_model_t *m, unsigned d, bool *wrote, uint32_t *val) {
    const bool selected = (m->sel >> d) & 1u;
    *wrote = false;
    if (selected) { *wrote = true; *val = m->word[d]; m->was_sel[d] = true; return; }  // mov pins, x
    if (!m->was_sel[d]) return;                       // jmp !y, top: nothing written
    *wrote = true; *val = 0; m->was_sel[d] = false;   // mov pins, null -- once
    m->released_writes[d]++;
}

// flux_out, one PIO cycle. Returns true and sets *level iff this SM writes
// RDATA (side-set) this cycle. pc = the instruction's index in the program:
//   0 out x, 1 [1]        2 cycles, no side-set (a stall here writes nothing)
//   1 jmp !x, skip5       1   (folded into pc 0: its cycle is in the delay)
//   2 jmp pin, skip4      1
//   3 nop side 1 [2]      3   the pulse
//   4 jmp top side 0      1   the pulsing SM alone ends it
//   5 skip5: nop          1
//   6 skip4: nop [3]      4
// Every path: 1 selected 3+1+3+1, 1 deselected 3+1+4, 0 3+1+4 = 8 cycles.
static bool flux_cycle(bus_model_t *m, unsigned d, bool *level) {
    if (m->delay[d]) { m->delay[d]--; return false; }
    const bool selected = (m->sel >> d) & 1u;
    switch (m->pc[d]) {
    case 0:                                            // out x, 1 [1]   (no side-set)
        if (m->osr_left[d] == 0) {
            if (!m->fifo_full[d]) return false;        // autopull stall: writes nothing
            m->osr[d] = m->fifo[d]; m->osr_left[d] = 32; m->fifo_full[d] = false;
        }
        m->pc[d] = ((m->osr[d] >> 31) & 1u) ? 2 : 5;   // folds jmp !x into the next pc
        m->osr[d] <<= 1; m->osr_left[d]--; m->delay[d] = 2;   // [1] + the jmp !x cycle
        return false;
    case 2: m->pc[d] = selected ? 3 : 6; return false;          // jmp pin, skip4
    case 3: m->pc[d] = 4; m->delay[d] = 2; *level = true; return true;   // nop side 1 [2]
    case 4: m->pc[d] = 0; *level = false; return true;          // jmp top side 0
    case 5: m->pc[d] = 6; return false;                         // skip5: nop
    case 6: m->pc[d] = 0; m->delay[d] = 3; return false;        // skip4: nop [3]
    }
    return false;
}

void bus_model_run(bus_model_t *m, unsigned cycles) {
    for (unsigned c = 0; c < cycles; c++) {
        for (unsigned d = 0; d < m->n; d++) {          // ascending: the last (highest) wins
            bool w; uint32_t v = 0;
            gate_pass(m, d, &w, &v);
            if (w) m->pads = v;
        }
    }
}

unsigned bus_model_run_count_rdata_pulses(bus_model_t *m, unsigned cycles) {
    unsigned pulses = 0;
    for (unsigned c = 0; c < cycles; c++) {
        const bool before = m->rdata;
        for (unsigned d = 0; d < m->n; d++) {          // ascending: the last (highest) wins
            bool lvl = false;
            if (flux_cycle(m, d, &lvl)) m->rdata = lvl;
        }
        if (!before && m->rdata) pulses++;
    }
    return pulses;
}
