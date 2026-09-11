#ifndef SSD1306_H
#define SSD1306_H
// One-shot panel self-test. See ssd1306.c for why this is not a driver.
#include <stdbool.h>
#include <stdint.h>

/** Initialise the panel at `addr` and draw a recognisable test pattern.
 *  Returns false if any transfer failed. Bounded: every write has a timeout,
 *  so a clamped bus costs milliseconds rather than the boot. */
bool ssd1306_selftest(uint8_t addr);

#endif
