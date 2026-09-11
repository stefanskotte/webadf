#ifndef FLOPPY_IO_H
#define FLOPPY_IO_H
// ---- pin map (matches rev A PCB) --------------------------------------
// Inputs via 74LVC541A, same polarity as bus (active-low signals read 0).
#define PIN_SEL0    2
#define PIN_SEL1    3
#define PIN_MTR     4
#define PIN_DIR     5      // high = step outwards (towards track 0) per Shugart DIRC
#define PIN_STEP    6
#define PIN_WDATA   7      // PIO capture
#define PIN_WGATE   8
#define PIN_SIDE    9      // low = side 1 (upper head)
// Outputs drive BSS138 gates: GPIO HIGH  ->  bus line pulled LOW (asserted).
#define PIN_WPROT   10
#define PIN_RDATA   11     // PIO side-set
#define PIN_RDY     12
#define PIN_TRK0    13
#define PIN_INDEX   0      // north-edge pin; GP14/15 sit in antenna keepout
#define PIN_CHNG    1

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
#define PIN_ACT_LED  22    // header pin 29 -> series resistor -> LED -> GND
#define PIN_I2C_SDA  18    // header pin 24, I2C1 SDA
#define PIN_I2C_SCL  19    // header pin 25, I2C1 SCL

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
