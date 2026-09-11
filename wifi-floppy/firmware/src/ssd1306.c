#include "ssd1306.h"
#include "floppy_io.h"
#include "wf_log.h"
#include "pico/stdlib.h"
#include "hardware/i2c.h"

/**
 * A SELF-TEST for an SSD1306 panel, not a display driver.
 *
 * i2c_probe_bus() proves a device acknowledges its address. That is worth
 * having and it is not the same as proving the wiring carries DATA: an ACK
 * survives a panel whose data line works one way, a dead controller that still
 * decodes its address, and a display with no charge pump. Drawing something
 * visible is the only test that covers the path end to end.
 *
 * WHAT THIS IS NOT. The display increment proper -- status lines, a font,
 * anything redrawn as state changes -- is still a backlog item, and the reason
 * is in its entry: a full 1 KB frame at 400 kHz takes on the order of 20 ms,
 * twenty times core0's service-loop period, so a real driver needs its own
 * argument about where it runs. This writes ONE frame, ONCE, during init
 * before the floppy side is live, which is the same latitude led_selftest()
 * takes and for the same reason.
 *
 * Every transfer is bounded. The bus was clamped low for a long stretch during
 * bring-up on 2026-09-11 (a panel wired with VCC and GND reversed pulls the
 * lines down through its protection diodes), and nothing here may turn that
 * into a board that will not boot.
 */

#define I2C_TIMEOUT_US 5000
#define WIDTH  128
/*
 * 128x32, NOT 128x64. Confirmed by the operator 2026-09-11 after a long
 * detour: the panel is half the height this code first assumed, and all three
 * places that assumption was written down have to agree or the display lies
 * about which of them is wrong.
 *
 * A 64-row init on a 32-row panel does not fail, which is what made it so
 * expensive to find. The controller happily scans 64 COM lines onto glass that
 * has 32, so pages 4..7 land nowhere and the alternating COM pin mapping
 * interleaves the rows that do land. The symptom is a panel that shows SOME of
 * what you drew -- which reads as a damaged display, a bad init, or a bezel,
 * and it cost two panels' worth of suspicion and an ENTIRE-DISPLAY-ON probe
 * before the operator supplied the one fact none of the tests could: the
 * number printed on the part.
 */
#define HEIGHT 32
#define PAGES  (HEIGHT / 8)

static bool cmd(uint8_t addr, const uint8_t *bytes, size_t n) {
  // Control byte 0x00 says "everything after this is a command".
  uint8_t buf[8];
  if (n + 1 > sizeof buf) return false;
  buf[0] = 0x00;
  for (size_t i = 0; i < n; i++) buf[i + 1] = bytes[i];
  return i2c_write_timeout_us(i2c1, addr, buf, n + 1, false, I2C_TIMEOUT_US) >= 0;
}

bool ssd1306_selftest(uint8_t addr) {
  static const uint8_t init[] = {
    0xAE,              /* display off while it is reconfigured           */
    0xD5, 0x80,        /* clock divide / oscillator frequency            */
    0xA8, HEIGHT - 1,  /* multiplex ratio: one less than the row count   */
    0xD3, 0x00,        /* no vertical offset                             */
    0x40,              /* start line 0                                   */
    0x8D, 0x14,        /* CHARGE PUMP ON -- without this a correctly     */
                       /* wired panel stays black and looks unwired      */
    0x20, 0x00,        /* horizontal addressing: RAM auto-advances       */
    0xA1,              /* segment remap, so column 0 is on the left      */
    0xC8,              /* COM scan descending, so row 0 is at the top    */
    0xDA, 0x02,        /* SEQUENTIAL COM pins, the 128x32 layout. 0x12   */
                       /* (alternating) is the 128x64 value and is the   */
                       /* half of this bug that survives fixing 0xA8     */
    0x81, 0xCF,        /* contrast                                       */
    0xD9, 0xF1, 0xDB, 0x40,
    0xA4,              /* show RAM, not an all-on test pattern -- an
                          all-on display would "pass" this test without
                          a single byte of ours reaching the panel      */
    0xA6,              /* normal, not inverted                           */
    0xAF,              /* display on                                     */
  };
  for (size_t i = 0; i < sizeof init; ) {
    // Send one command plus its operands at a time; 0xD5/0xA8/0xD3/0x8D/0x20/
    // 0xDA/0x81/0xD9/0xDB each take one, the rest take none.
    size_t n = 1;
    switch (init[i]) {
      case 0xD5: case 0xA8: case 0xD3: case 0x8D:
      case 0x20: case 0xDA: case 0x81: case 0xD9: case 0xDB: n = 2; break;
      default: n = 1; break;
    }
    if (!cmd(addr, &init[i], n)) return false;
    i += n;
  }

  // Address the whole panel: columns 0..127, pages 0..7.
  static const uint8_t window[] = { 0x21, 0x00, WIDTH - 1, 0x22, 0x00, PAGES - 1 };
  if (!cmd(addr, &window[0], 3)) return false;
  if (!cmd(addr, &window[3], 3)) return false;

  /*
   * A FRAME AND AN X, because counting failed three times.
   *
   * Every pattern before this one asked the operator to count lines, and every
   * answer was ambiguous -- "bottom bar missing", "shifted down one row", "8
   * blocks", "only one line", "3 lines" where 5 were drawn. That last one is
   * the clearest evidence the METHOD is wrong rather than the reading: on a
   * 0.91" panel two lines one row apart are ~0.4 mm apart, so a pair reads as
   * one thicker mark, and "3" is exactly what a CORRECT 5-line ruler looks
   * like. A test whose pass and fail look alike is not a test.
   *
   * This one is answerable by eye, with no counting at all:
   *
   *   a 1px FRAME on all four edges -- its four sides are the four extremes of
   *     the addressable area, so "is the box closed and flush to the glass"
   *     settles the panel's extent in one glance
   *   an X corner to corner -- two unbroken strokes crossing in the middle.
   *     A diagonal is the pattern interleaved COM pins cannot fake: wrong COM
   *     mapping reorders rows, which turns a straight stroke into a staircase
   *     of disconnected segments while leaving a frame looking perfect.
   *
   * Frame closed AND strokes clean -> geometry is right, and the display is
   * ready for a driver. Anything else is now specific enough to act on.
   */
  uint8_t fb[PAGES][WIDTH];
  for (int p = 0; p < PAGES; p++)
    for (int x = 0; x < WIDTH; x++) fb[p][x] = 0;

  #define PIX(x, y) (fb[(y) / 8][(x)] |= (uint8_t)(1u << ((y) % 8)))
  for (int x = 0; x < WIDTH; x++)  { PIX(x, 0); PIX(x, HEIGHT - 1); }
  for (int y = 0; y < HEIGHT; y++) { PIX(0, y); PIX(WIDTH - 1, y); }
  // Both diagonals. x advances WIDTH/HEIGHT per row so each stroke reaches the
  // opposite corner exactly, rather than stopping short and leaving a gap that
  // would read as the very breakage this is meant to detect.
  for (int y = 0; y < HEIGHT; y++) {
    const int x = y * (WIDTH - 1) / (HEIGHT - 1);
    PIX(x, y);
    PIX(WIDTH - 1 - x, y);
  }
  #undef PIX

  for (int page = 0; page < PAGES; page++) {
    uint8_t row[1 + WIDTH];
    row[0] = 0x40;                       /* "data follows" */
    for (int x = 0; x < WIDTH; x++) row[1 + x] = fb[page][x];
    if (i2c_write_timeout_us(i2c1, addr, row, sizeof row, false,
                             I2C_TIMEOUT_US * 4) < 0) {
      return false;
    }
  }

  wf_logf(WF_INFO, "oled: 0x%02x initialised as %dx%d, frame + X drawn — "
                   "is the box closed on all four edges, strokes unbroken?",
          addr, WIDTH, HEIGHT);
  return true;
}
