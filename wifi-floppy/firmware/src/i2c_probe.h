#ifndef I2C_PROBE_H
#define I2C_PROBE_H
// A one-shot I2C bus scan on PIN_I2C_SDA/PIN_I2C_SCL (floppy_io.h), logged.
//
// This is a WIRING test, not a display driver. It answers the one question
// that has to be answered first, and that nothing else can answer: is the
// panel physically connected, powered, and on the address it claims. Without
// it a blank OLED means wrong pin, wrong address, no power, dead panel or
// absent driver code, all at once.
//
// Deliberately NOT the start of an SSD1306 driver. A full-frame write at
// 400 kHz is ~1 KB of payload and on the order of 20 ms, which is twenty
// times core0's service-loop period -- so the display, when it comes, needs
// its own home and its own argument about where it runs. See HANDOFF's
// backlog entry.
#include <stdint.h>

/** Scan 0x08..0x77 and log each responder. Returns how many answered.
 *  Bounded: ~112 addresses, each NAKing immediately or timing out in 2 ms.
 *  Call once from core0's init, before the service loop. */
/** `panel_addr` (optional) receives the address of an SSD1306/SH1106 if one
 *  answered, or 0. Reported separately from the count because the panel is the
 *  one device this board has any business talking to. */
int i2c_probe_bus(uint8_t *panel_addr);

#endif
