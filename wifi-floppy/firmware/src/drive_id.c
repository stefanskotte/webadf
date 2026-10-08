#include "drive_id.h"

// Each function is one path through floppy.pio's drive_id program; the
// comments name the instructions they stand for. Host-test-only: the device
// build does not compile this file (CMakeLists.txt) -- on the board the PIO
// program IS the behaviour, and this is its reference.

void drive_id_model_init(drive_id_model_t *m, uint32_t id) {
    m->id = id;
    m->shifter = 0;
    m->bits_left = 0;
    m->motor_on = true;      // the program starts at on_released: power-up is "motor was on"
    m->selected = false;
    m->level = false;        // X = 0
    m->rdy = false;
}

void drive_id_model_set_id(drive_id_model_t *m, uint32_t id) {
    m->id = id;              // Y written (drive_id_y_sequence); both loads read it
}

void drive_id_model_select(drive_id_model_t *m, bool mtr_on) {
    m->selected = true;
    if (mtr_on) {                         // jmp pin falls through (MTR low): on_selected
        m->motor_on = true;
        m->rdy = m->level;                // mov pins, x
        return;
    }
    if (m->motor_on) {                    // jmp pin, reset_load: mov osr, <the ID>
        m->motor_on = false;
        m->shifter = m->id;
        m->bits_left = 32;                // ...and falls straight into id_bit
    }
    m->rdy = (m->shifter >> 31) != 0;     // id_bit: out pins, 1
    m->shifter <<= 1;
    m->bits_left--;
}

void drive_id_model_deselect(drive_id_model_t *m) {
    m->selected = false;
    m->rdy = false;                       // mov pins, null
    if (!m->motor_on && m->bits_left == 0) {   // jmp !osre falls through: repeat_load
        m->shifter = m->id;
        m->bits_left = 32;
    }
}

void drive_id_model_level(drive_id_model_t *m, bool assert) {
    m->level = assert;                    // exec'd `set x, level` (bus_out.c)
    // An assert while selected with the motor on also execs `set pins, 1`
    // (bus_out.c, at on_selected_wait); a release waits for the deselect's
    // `mov pins, null`.
    if (assert && m->selected && m->motor_on) m->rdy = true;
}

bool drive_id_model_rdy_gpio(const drive_id_model_t *m) {
    return m->rdy;
}
