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
// NO AMIGA DRIVE-ID ANSWER, deliberately. This file used to clock
// ID_3_5_DD out on /RDY from the SEL0 interrupt, on the assumption that DF0's
// ID is ignored. Measured 2026-09-15 (HANDOFF §4d): Kickstart reads DF0's ID
// at power-on -- 33 selects in ~141 us, each held 1-4 us -- the interrupt
// caught 0 of them, and the Amiga then never selected DF0 again. With no ID
// answer, /RDY released through the read, it boots, reads and writes. Answering
// it would need something as fast as the select; nothing measured needs it.
// ---------------------------------------------------------------------------
#include "dskchg.h"
#include "floppy_io.h"
#include "pico/stdlib.h"

#define SPINUP_MS        150

static struct {
    bool     image_in;
    bool     chng_asserted;
    bool     motor_on;
    absolute_time_t motor_on_t;
} st;

static inline void drv(uint pin, bool assert) {
    gpio_put(pin, assert ? OUT_ASSERT : OUT_RELEASE);
}

void dskchg_init(void) {
    st.image_in = false;
    st.chng_asserted = true;
    st.motor_on = false;
    drv(PIN_CHNG, true);
    drv(PIN_RDY,  false);
}

void dskchg_image_inserted(void) {
    st.image_in = true;
    // /CHNG remains asserted until a STEP with disk in (chgrst=step)
    st.chng_asserted = true;
    drv(PIN_CHNG, true);
}

void dskchg_image_ejected(void) {
    st.image_in = false;
    st.chng_asserted = true;
    drv(PIN_CHNG, true);
    drv(PIN_RDY, false);
}

// call from STEP edge ISR
void dskchg_on_step(void) {
    if (st.image_in && st.chng_asserted) {
        st.chng_asserted = false;
        drv(PIN_CHNG, false);
    }
}

// call on MTR line change; 'on' = motor requested (bus line low)
void dskchg_on_motor(bool on) {
    if (on && !st.motor_on) st.motor_on_t = get_absolute_time();
    st.motor_on = on;
    if (!on) drv(PIN_RDY, false);
}

// periodic poll (main loop): ready once the motor has spun up with a disk in
void dskchg_poll(void) {
    bool rdy = st.motor_on && st.image_in &&
        absolute_time_diff_us(st.motor_on_t, get_absolute_time()) > SPINUP_MS * 1000;
    drv(PIN_RDY, rdy);
}

bool dskchg_image_in(void) { return st.image_in; }
