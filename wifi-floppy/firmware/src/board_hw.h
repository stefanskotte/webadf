#ifndef BOARD_HW_H
#define BOARD_HW_H
// Device-only companion to board.h: SDK types live here, not there, so
// board.h stays host-portable.
#include "board.h"
#include "hardware/i2c.h"

static inline i2c_inst_t *board_i2c(void) {
    return g_board->i2c_index == 1 ? i2c1 : i2c0;
}
#endif
