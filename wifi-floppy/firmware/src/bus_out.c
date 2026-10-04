#include "bus_out.h"
#include "bus_gate.h"
#include "floppy_io.h"
#include "floppy.pio.h"
#include "hardware/sync.h"

static PIO          gate_pio;
static uint         gate_sm;
static spin_lock_t *gate_lock;
static uint32_t     shadow;

#if WF_DRIVE_ID
#include "drive_id.h"
// RDY belongs to drive_id (floppy.pio) once bus_out_drive_id_init has run.
// The CPU's level reaches it as X, by an exec'd `set x` -- see the program's
// header for why never through its FIFO.
static PIO  id_pio;
static uint id_off;
static int  id_sm = -1;            // written under gate_lock, before the machine runs
static bool id_hd;
// floppy.pio's drive_id waits on GP2 literally: board_check() (board.c)
// refuses any board whose SEL0 is not GP2, at boot, before this file runs.

// The two loads name the ID: `mov osr, y` for HD (Y holds DRIVE_ID_HD from
// init) or `mov osr, ~null` for DD's all-ones -- drive_id_load(), which
// builds the words itself because pio_encode_mov(pio_osr, ...) emits
// `mov pindirs, ...` in pico-sdk 2.3.0 release builds (drive_id.h). A
// rewritten instruction takes effect at its next fetch, and a load runs only
// at the start of an answer (the first motor-off select after a motor-on one,
// or the 32-bit repeat), so a change never lands mid-answer -- drive_id.h's
// model, test_drive_id.c's an_id_change_waits_for_the_next_answer.
static void id_write_loads(bool hd) {
    const uint16_t load = drive_id_load(hd);
    id_pio->instr_mem[id_off + drive_id_offset_reset_load]  = load;
    id_pio->instr_mem[id_off + drive_id_offset_repeat_load] = load;
}
#endif

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
#if WF_DRIVE_ID
        const uint32_t was = shadow;
#endif
        shadow = next;
        // The machine pulls every ~33 ns, so the 8-deep FIFO cannot fill
        // from here; pushing under the lock keeps the words in order.
        pio_sm_put(gate_pio, gate_sm, next);
#if WF_DRIVE_ID
        // RDY's pad is drive_id's: give it the level too. The program puts X
        // on the pad once per motor-on select, so an assert that arrives
        // while it sits at on_selected_wait (selected, motor on) is also put
        // there at once; a release waits for the deselect's `mov pins, null`.
        // Race: if SEL0 rises between the PC read and the exec, the exec lands
        // on the way out. Within 3 PIO cycles of the rise, on_released's
        // `mov pins, null` still follows and clears it. Landing 3 or more
        // cycles after the rise (the machine then stalls on on_released's
        // `wait 0 gpio 2`) leaves RDY ASSERTED WHILE DESELECTED until the
        // next SEL0 select -- breaking SEL0 gating, which a real DF1 on the
        // same bus depends on. Practically unreachable: the PC read -> exec
        // path is ~7 instructions with IRQs off under the spinlock (~50 ns at
        // 150 MHz), against 3 PIO cycles (~200 ns at clkdiv 10).
        if (id_sm >= 0 && ((next ^ was) & (1u << PIN_RDY))) {
            const bool on = (next >> PIN_RDY) & 1u;
            pio_sm_exec(id_pio, (uint)id_sm, pio_encode_set(pio_x, on));
            if (on && pio_sm_get_pc(id_pio, (uint)id_sm) == id_off + drive_id_offset_on_selected_wait)
                pio_sm_exec(id_pio, (uint)id_sm, pio_encode_set(pio_pins, 1));
        }
#endif
    }
    spin_unlock(gate_lock, save);
}

#if WF_DRIVE_ID
void bus_out_drive_id_init(PIO pio) {
    uint off = (uint)pio_add_program(pio, &drive_id_program);
    uint sm  = (uint)pio_claim_unused_sm(pio, true);
    drive_id_program_init(pio, sm, off, PIN_RDY, PIN_MTR, DRIVE_ID_HD);
    uint32_t save = spin_lock_blocking(gate_lock);
    id_pio = pio;
    id_off = off;
    id_hd  = false;
    id_write_loads(false);                              // DD until a disk says otherwise
    pio_sm_exec(pio, sm, pio_encode_set(pio_x, (shadow >> PIN_RDY) & 1u));   // today's level first
    id_sm  = (int)sm;
    pio_sm_set_enabled(pio, sm, true);
    pio_gpio_init(pio, PIN_RDY);                        // the pad leaves pio1 last
    spin_unlock(gate_lock, save);
}

bool bus_out_drive_id_set_hd(bool hd) {
    if (id_sm < 0 || hd == id_hd) return false;
    id_hd = hd;
    id_write_loads(hd);
    return true;
}
#endif
