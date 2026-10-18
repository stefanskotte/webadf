#ifndef OLED_CMDS_H
#define OLED_CMDS_H
// The SSD1306 / SH1106 command bytes, as pure C (no SDK): which commands
// configure a panel, and the two that turn it 180 degrees (1.17.0). ssd1306.c
// sends them; test_oled_rotation.c judges them byte for byte and models the
// glass they produce.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "display_layout.h"

#define OLED_INIT_MAX 32   // the longest sequence is 25 bytes

/** The configuration sequence for a controller (`sh1106` or SSD1306) driving
 *  `panel`, turned `rot` (LAYOUT_ROT_0 / LAYOUT_ROT_180; anything else is
 *  upright), into `out`. Returns its length, or -1 if `cap` is too small.
 *  Unrotated it is exactly what 1.16 sent. */
int oled_init_cmds(bool sh1106, panel_t panel, uint8_t rot, uint8_t *out, size_t cap);

/** Segment remap then COM scan direction for `rot`: 0xA1 0xC8 upright (how
 *  these modules are wired to read), 0xA0 0xC0 turned 180 degrees. The same
 *  two commands on both controllers. */
void oled_rotation_cmds(uint8_t rot, uint8_t out[2]);

/** How many bytes the command starting with `op` takes, operands included:
 *  2 for the one-operand commands these sequences use, else 1. */
int oled_cmd_len(uint8_t op);

#endif
