#include "bus_out.h"
#include "bus_gate.h"
#include "floppy_io.h"
#include "floppy.pio.h"
#include "hardware/sync.h"

static PIO          gate_pio;
static uint         gate_sm;
static spin_lock_t *gate_lock;
static uint32_t     shadow;

void bus_out_init(PIO pio, uint32_t initial) {
    gate_pio  = pio;
    gate_lock = spin_lock_instance((uint)spin_lock_claim_unused(true));
    shadow    = initial & bus_gate_status_mask();

    uint off = (uint)pio_add_program(pio, &status_gate_program);
    gate_sm  = (uint)pio_claim_unused_sm(pio, true);
    status_gate_program_init(pio, gate_sm, off, PIN_SEL0, BUS_GATE_OUT_COUNT,
                             bus_gate_status_mask());
    // Queued before the machine runs, so its first `pull` takes it. With an
    // empty FIFO it would pull X (zero): everything released, which is safe
    // but would briefly un-assert the boot-time TRK0/WPROT/CHNG.
    pio_sm_put(pio, gate_sm, shadow);
    pio_sm_set_enabled(pio, gate_sm, true);
}

// In RAM for the same reason dma_irq is: INDEX is set from that handler.
void __not_in_flash_func(bus_out_set)(unsigned pin, bool assert) {
    uint32_t save = spin_lock_blocking(gate_lock);
    uint32_t next = bus_gate_apply(shadow, pin, assert);
    if (next != shadow) {
        shadow = next;
        // The machine pulls every ~33 ns, so the 8-deep FIFO cannot fill
        // from here; pushing under the lock keeps the words in order.
        pio_sm_put(gate_pio, gate_sm, next);
    }
    spin_unlock(gate_lock, save);
}
