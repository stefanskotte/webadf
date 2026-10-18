#include "oled_cmds.h"
#include <string.h>

// See oled_cmds.h. Pure, so the exact bytes are host-tested; the comments on
// each command are the ones 1.16 carried in ssd1306.c.

void oled_rotation_cmds(uint8_t rot, uint8_t out[2]) {
  const bool turned = rot == LAYOUT_ROT_180;
  out[0] = turned ? 0xA0 : 0xA1;   /* segment remap: column 0 on the left (A1), or the right (A0) */
  out[1] = turned ? 0xC0 : 0xC8;   /* COM scan: row 0 at the top (C8, descending), or the bottom  */
}

int oled_cmd_len(uint8_t op) {
  switch (op) {
    case 0xD5: case 0xA8: case 0xD3: case 0x8D: case 0xAD:
    case 0x20: case 0xDA: case 0x81: case 0xD9: case 0xDB: return 2;
    default: return 1;
  }
}

int oled_init_cmds(bool sh1106, panel_t panel, uint8_t rot, uint8_t *out, size_t cap) {
  const int height = panel_height(panel);
  uint8_t r[2]; oled_rotation_cmds(rot, r);
  const uint8_t ssd1306[] = {
    0xAE,              /* display off while it is reconfigured           */
    0xD5, 0x80,        /* clock divide / oscillator frequency            */
    0xA8, (uint8_t)(height - 1), /* multiplex ratio: rows - 1           */
    0xD3, 0x00,        /* no vertical offset                             */
    0x40,              /* start line 0                                   */
    0x8D, 0x14,        /* CHARGE PUMP ON -- without this a correctly     */
                       /* wired panel stays black and looks unwired      */
    0x20, 0x02,        /* PAGE addressing, the mode ssd1306_blit uses    */
                       /* because the SH1106 has no other (ssd1306.c)    */
    r[0],              /* segment remap (oled_rotation_cmds)             */
    r[1],              /* COM scan direction (oled_rotation_cmds)        */
    0xDA, (uint8_t)(panel == PANEL_128x64 ? 0x12 : 0x02),
                       /* COM pins: 0x02 SEQUENTIAL for 128x32, 0x12     */
                       /* ALTERNATING for 128x64. A mismatch is the half */
                       /* of the 32/64 bug that survives fixing 0xA8     */
    0x81, 0xCF,        /* contrast                                       */
    0xD9, 0xF1, 0xDB, 0x40,
    0xA4,              /* show RAM, not an all-on test pattern -- an
                          all-on display would "pass" the self-test
                          without a single byte of ours reaching it     */
    0xA6,              /* normal, not inverted                           */
    0xAF,              /* display on                                     */
  };
  const uint8_t sh[] = {
    0xAE,
    0xD5, 0x80,
    0xA8, (uint8_t)(height - 1),
    0xD3, 0x00,
    0x40,
    0xAD, 0x8B,        /* DC-DC ON: the SH1106's charge pump command;    */
                       /* it has no 0x8D and no 0x20 mode select         */
    r[0],
    r[1],
    0xDA, (uint8_t)(panel == PANEL_128x64 ? 0x12 : 0x02),
    0x81, 0xCF,
    0xD9, 0x22,        /* precharge: the SH1106's reset default          */
    0xDB, 0x35,        /* VCOM deselect: the SH1106's reset default      */
    0xA4,
    0xA6,
    0xAF,
  };
  const uint8_t *seq = sh1106 ? sh : ssd1306;
  const size_t len = sh1106 ? sizeof sh : sizeof ssd1306;
  if (len > cap) return -1;
  memcpy(out, seq, len);
  return (int)len;
}
