#ifndef SSD1306_H
#define SSD1306_H
// The SSD1306 transport: init, a bounded per-page write, and the bring-up
// self-test that was here first. The LAYOUT lives in display.c, which is pure
// and host-tested; this file is only how bytes reach the glass.
#include <stdbool.h>
#include <stdint.h>
#include "display_layout.h"

/** Configure the panel and clear it. Leaves i2c1 at 400 kHz and the glass
 *  all-zero, which is the state display.c's shadow buffer assumes. */
bool ssd1306_init(uint8_t addr, panel_t panel);

/** Reconfigure an already-initialised panel for `panel` WITHOUT clearing it:
 *  the init command sequence only. For a runtime panel-type switch, where the
 *  caller's display_set_panel resends every byte anyway and a synchronous
 *  clear would block core0 for 12-25 ms (see ssd1306.c). Boot uses
 *  ssd1306_init. */
bool ssd1306_reinit(uint8_t addr, panel_t panel);

/** Write `n` bytes into one page starting at column `col`. Each call is a
 *  complete, independent transfer -- see the window comment in ssd1306.c.
 *  THE cost that matters: (n + 8) bytes at 400 kHz, ~9 bits each, which is
 *  what bounds how long core0's 1 ms service loop is blocked per update. */
bool ssd1306_blit(uint8_t addr, panel_t panel, int page, int col, const uint8_t *bytes, int n);

/** Blank the panel. */
bool ssd1306_clear(uint8_t addr, panel_t panel);

/** Initialise and draw a recognisable test pattern. Returns false if any
 *  transfer failed. Bounded: every write has a timeout, so a clamped bus
 *  costs milliseconds rather than the boot. */
bool ssd1306_selftest(uint8_t addr, panel_t panel);

#endif
