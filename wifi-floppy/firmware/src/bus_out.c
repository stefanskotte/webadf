#include "bus_out.h"
#include "bus_gate.h"
#include "floppy_io.h"
#include "floppy.pio.h"
#include "hardware/sync.h"

static PIO          gate_pio;
static spin_lock_t *gate_lock;
static unsigned     n_drives;                 // configured: 1 (DF0) in Phase 1
static uint         gate_sm[WF_DRIVES];
static uint32_t     shadow[WF_DRIVES];

// Drive d's select line: SEL0 for DF0, SEL1 for DF1. A function, not a table:
// the pins are read from the board description at run time.
static uint sel_pin_of(unsigned d) { return d == 0 ? PIN_SEL0 : PIN_SEL1; }

#if WF_DRIVE_ID
#include "drive_id.h"
// RDY belongs to drive_id (floppy.pio) once bus_out_drive_id_init has run.
// The CPU's level reaches it as X, by an exec'd `set x` -- see the program's
// header for why never through its FIFO.
//
// One program copy, one state machine per drive. The ID lives in each SM's
// Y, which both loads (`mov osr, y`) read; nothing writes instr_mem after
// pio_add_program (test/run.sh fails on an instr_mem index here), because a
// rewritten load would change every drive's answer at once.
static PIO             id_pio;
static uint            id_off;
_Static_assert(WF_DRIVES == 2, "id_sm's initializer names two drives");
static int             id_sm[WF_DRIVES] = { -1, -1 };   // written under gate_lock, before the machine runs
static drive_id_kind_t id_kind[WF_DRIVES];

// Y := drive_id_word(k) on a RUNNING machine, touching only Y and the ISR
// (drive_id_y_sequence, drive_id.h, which says why that is safe at any PC
// and cites the datasheet's exec semantics). Y changes at the last exec
// only, so a load between two execs takes the old ID or the new one, never a
// mix; the change shows from the next load -- the first motor-off select
// after a motor-on one, or the 32-bit repeat -- never mid-answer (drive_id.h's
// model, test_drive_id.c's an_id_change_waits_for_the_next_answer).
//
// No spinlock: bus_out_set_drive's execs on the same machine (`set x`,
// `set pins`) touch neither Y nor the ISR, so interleaving with them is
// harmless; the sequence itself runs on core0 only. HD's is 67 register
// writes, about 0.5 us with interrupts on.
static void id_write_y(unsigned d, drive_id_kind_t k) {
    static uint16_t seq[DRIVE_ID_Y_SEQ_MAX];   // static: core0 only, off the stack
    const unsigned n = drive_id_y_sequence(k, seq);
    for (unsigned i = 0; i < n; i++)
        pio_sm_exec(id_pio, (uint)id_sm[d], seq[i]);
}
#endif

void bus_out_init(PIO pio, unsigned ndrives, const uint32_t initial[]) {
    if (ndrives > WF_DRIVES) ndrives = WF_DRIVES;
    gate_pio  = pio;
    gate_lock = spin_lock_instance((uint)spin_lock_claim_unused(true));

    uint off = (uint)pio_add_program(pio, &status_gate_program);   // one copy, shared
    for (unsigned d = 0; d < ndrives; d++) {
        shadow[d]  = initial[d] & bus_gate_status_mask();
        gate_sm[d] = (uint)pio_claim_unused_sm(pio, true);
        // Hands the status pads to this PIO on every call; the second call
        // is the same PIO and the same pads, so they change hands only once.
        status_gate_program_init(pio, gate_sm[d], off, sel_pin_of(d), BUS_GATE_OUT_COUNT,
                                 bus_gate_status_mask());
        // Queued before the machine runs, so its first `pull` takes it. With an
        // empty FIFO it would pull X (zero): everything released, which is safe
        // but would briefly un-assert the boot-time TRK0/WPROT/CHNG.
        pio_sm_put(pio, gate_sm[d], shadow[d]);
    }
    n_drives = ndrives;
    for (unsigned d = 0; d < ndrives; d++) pio_sm_set_enabled(pio, gate_sm[d], true);
}

// In RAM for the same reason dma_irq is: INDEX is set from that handler.
void __not_in_flash_func(bus_out_set_drive)(unsigned d, unsigned pin, bool assert) {
    if (d >= n_drives) return;
    uint32_t save = spin_lock_blocking(gate_lock);
    uint32_t next = bus_gate_apply(shadow[d], pin, assert);
    if (next != shadow[d]) {
#if WF_DRIVE_ID
        const uint32_t was = shadow[d];
#endif
        shadow[d] = next;
        // The machine pulls every ~33 ns, so the 8-deep FIFO cannot fill
        // from here; pushing under the lock keeps the words in order.
        pio_sm_put(gate_pio, gate_sm[d], next);
#if WF_DRIVE_ID
        // RDY's pad is drive_id's: give it the level too. The program puts X
        // on the pad once per motor-on select, so an assert that arrives
        // while it sits at on_selected_wait (selected, motor on) is also put
        // there at once; a release waits for the deselect's `mov pins, null`.
        // Race: if the select rises between the PC read and the exec, the
        // exec lands on the way out. Within 3 PIO cycles of the rise,
        // on_released's `mov pins, null` still follows and clears it. Landing
        // 3 or more cycles after the rise (the machine then stalls on
        // on_released's `wait 0 pin 0`) leaves RDY ASSERTED WHILE DESELECTED
        // until the next select -- breaking select gating, which a real DF1
        // on the same bus depends on. Practically unreachable: the PC read ->
        // exec path is ~7 instructions with IRQs off under the spinlock (~50
        // ns at 150 MHz), against 3 PIO cycles (~200 ns at clkdiv 10).
        const int sm = id_sm[d];
        if (sm >= 0 && ((next ^ was) & (1u << PIN_RDY))) {
            const bool on = (next >> PIN_RDY) & 1u;
            pio_sm_exec(id_pio, (uint)sm, pio_encode_set(pio_x, on));
            if (on && pio_sm_get_pc(id_pio, (uint)sm) == id_off + drive_id_offset_on_selected_wait)
                pio_sm_exec(id_pio, (uint)sm, pio_encode_set(pio_pins, 1));
        }
#endif
    }
    spin_unlock(gate_lock, save);
}

void __not_in_flash_func(bus_out_set)(unsigned pin, bool assert) {
    bus_out_set_drive(0, pin, assert);
}

#if WF_DRIVE_ID
void bus_out_drive_id_init(PIO pio, unsigned ndrives) {
    if (ndrives > n_drives) ndrives = n_drives;     // a drive_id needs its status gate
    uint off = (uint)pio_add_program(pio, &drive_id_program);   // one copy, shared
    for (unsigned d = 0; d < ndrives; d++) {
        uint sm = (uint)pio_claim_unused_sm(pio, true);
        // DD until a disk says otherwise: Y = all ones, loaded by the init's
        // `pull` before the machine runs.
        drive_id_program_init(pio, sm, off, sel_pin_of(d), PIN_RDY, PIN_MTR, DRIVE_ID_DD);
        uint32_t save = spin_lock_blocking(gate_lock);
        id_pio     = pio;
        id_off     = off;
        id_kind[d] = DRIVE_ID_KIND_DD;
        pio_sm_exec(pio, sm, pio_encode_set(pio_x, (shadow[d] >> PIN_RDY) & 1u));   // today's level first
        id_sm[d]   = (int)sm;
        pio_sm_set_enabled(pio, sm, true);
        spin_unlock(gate_lock, save);
    }
    pio_gpio_init(pio, PIN_RDY);                        // the pad leaves pio1 last
}

bool bus_out_drive_id_set(unsigned d, drive_id_kind_t k) {
    if (d >= WF_DRIVES || id_sm[d] < 0 || k == id_kind[d]) return false;
    id_kind[d] = k;
    id_write_y(d, k);
    return true;
}

bool bus_out_drive_id_set_hd(bool hd) {
    return bus_out_drive_id_set(0, hd ? DRIVE_ID_KIND_HD : DRIVE_ID_KIND_DD);
}
#endif
