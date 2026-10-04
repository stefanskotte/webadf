#ifndef FLOPPY_IO_H
#define FLOPPY_IO_H
// ---- pin map (matches rev A PCB) --------------------------------------
// Inputs via 74LVC541A, same polarity as bus (active-low signals read 0).
#include "board.h"
// The pin map lives in board.c (spec 2026-10-04 §5); these names stay so the
// ~60 call sites and test/run.sh's gpio_put guard read as before. They are
// runtime reads of *g_board now: never use one where C needs a constant.
#define PIN_SEL0    (g_board->sel0)
#define PIN_SEL1    (g_board->sel1)
#define PIN_MTR     (g_board->mtr)
#define PIN_DIR     (g_board->dir)      // high = step outwards (towards track 0) per Shugart DIRC
#define PIN_STEP    (g_board->step)
#define PIN_WDATA   (g_board->wdata)    // PIO capture
#define PIN_WGATE   (g_board->wgate)
#define PIN_SIDE    (g_board->side)     // low = side 1 (upper head)
// Outputs drive BSS138 gates: GPIO HIGH  ->  bus line pulled LOW (asserted).
#define PIN_WPROT   (g_board->wprot)
#define PIN_RDATA   (g_board->rdata)    // PIO side-set
#define PIN_RDY     (g_board->rdy)
#define PIN_TRK0    (g_board->trk0)
#define PIN_INDEX   (g_board->index)    // north-edge pin; GP14/15 sit in antenna keepout
#define PIN_CHNG    (g_board->chng)

#define OUT_ASSERT   1     // remember: inverted driver
#define OUT_RELEASE  0

// ---- aux pins (bring-up only, wired by hand) ---------------------------
// NOT on the PCB: these are bare, unrouted through-holes in U1's footprint,
// reachable with Dupont leads on the header pins that pass through the top.
// Chosen, and the reasoning matters if they are ever moved:
//
//   * GP14..GP17 (header pins 19-22) are the ONLY other free GPIOs and are
//     all unusable. The antenna keepout spans BOTH header rows, so the east
//     row mirrors the west: pins 21/22 land at the same y as 20/19. The
//     keepout allows pads but forbids tracks and vias, so nothing can be
//     routed to them -- and the same reason (it is the antenna end) makes
//     them a bad place to hang flying leads even when routing is not the
//     question.
//   * I2C1, not I2C0, although GP20/21 would mux correctly for I2C0. I2C0's
//     other pins are GP4/GP5 -- this board's MTR and DIR, and also where the
//     PIM726's Qw/ST connector is hardwired. A driver that ever calls
//     i2c_init(i2c0, ...) with default pins would reconfigure two live
//     floppy inputs; on I2C1 that mistake is harmless.
//   * GP22 for the LED rather than GP26/27/28, which are the only
//     ADC-capable pins left and are worth keeping for sensing the +5V/+12V
//     rails or VSYS later.
//
// THE LED IS NOT INVERTED. Every other output here drives a BSS138 gate,
// where GPIO high pulls the bus line LOW (OUT_ASSERT above). This one is a
// direct drive: high = lit. Do not reach for OUT_ASSERT.
//
// The panel must be powered from 3V3 (header pin 36), never VSYS/VBUS: most
// SSD1306 modules pull SDA/SCL up to their own VCC, and RP2350 GPIOs are not
// 5V tolerant.
// Header pin 29 -> series resistor -> LED -> GND. VERIFIED WORKING on a rev A2
// board 2026-09-12 -- but wired on the bench with NO resistor, which is out of
// spec even though it lights: see led_init(), which drops the pad to its
// weakest drive to compensate. Rev B is unfabricated; put the resistor in.
#define PIN_ACT_LED  (g_board->act_led)
#define PIN_I2C_SDA  (g_board->i2c_sda)    // header pin 24 on the PIM726, I2C1 SDA
#define PIN_I2C_SCL  (g_board->i2c_scl)    // header pin 25 on the PIM726, I2C1 SCL

#define NUM_CYL      80
#define NUM_SIDES    2
#define RPM          300
#define REV_US       200000            // 200 ms / rev
#define BITCELL_NS   2000              // Amiga DD MFM
// The DD raw MFM track-size ceiling lives in psram_image.h as
// TRACK_MAX_BYTES, not here: it has to be the same constant the PSRAM slot
// and the SRAM staging buffer are both sized against (see psram_image.h for
// why two different values here was a live overflow).
#define INDEX_PULSE_US 2000
#endif
