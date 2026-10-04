#include "board.h"
#include "bus_gate.h"   // BUS_GATE_OUT_COUNT: the status_gate OUT window
#include <stdio.h>

const board_t BOARD_PIM726 = {
    .name = "pim726",
    .sel0 = 2, .sel1 = 3, .mtr = 4, .dir = 5,
    .step = 6, .wdata = 7, .wgate = 8, .side = 9,
    .wprot = 10, .rdata = 11, .rdy = 12, .trk0 = 13, .index = 0, .chng = 1,
    .act_led = 22,
    .i2c_sda = 18, .i2c_scl = 19, .i2c_index = 1,
    // RM2 on the PIM726 (pico-sdk pimoroni_pico_plus2_w_rp2350.h):
    // WL_REG_ON 23, WL_DATA 24, WL_CS 25, WL_CLOCK 29.
    .radio_pins = {23, 24, 25, 29}, .radio_pin_count = 4,
};

const board_t *const g_board = &BOARD_PIM726;

static bool fail(char *why, size_t n, const char *msg) {
    if (n) snprintf(why, n, "%s", msg);
    return false;
}

bool board_check(const board_t *b, char *why, size_t n) {
    if (n) why[0] = '\0';
    if (b->sel1 != b->sel0 + 1 || b->mtr != b->sel0 + 2 || b->dir != b->sel0 + 3)
        return fail(why, n, "SEL0,SEL1,MTR,DIR must be consecutive (step_dir in pins, 4)");
    if (b->sel0 != 2)
        return fail(why, n, "SEL0 must be GP2 until P2 (drive_id waits on gpio 2)");
    if (b->i2c_index > 1)
        return fail(why, n, "I2C index must be 0 or 1");

    const uint8_t roles[] = {
        b->sel0, b->sel1, b->mtr, b->dir, b->step, b->wdata, b->wgate, b->side,
        b->wprot, b->rdata, b->rdy, b->trk0, b->index, b->chng,
        b->act_led, b->i2c_sda, b->i2c_scl,
    };
    const size_t nroles = sizeof roles / sizeof roles[0];
    for (size_t i = 0; i < nroles; i++) {
        for (size_t j = i + 1; j < nroles; j++)
            if (roles[i] == roles[j]) return fail(why, n, "a pin is used twice");
        for (size_t r = 0; r < b->radio_pin_count && r < BOARD_RADIO_PINS_MAX; r++)
            if (roles[i] == b->radio_pins[r]) return fail(why, n, "a role sits on a radio pin");
    }

    const uint8_t status[] = { b->wprot, b->rdy, b->trk0, b->index, b->chng };
    for (size_t i = 0; i < sizeof status; i++)
        if (status[i] >= BUS_GATE_OUT_COUNT)
            return fail(why, n, "a status pin is outside the status_gate window");
    return true;
}
