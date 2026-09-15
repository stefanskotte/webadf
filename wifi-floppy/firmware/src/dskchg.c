// ---------------------------------------------------------------------------
// DSKCHG / RDY / drive-ID behaviour for Amiga interface mode.
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
//  * Amiga drive-ID shifter: after a motor-on edge, the first 32 /SEL
//    pulses clock the drive ID out on /RDY, MSB first, reporting
//    ID_3_5_DD = 0xFFFFFFFF. OFF by default -- see WF_DRIVE_ID below. "DF0
//    ignores this" was the assumption; Kickstart reads DF0's ID at power-on
//    and acts on it (measured 2026-09-15).
// ---------------------------------------------------------------------------
#include "dskchg.h"
#include "floppy_io.h"
#include "pico/stdlib.h"

#define AMIGA_ID_3_5_DD  0xFFFFFFFFu
#define SPINUP_MS        150

// WF_DRIVE_ID, OFF by default: never enter the ID phase, so /RDY behaves as it
// did before J1 pin 16 had a pull-up -- MTR floated low, no motor-on edge ever
// arrived, and the ID shifter never loaded. That board booted Workbench.
//
// MEASURED 2026-09-15, rev A2 board with 1k on MTR: with the shifter ON the
// Amiga reads DF0's ID once at power-on -- 33 selects in ~141 us, each held
// 1-4 us (bus sniffer) -- and never selects DF0 again: "insert DF0:". The GPIO
// interrupt caught 0 of those 33 selects and missed the 3 us motor-on pulse
// too. With it OFF, same board and Amiga: DF0 selected 2,128 times, Workbench
// boots, writes capture. Answering the ID properly needs something as fast as
// the select -- PIO, or a level held for the whole read -- not an interrupt.
#ifndef WF_DRIVE_ID
#define WF_DRIVE_ID 0
#endif

static volatile uint32_t sel_edges, motor_on_edges;

static struct {
    bool     image_in;
    bool     chng_asserted;
    bool     motor_on;
    absolute_time_t motor_on_t;
    uint32_t id_shift;
    int      id_bits_left;
} st;

static inline void drv(uint pin, bool assert) {
    gpio_put(pin, assert ? OUT_ASSERT : OUT_RELEASE);
}

void dskchg_init(void) {
    st.image_in = false;
    st.chng_asserted = true;
    st.motor_on = false;
    st.id_bits_left = 0;
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
    if (on && !st.motor_on) {
        motor_on_edges++;
        st.motor_on_t = get_absolute_time();
        if (WF_DRIVE_ID) {
            st.id_shift = AMIGA_ID_3_5_DD;   // reload ID shifter on motor-on edge
            st.id_bits_left = 32;
        }
    }
    st.motor_on = on;
    if (!on) drv(PIN_RDY, false);
}

// call on /SEL falling edge (drive selected): shifts ID when active
void dskchg_on_sel_edge(void) {
    sel_edges++;
    if (st.id_bits_left > 0) {
        bool bit = (st.id_shift & 0x80000000u) != 0;
        st.id_shift <<= 1;
        st.id_bits_left--;
        // ID bit presented on /RDY: 1 = asserted
        drv(PIN_RDY, bit);
        return;
    }
}

// periodic poll (main loop): normal ready behaviour once ID done
void dskchg_poll(void) {
    if (st.id_bits_left > 0) return;             // ID phase owns /RDY
    bool rdy = st.motor_on && st.image_in &&
        absolute_time_diff_us(st.motor_on_t, get_absolute_time()) > SPINUP_MS * 1000;
    drv(PIN_RDY, rdy);
}

bool dskchg_image_in(void) { return st.image_in; }

void dskchg_id_stats(uint32_t *sel, uint32_t *motor_on, int *id_bits_left) {
    *sel = sel_edges;
    *motor_on = motor_on_edges;
    *id_bits_left = st.id_bits_left;
}
