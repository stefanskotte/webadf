// ---------------------------------------------------------------------------
// DSKCHG / RDY behaviour for Amiga interface mode.
//
// Modelled on FlashFloppy's amiga interface semantics (see FlashFloppy
// src/floppy.c and the interface documentation) but written from scratch —
// FlashFloppy itself is "unlicense"/public-domain-style for reference, yet
// this file re-implements the observable behaviour rather than porting code:
//
//  * /CHNG asserted (bus low) at power-on and whenever no image is inserted.
//  * On image insert, /CHNG STAYS asserted until the host issues a STEP
//    pulse with the image in place (chgrst=step default), then deasserts.
//  * On eject, /CHNG asserts immediately.
//  * /RDY asserted while motor is on and an image is inserted (spin-up
//    delay emulated), deasserted otherwise.
//
// NO AMIGA DRIVE-ID ANSWER HERE. This file used to clock ID_3_5_DD out on
// /RDY from the SEL0 interrupt. Measured 2026-09-15 (HANDOFF §4d): Kickstart
// reads DF0's ID at power-on -- 33 selects in ~141 us, each held 1-4 us --
// and the interrupt caught 0 of them. The answer now comes from PIO
// (floppy.pio drive_id, drive_id.h; HD spec §5.4), when built with
// WF_DRIVE_ID. This file is unchanged by that: its RDY level still goes
// through bus_out_set_drive(), which forwards it to that drive's drive_id.
// ---------------------------------------------------------------------------
#include "dskchg.h"
#include "bus_out.h"
#include "floppy_io.h"
#include "pico/stdlib.h"
#include "hardware/sync.h"   // save_and_disable_interrupts

#define SPINUP_MS        150

// volatile: written from dskchg_on_step_d (the STEP edge ISR) and read from
// dskchg_poll/dskchg_motor_on_d/dskchg_image_in_d in the main loop. Safe today
// only because there is no LTO to reorder or cache a plain struct's fields
// across that boundary -- volatile makes it safe regardless. One per drive
// (bus_out.h WF_DRIVES); drive 1's pins reach the bus only once bus_out
// configured it (bus_out_set_drive ignores it until then).
static volatile struct {
    bool     image_in;
    bool     chng_asserted;
    bool     motor_on;
    absolute_time_t motor_on_t;
} st[WF_DRIVES];

// Drives dskchg_poll serves. Set once at boot on core0 (Phase 1: 1).
static volatile unsigned s_ndrives = 1;

// Through the status gate, never gpio_put: PIO owns these pads (bus_out.h),
// and the gate releases them whenever drive d is not selected.
static inline void drv(unsigned d, uint pin, bool assert) {
    bus_out_set_drive(d, pin, assert);
}

void dskchg_init(void) {
    for (unsigned d = 0; d < WF_DRIVES; d++) {
        st[d].image_in = false;
        st[d].chng_asserted = true;
        st[d].motor_on = false;
        drv(d, PIN_CHNG, true);
        drv(d, PIN_RDY,  false);
    }
}

void dskchg_set_drives(unsigned n) {
    if (n < 1) n = 1;
    if (n > WF_DRIVES) n = WF_DRIVES;
    s_ndrives = n;
}

// The flag and the pin change together, with interrupts off: the STEP ISR
// (dskchg_on_step_d) reads the flag and releases the pin. Between a flag store
// and a pin store it could release /CHNG for the old state and leave the new
// one asserted with the flag already clear -- /CHNG then stays low, and the
// Amiga believes the drive is empty until the next mount. Rare while only a
// mount called this; the write-protect re-insert (reinsert.h) calls it too.
void dskchg_image_inserted_d(unsigned d) {
    if (d >= WF_DRIVES) return;
    const uint32_t irq = save_and_disable_interrupts();
    st[d].image_in = true;
    // /CHNG remains asserted until a STEP with disk in (chgrst=step)
    st[d].chng_asserted = true;
    drv(d, PIN_CHNG, true);
    restore_interrupts(irq);
}

void dskchg_image_ejected_d(unsigned d) {
    if (d >= WF_DRIVES) return;
    const uint32_t irq = save_and_disable_interrupts();   // see dskchg_image_inserted_d
    st[d].image_in = false;
    st[d].chng_asserted = true;
    drv(d, PIN_CHNG, true);
    drv(d, PIN_RDY, false);
    restore_interrupts(irq);
}

// call from STEP edge ISR, for a step drive d acted on
void dskchg_on_step_d(unsigned d) {
    if (d >= WF_DRIVES) return;
    if (st[d].image_in && st[d].chng_asserted) {
        st[d].chng_asserted = false;
        drv(d, PIN_CHNG, false);
    }
}

// call when the MTR level latched on drive d's select falling edge changes
// (sel_mtr in floppy.pio); 'on' = motor requested (bus line low). Not on MTR's
// own edges: those also switch a second drive's motor.
void dskchg_on_motor_d(unsigned d, bool on) {
    if (d >= WF_DRIVES) return;
    if (on && !st[d].motor_on) st[d].motor_on_t = get_absolute_time();
    st[d].motor_on = on;
    if (!on) drv(d, PIN_RDY, false);
}

// periodic poll (main loop): ready once the motor has spun up with a disk in,
// for every configured drive
void dskchg_poll(void) {
    const unsigned n = s_ndrives;
    for (unsigned d = 0; d < n; d++) {
        bool rdy = st[d].motor_on && st[d].image_in &&
            absolute_time_diff_us(st[d].motor_on_t, get_absolute_time()) > SPINUP_MS * 1000;
        drv(d, PIN_RDY, rdy);
    }
}

bool dskchg_image_in_d(unsigned d)      { return d < WF_DRIVES && st[d].image_in; }
bool dskchg_motor_on_d(unsigned d)      { return d < WF_DRIVES && st[d].motor_on; }
uint32_t dskchg_motor_on_ms_d(unsigned d) {
    return d < WF_DRIVES ? to_ms_since_boot(st[d].motor_on_t) : 0;
}
