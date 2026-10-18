#include "ssd1306.h"
#include "floppy_io.h"
#include "wf_log.h"
#include "pico/stdlib.h"
#include "hardware/i2c.h"
#include "board_hw.h"
#include "oled_cmds.h"

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
 * The panel height is a PARAMETER now (128x32 or 128x64), but the lesson stands. Confirmed by the operator 2026-09-11 after a long
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
static bool cmd(uint8_t addr, const uint8_t *bytes, size_t n) {
  // Control byte 0x00 says "everything after this is a command".
  uint8_t buf[8];
  if (n + 1 > sizeof buf) return false;
  buf[0] = 0x00;
  for (size_t i = 0; i < n; i++) buf[i + 1] = bytes[i];
  return i2c_write_timeout_us(board_i2c(), addr, buf, n + 1, false, I2C_TIMEOUT_US) >= 0;
}

/*
 * TWO CONTROLLERS behind the same address. 0.91"/0.96" modules are SSD1306;
 * most 1.3" 128x64 modules are SH1106, which shares the basic command set but
 * NOT the SSD1306's horizontal addressing (0x20) or its column/page windows
 * (0x21/0x22). Found 2026-10-08 when the operator fitted a 1.3" panel: every
 * blit's window commands were ignored, so all our bytes landed in one page
 * and the rest of the glass showed power-on RAM noise. Worse, the SH1106
 * reads the windows' OPERANDS as commands of its own (0x7F is "start line
 * 63"). So blits now use PAGE addressing, which both controllers implement
 * identically (0xB0|page, column low/high nibbles), and the SH1106's 132-
 * column RAM is offset by 2 so column 0 is the glass's first.
 */
static bool s_sh1106;

/*
 * Which controller answers at `addr`. Both return a status byte on a read;
 * its low nibble is an ID: 0x08 (or 0x00) on an SH1106, 0x03-0x07 on an
 * SSD1306 -- the same test Meshtastic's I2C scan uses. Read until two agree
 * (at most four tries). Anything unrecognised is treated as an SSD1306, which
 * is what every earlier build assumed, and the raw byte is logged either way.
 */
static bool detect_sh1106(uint8_t addr) {
  uint8_t r = 0xFF, prev;
  for (int i = 0; i < 4; i++) {
    prev = r;
    const uint8_t ctrl = 0x00;
    if (i2c_write_timeout_us(board_i2c(), addr, &ctrl, 1, true, I2C_TIMEOUT_US) < 0 ||
        i2c_read_timeout_us(board_i2c(), addr, &r, 1, false, I2C_TIMEOUT_US) < 0) {
      wf_logf(WF_WARN, "oled: 0x%02x status read failed -- assuming SSD1306", addr);
      return false;
    }
    if (i > 0 && r == prev) break;
  }
  const uint8_t id = r & 0x0F;
  const bool sh = (id == 0x08 || id == 0x00);
  wf_logf(WF_INFO, "oled: 0x%02x status 0x%02x -> %s", addr, r,
          sh ? "SH1106" : (id >= 0x03 && id <= 0x07) ? "SSD1306"
                        : "unrecognised, assuming SSD1306");
  return sh;
}

/*
 * The panel's rotation (1.17.0): LAYOUT_ROT_0 or LAYOUT_ROT_180, done in the
 * controller -- segment remap + COM scan direction (oled_cmds.c) -- so the
 * framebuffer, the pump and every byte count stay what they were. Kept here so
 * a re-init (a panel-type switch) keeps it.
 */
static uint8_t s_rot = LAYOUT_ROT_0;

/* The controller configuration for `panel`, and nothing else: no clear. */
static bool send_init_sequence(uint8_t addr, panel_t panel) {
  uint8_t init[OLED_INIT_MAX];
  const int len = oled_init_cmds(s_sh1106, panel, s_rot, init, sizeof init);
  if (len < 0) return false;
  for (int i = 0; i < len; ) {
    // One command plus its operands at a time (oled_cmd_len).
    const int n = oled_cmd_len(init[i]);
    if (!cmd(addr, &init[i], (size_t)n)) return false;
    i += n;
  }
  return true;
}

bool ssd1306_init(uint8_t addr, panel_t panel) {
  // At boot's 100 kHz, before anything is configured. reinit reuses the answer.
  s_sh1106 = detect_sh1106(addr);
  if (!send_init_sequence(addr, panel)) return false;

  /*
   * 400 kHz now that a device has answered and the wiring is known good.
   * i2c_probe_bus() deliberately runs at 100 kHz because its question is "is
   * anything there" over hand-wired Dupont leads; once the panel has ACKed
   * and initialised, the rate that matters is the one that decides how long
   * core0's service loop is blocked per update. At 100 kHz every display
   * write would cost four times as much of that loop, for no gain.
   */
  i2c_set_baudrate(board_i2c(), 400000);

  if (!ssd1306_clear(addr, panel)) return false;
  return true;
}

/*
 * The panel-TYPE switch at runtime (display_apply in main.c, core0), which
 * must not do what ssd1306_init does last: a synchronous full clear. That is
 * every page at 400 kHz -- (128 + 9) bytes x ~9 bits per page, 4 pages ~12 ms
 * on a 128x32, 8 pages ~25 ms on a 128x64 -- with core0's 1 ms service loop
 * blocked, possibly while the Amiga is reading a disk. It is also redundant:
 * the caller follows this with display_set_panel, whose pump resends EVERY
 * byte of the new panel's pages through the budgeted 1 ms loop. What is left
 * here is the command sequence alone, ~25 short transfers (~2 ms at 400 kHz,
 * already set by the boot-time init). Until the pump catches up the glass can
 * briefly show stale RAM (on a 32 -> 64 switch, pages 4-7 were never
 * written), which is cosmetic and gone within one resend.
 */
bool ssd1306_reinit(uint8_t addr, panel_t panel) {
  return send_init_sequence(addr, panel);
}

/*
 * Turn the glass (1.17.0): two commands, ~0.2 ms. The SSD1306 applies a new
 * segment remap only to data written AFTER it (its datasheet: "only affects
 * subsequent data input"), while the COM scan flips at once, so the caller
 * resends every byte (display_resend_all) -- until the pump has, the glass
 * shows the old picture half-turned, which is cosmetic and gone within one
 * resend.
 */
bool ssd1306_set_rotation(uint8_t addr, uint8_t rot) {
  s_rot = rot == LAYOUT_ROT_180 ? LAYOUT_ROT_180 : LAYOUT_ROT_0;
  uint8_t c[2]; oled_rotation_cmds(s_rot, c);
  return cmd(addr, c, sizeof c);
}

uint8_t ssd1306_rotation(void) { return s_rot; }

/** Address one page and stream `n` bytes into it. */
bool ssd1306_blit(uint8_t addr, panel_t panel, int page, int col, const uint8_t *bytes, int n) {
  if (page < 0 || page >= panel_height(panel) / 8 || col < 0 || n <= 0 || col + n > WIDTH) return false;

  // Page addressing: page, then the column's low and high nibbles, in one
  // transfer. Each blit sets its own start, so it is independent of whatever
  // ran before it; the column advances within the page and never wraps into
  // the next one. The SH1106's visible columns are RAM 2..129 of 132.
  const int c = col + (s_sh1106 ? 2 : 0);
  const uint8_t addr_cmds[] = { (uint8_t)(0xB0 | page), (uint8_t)(0x00 | (c & 0x0F)),
                                (uint8_t)(0x10 | (c >> 4)) };
  if (!cmd(addr, addr_cmds, sizeof addr_cmds)) return false;

  uint8_t buf[1 + WIDTH];
  buf[0] = 0x40;                          /* "data follows" */
  for (int i = 0; i < n; i++) buf[1 + i] = bytes[i];
  return i2c_write_timeout_us(board_i2c(), addr, buf, (size_t)n + 1, false,
                              I2C_TIMEOUT_US * 4) >= 0;
}

bool ssd1306_clear(uint8_t addr, panel_t panel) {
  // Leaves the panel matching display.c's all-zero shadow, which is what lets
  // the pump send only genuine changes from the very first frame instead of
  // having to push a full one to establish agreement.
  uint8_t zero[WIDTH];
  for (int x = 0; x < WIDTH; x++) zero[x] = 0;
  for (int p = 0; p < panel_height(panel) / 8; p++)
    if (!ssd1306_blit(addr, panel, p, 0, zero, WIDTH)) return false;
  return true;
}

bool ssd1306_selftest(uint8_t addr, panel_t panel) {
  const int height = panel_height(panel), pages = height / 8;
  if (!ssd1306_init(addr, panel)) return false;

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
  // static, not on the stack: 1 KB here put core0's boot path past its 2 KB
  // stack in 1.7.0 (a hard fault before USB came up). Boot-only, one caller.
  static uint8_t fb[8][WIDTH];
  for (int p = 0; p < pages; p++)
    for (int x = 0; x < WIDTH; x++) fb[p][x] = 0;

  #define PIX(x, y) (fb[(y) / 8][(x)] |= (uint8_t)(1u << ((y) % 8)))
  for (int x = 0; x < WIDTH; x++)  { PIX(x, 0); PIX(x, height - 1); }
  for (int y = 0; y < height; y++) { PIX(0, y); PIX(WIDTH - 1, y); }
  // Both diagonals. x advances WIDTH/height per row so each stroke reaches the
  // opposite corner exactly, rather than stopping short and leaving a gap that
  // would read as the very breakage this is meant to detect.
  for (int y = 0; y < height; y++) {
    const int x = y * (WIDTH - 1) / (height - 1);
    PIX(x, y);
    PIX(WIDTH - 1 - x, y);
  }
  #undef PIX

  // Pushed through ssd1306_blit(), deliberately: that is the path the display
  // driver uses for every update, so a self-test that bypassed it would prove
  // the panel works and leave the code that actually drives it untested.
  for (int page = 0; page < pages; page++)
    if (!ssd1306_blit(addr, panel, page, 0, fb[page], WIDTH)) return false;

  wf_logf(WF_INFO, "oled: 0x%02x initialised as %dx%d %s, frame + X drawn — "
                   "is the box closed on all four edges, strokes unbroken?",
          addr, WIDTH, height, s_sh1106 ? "SH1106" : "SSD1306");
  return true;
}
