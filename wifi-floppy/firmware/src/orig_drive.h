#ifndef ORIG_DRIVE_H
#define ORIG_DRIVE_H
// ---------------------------------------------------------------------------
// The original drive (rev C, 2026-11-19): the pure half.
//
// Rev C has a second floppy connector, J5 "EXT DRV", for the Amiga's own drive
// (hardware: wifi-floppy/hardware/rev-c/README.md, "Original drive connector").
// U8, a PCA9536 at I2C 0x41 on the OLED bus, reads DRV_DET on IO0 (low: a
// drive grounds J5 pins 1/33) and drives DRV_EN_N on IO1 (low: the drive may
// be selected; U7 then feeds GP2 with SEL2 instead of SEL0). Rev A/B boards
// have no U8: nothing answers 0x41 and the board is DF0 + DF1 as ever.
//
// One setting, Auto (default) or Off (operator, 2026-11-17). Decided ONCE, at
// power-on, before the bus is driven (operator ruling 2026-11-19: never live;
// Kickstart reads the drive IDs only at its own reset anyway). Auto with a
// drive found: the drive is DF0, the board's main drive (unit 0) answers on
// SEL1 (GP3) as DF1, its second drive (unit 1) on GP2, which now carries SEL2,
// as DF2. Otherwise: unit 0 on SEL0, unit 1 on SEL1, exactly as before.
// ---------------------------------------------------------------------------
#include <stdbool.h>
#include <stdint.h>

typedef enum { ORIG_MODE_AUTO = 0, ORIG_MODE_OFF = 1 } orig_mode_t;

// The mode as the poll and the status report spell it: "auto", "off".
const char *orig_mode_wire(orig_mode_t m);
// The wire word back to a mode. False, *out untouched: not a mode this build knows.
bool orig_mode_from_wire(const char *s, orig_mode_t *out);
// A stored byte as a mode: anything but OFF is AUTO (the default; harmless on a board without U8).
orig_mode_t orig_mode_from_byte(uint8_t b);

#define ORIG_PCA9536_ADDR 0x41
#define ORIG_REG_INPUT    0x00
#define ORIG_REG_OUTPUT   0x01
#define ORIG_REG_CONFIG   0x03    // bit set = input (the chip's power-on state: all inputs)
#define ORIG_BIT_DET      0x01u   // IO0, DRV_DET: low = a drive on J5
#define ORIG_BIT_EN_N     0x02u   // IO1, DRV_EN_N: low = drive enabled (R36 pulls it high as an input)

typedef struct {
    bool expander;   // U8 answered (a rev C board)
    bool present;    // a drive on J5 at power-on
    bool active;     // the drive is DF0: Auto and present
} orig_state_t;

// The power-on decision. `read_ok` false (no U8, a NAK, a timeout, a held bus): no drive, nothing to set.
orig_state_t orig_drive_decide(orig_mode_t mode, bool read_ok, uint8_t input_reg);

// U8's output and configuration registers for a state. Active: IO1 an output at 0 (write OUTPUT first, then
// CONFIG, so the pin never drives a 1 it was not meant to). Not active: every pin an input again, so R36 holds
// DRV_EN_N high -- U8 keeps its registers through an RP2350 reset (an OTA reboot), so "off" is always written.
uint8_t orig_drive_output_reg(bool active);
uint8_t orig_drive_config_reg(bool active);

// ---- which select line each of the board's units answers on --------------
// Set once at boot (main.c), before any state machine is given its select pin; read everywhere after.
extern volatile bool g_orig_swapped;
// Unit d's select line as an offset from PIN_SEL0: 0 = GP2 (SEL0, or SEL2 through U7), 1 = GP3 (SEL1).
unsigned orig_unit_line(unsigned d);
// A mask of asserted select LINES (bit 0 = GP2, bit 1 = GP3) as a mask of UNITS (bit d = unit d).
uint8_t orig_lines_to_units(uint8_t line_mask);
// Unit d is the Amiga's DF0 (on SEL0, whose motor the internal connector carries): only unit 0, and only
// while the original drive is not DF0.
bool orig_unit_is_df0(unsigned d);

#endif
