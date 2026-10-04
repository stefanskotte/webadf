#ifndef BOARD_H
#define BOARD_H
// Which module this firmware is running on, and where its signals are
// (spec 2026-10-04-unified-firmware-design.md §5). P1 has ONE board, the
// PIM726 (Pimoroni Pico Plus 2 W), and g_board is fixed to it at compile
// time; P2 chooses at boot from the RP2350 package. Host-portable: no SDK
// types, so bus_gate.c and its tests can read pins through it.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define BOARD_RADIO_PINS_MAX 8

typedef struct board {
    const char *name;               // "pim726"; logged at boot
    // Floppy inputs (via 74LVC541A). SEL0..DIR MUST be consecutive in this
    // order: floppy.pio's step_dir reads them as one `in pins, 4`.
    uint8_t sel0, sel1, mtr, dir;
    uint8_t step, wdata, wgate, side;
    // Floppy outputs (via BSS138: GPIO high asserts the bus line).
    uint8_t wprot, rdata, rdy, trk0, index, chng;
    // Aux.
    uint8_t act_led;
    uint8_t i2c_sda, i2c_scl;
    uint8_t i2c_index;              // 0 = i2c0, 1 = i2c1 (board_hw.h maps it)
    // Pins the module's radio owns. No role may land on one.
    uint8_t radio_pins[BOARD_RADIO_PINS_MAX];
    uint8_t radio_pin_count;
} board_t;

extern const board_t BOARD_PIM726;

// The board this firmware runs on. A const pointer initialised at compile
// time, so it is valid in every ISR and in host tests with no init call.
extern const board_t *const g_board;

// True when `b` satisfies everything the firmware relies on. On false,
// `why` (always NUL-terminated) says which rule broke. Used by the host tests
// and once at boot (main.c), where a failure stops the board before any
// pin is driven.
bool board_check(const board_t *b, char *why, size_t why_len);

#endif
