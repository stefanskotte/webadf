#ifndef SSD1306_H
#define SSD1306_H
// The SSD1306 / SH1106 transport (the controller is detected at init): init, a bounded per-page write, and the bring-up
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

/** Turn the panel LAYOUT_ROT_0 or LAYOUT_ROT_180 (anything else: upright),
 *  in the controller, and keep it for later re-inits. The caller then resends
 *  every byte (display_resend_all): the SSD1306 remaps only new writes. */
bool ssd1306_set_rotation(uint8_t addr, uint8_t rot);

/** The rotation last set (LAYOUT_ROT_0 until ssd1306_set_rotation). */
uint8_t ssd1306_rotation(void);

/** Write `n` bytes into one page starting at column `col`. Each call is a
 *  complete, independent transfer -- see the page-addressing comment in
 *  ssd1306.c. THE cost that matters: (n + 5) bytes at 400 kHz, ~9 bits each, which is
 *  what bounds how long core0's 1 ms service loop is blocked per update. */
bool ssd1306_blit(uint8_t addr, panel_t panel, int page, int col, const uint8_t *bytes, int n);

/** Blank the panel. */
bool ssd1306_clear(uint8_t addr, panel_t panel);

/** Initialise and draw a recognisable test pattern. Returns false if any
 *  transfer failed. Bounded: every write has a timeout, so a clamped bus
 *  costs milliseconds rather than the boot. */
bool ssd1306_selftest(uint8_t addr, panel_t panel);

#endif
