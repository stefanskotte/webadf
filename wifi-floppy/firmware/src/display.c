#include "display.h"
#include <string.h>
#include <stdio.h>

// ---------------------------------------------------------------- font
// 5x7, one byte per column, bit 0 = top row. ASCII 0x20..0x7E; anything
// outside that range renders as '?' rather than reading past the table.
#define FONT_FIRST 0x20
#define FONT_LAST  0x7E
#define GLYPH_W    5
#define ADVANCE    (GLYPH_W + 1)   // one blank column between characters
#define LINE_H     8               // 7 rows of glyph + 1 of leading

static const uint8_t FONT[FONT_LAST - FONT_FIRST + 1][GLYPH_W] = {
  {0x00,0x00,0x00,0x00,0x00}, {0x00,0x00,0x5F,0x00,0x00}, // sp !
  {0x00,0x07,0x00,0x07,0x00}, {0x14,0x7F,0x14,0x7F,0x14}, // " #
  {0x24,0x2A,0x7F,0x2A,0x12}, {0x23,0x13,0x08,0x64,0x62}, // $ %
  {0x36,0x49,0x55,0x22,0x50}, {0x00,0x05,0x03,0x00,0x00}, // & '
  {0x00,0x1C,0x22,0x41,0x00}, {0x00,0x41,0x22,0x1C,0x00}, // ( )
  {0x14,0x08,0x3E,0x08,0x14}, {0x08,0x08,0x3E,0x08,0x08}, // * +
  {0x00,0x50,0x30,0x00,0x00}, {0x08,0x08,0x08,0x08,0x08}, // , -
  {0x00,0x60,0x60,0x00,0x00}, {0x20,0x10,0x08,0x04,0x02}, // . /
  {0x3E,0x51,0x49,0x45,0x3E}, {0x00,0x42,0x7F,0x40,0x00}, // 0 1
  {0x42,0x61,0x51,0x49,0x46}, {0x21,0x41,0x45,0x4B,0x31}, // 2 3
  {0x18,0x14,0x12,0x7F,0x10}, {0x27,0x45,0x45,0x45,0x39}, // 4 5
  {0x3C,0x4A,0x49,0x49,0x30}, {0x01,0x71,0x09,0x05,0x03}, // 6 7
  {0x36,0x49,0x49,0x49,0x36}, {0x06,0x49,0x49,0x29,0x1E}, // 8 9
  {0x00,0x36,0x36,0x00,0x00}, {0x00,0x56,0x36,0x00,0x00}, // : ;
  {0x08,0x14,0x22,0x41,0x00}, {0x14,0x14,0x14,0x14,0x14}, // < =
  {0x00,0x41,0x22,0x14,0x08}, {0x02,0x01,0x51,0x09,0x06}, // > ?
  {0x32,0x49,0x79,0x41,0x3E}, {0x7E,0x11,0x11,0x11,0x7E}, // @ A
  {0x7F,0x49,0x49,0x49,0x36}, {0x3E,0x41,0x41,0x41,0x22}, // B C
  {0x7F,0x41,0x41,0x22,0x1C}, {0x7F,0x49,0x49,0x49,0x41}, // D E
  {0x7F,0x09,0x09,0x09,0x01}, {0x3E,0x41,0x49,0x49,0x7A}, // F G
  {0x7F,0x08,0x08,0x08,0x7F}, {0x00,0x41,0x7F,0x41,0x00}, // H I
  {0x20,0x40,0x41,0x3F,0x01}, {0x7F,0x08,0x14,0x22,0x41}, // J K
  {0x7F,0x40,0x40,0x40,0x40}, {0x7F,0x02,0x0C,0x02,0x7F}, // L M
  {0x7F,0x04,0x08,0x10,0x7F}, {0x3E,0x41,0x41,0x41,0x3E}, // N O
  {0x7F,0x09,0x09,0x09,0x06}, {0x3E,0x41,0x51,0x21,0x5E}, // P Q
  {0x7F,0x09,0x19,0x29,0x46}, {0x46,0x49,0x49,0x49,0x31}, // R S
  {0x01,0x01,0x7F,0x01,0x01}, {0x3F,0x40,0x40,0x40,0x3F}, // T U
  {0x1F,0x20,0x40,0x20,0x1F}, {0x3F,0x40,0x38,0x40,0x3F}, // V W
  {0x63,0x14,0x08,0x14,0x63}, {0x07,0x08,0x70,0x08,0x07}, // X Y
  {0x61,0x51,0x49,0x45,0x43}, {0x00,0x7F,0x41,0x41,0x00}, // Z [
  {0x02,0x04,0x08,0x10,0x20}, {0x00,0x41,0x41,0x7F,0x00}, // \ ]
  {0x04,0x02,0x01,0x02,0x04}, {0x40,0x40,0x40,0x40,0x40}, // ^ _
  {0x00,0x01,0x02,0x04,0x00}, {0x20,0x54,0x54,0x54,0x78}, // ` a
  {0x7F,0x48,0x44,0x44,0x38}, {0x38,0x44,0x44,0x44,0x20}, // b c
  {0x38,0x44,0x44,0x48,0x7F}, {0x38,0x54,0x54,0x54,0x18}, // d e
  {0x08,0x7E,0x09,0x01,0x02}, {0x08,0x14,0x54,0x54,0x3C}, // f g
  {0x7F,0x08,0x04,0x04,0x78}, {0x00,0x44,0x7D,0x40,0x00}, // h i
  {0x20,0x40,0x44,0x3D,0x00}, {0x7F,0x10,0x28,0x44,0x00}, // j k
  {0x00,0x41,0x7F,0x40,0x00}, {0x7C,0x04,0x18,0x04,0x78}, // l m
  {0x7C,0x08,0x04,0x04,0x78}, {0x38,0x44,0x44,0x44,0x38}, // n o
  {0x7C,0x14,0x14,0x14,0x08}, {0x08,0x14,0x14,0x18,0x7C}, // p q
  {0x7C,0x08,0x04,0x04,0x08}, {0x48,0x54,0x54,0x54,0x20}, // r s
  {0x04,0x3F,0x44,0x40,0x20}, {0x3C,0x40,0x40,0x20,0x7C}, // t u
  {0x1C,0x20,0x40,0x20,0x1C}, {0x3C,0x40,0x30,0x40,0x3C}, // v w
  {0x44,0x28,0x10,0x28,0x44}, {0x0C,0x50,0x50,0x50,0x3C}, // x y
  {0x44,0x64,0x54,0x4C,0x44}, {0x00,0x08,0x36,0x41,0x00}, // z {
  {0x00,0x00,0x7F,0x00,0x00}, {0x00,0x41,0x36,0x08,0x00}, // | }
  {0x08,0x08,0x2A,0x1C,0x08},                             // ~
};

// The wifi glyph, 11x8, as one nested arc per strength step plus a dot that
// is always drawn. Row-major bits, MSB = leftmost column, so the literal
// below reads as the picture it draws.
#define WIFI_W 11
// Each row below is the picture it draws: '#' is a lit pixel, column 0 is
// leftmost. Derived from that picture rather than hand-computed -- the first
// version of this table WAS hand-computed, and drew a diagonal wedge that
// every assertion happily passed, because the shape of a glyph is the one
// thing no assertion judges. test_display --dump is how it was caught.
//
//   ..#######..     three concentric arcs, outermost first, plus a dot that
//   .#.......#.     is always drawn. Strength adds arcs inward-out, so more
//   ...#####...     signal is always strictly more lit pixels.
//   ..#.....#..
//   ....###....
//   ...#...#...
//   .....#.....
//   ....###....
static const uint16_t WIFI_ARC3[8] = { 0x1FC,0x202,0x000,0x000,0x000,0x000,0x000,0x000 };
static const uint16_t WIFI_ARC2[8] = { 0x000,0x000,0x0F8,0x104,0x000,0x000,0x000,0x000 };
static const uint16_t WIFI_ARC1[8] = { 0x000,0x000,0x000,0x000,0x070,0x088,0x000,0x000 };
static const uint16_t WIFI_DOT [8] = { 0x000,0x000,0x000,0x000,0x000,0x000,0x020,0x070 };


// A LEMMING, walking on the spot in the top-right corner. Asked for because it
// is a nice thing to have on an Amiga floppy emulator, kept because it earns
// its 8 columns: it is the only element on this panel that shows core0's
// service loop is still TURNING. Every other field is static between events,
// so a hung board and an idle one look identical. A lemming that has stopped
// walking is a board that has stopped servicing the floppy bus.
//
// Eight pixels square, four frames, drawn from the pictures below rather than
// hand-computed -- see the wifi glyph's comment for why that rule exists here.
//
//   .######.   .........   wide hair, the one feature that survives here
//   .######.   .######.
//   ..####..   .######.    the passing frame drops the whole figure one
//   ..####..   ..####..    pixel as the feet come together -- that BOB is
//   .######.   ..####..    what reads as walking at 8 px, more than any
//   ..####..   .######.    number of extra leg positions would
//   ..#..#..   ..####..
//   .#....#.   ...##...
#define LEM_W     8
#define LEM_FRAMES 2
static const uint8_t LEMMING[LEM_FRAMES][8] = {
  { 0x7E, 0x7E, 0x3C, 0x3C, 0x7E, 0x3C, 0x24, 0x42 },   /* contact: legs apart, body up   */
  { 0x00, 0x7E, 0x7E, 0x3C, 0x3C, 0x7E, 0x3C, 0x18 },   /* passing: feet together, bobbed */
};


// THE WRITE STATE, as one of two glyphs -- never as the ABSENCE of one.
//
// The first version drew a pencil when the disk was writable and nothing when
// it was not. That is unreadable: no disk is writable today (WPROT is asserted
// for every mount while WRITE_BACK_IMPLEMENTED is 0), so the panel showed
// nothing at all, and nothing is indistinguishable from a firmware that has no
// such indicator. Reported by the operator the moment it was flashed.
//
// The same rule the wifi glyph already follows, where "no radio" is a struck
// glyph rather than a blank: a state worth showing is worth showing in both of
// its values. Both occupy the same 8 columns, so the status word beside them
// never moves.
//
//   pencil, writable        padlock, read-only
//   .....##.                ..####..
//   ....####                .##..##.     the shackle
//   ...####.                .##..##.
//   ..####..                ########
//   .####...                ###..###     a keyhole, so it reads as a lock
//   ####....                ###..###     and not as a filled box
//   ###.....                ########
//   #.......                ........
#define PENCIL_W 8
static const uint8_t LOCK[8] = { 0x3C, 0x66, 0x66, 0xFF, 0xE7, 0xE7, 0xFF, 0x00 };
static const uint8_t PENCIL[8] = { 0x06, 0x0F, 0x1E, 0x3C, 0x78, 0xF0, 0xE0, 0x80 };

// ---------------------------------------------------------------- drawing
static void px(uint8_t *fb, int x, int y) {
    if (x < 0 || x >= DISP_W || y < 0 || y >= DISP_H) return;
    fb[(y / 8) * DISP_W + x] |= (uint8_t)(1u << (y % 8));
}

static void draw_glyph(uint8_t *fb, int x, int y, char c) {
    unsigned char u = (unsigned char)c;
    if (u < FONT_FIRST || u > FONT_LAST) u = '?';
    const uint8_t *g = FONT[u - FONT_FIRST];
    for (int col = 0; col < GLYPH_W; col++)
        for (int row = 0; row < 7; row++)
            if (g[col] & (1u << row)) px(fb, x + col, y + row);
}

/** Draw until the string ends or the next glyph would pass `x_limit`.
 *  Returns the x just past what was drawn. */
static int draw_text(uint8_t *fb, int x, int y, const char *s, int x_limit) {
    for (; *s; s++) {
        if (x + GLYPH_W > x_limit) break;
        draw_glyph(fb, x, y, *s);
        x += ADVANCE;
    }
    return x;
}

static int text_px(const char *s) {
    int n = (int)strlen(s);
    return n ? n * ADVANCE - 1 : 0;   // no trailing inter-character column
}

static void draw_bitmap(uint8_t *fb, int x, int y, const uint16_t rows[8]) {
    for (int r = 0; r < 8; r++)
        for (int c = 0; c < WIFI_W; c++)
            if (rows[r] & (1u << (WIFI_W - 1 - c))) px(fb, x + c, y + r);
}

static void draw_lemming(uint8_t *fb, int x, int y, int frame) {
    const uint8_t *g = LEMMING[((frame % LEM_FRAMES) + LEM_FRAMES) % LEM_FRAMES];
    for (int r = 0; r < 8; r++)
        for (int c = 0; c < LEM_W; c++)
            if (g[r] & (1u << (LEM_W - 1 - c))) px(fb, x + c, y + r);
}

static void draw_write_state(uint8_t *fb, int x, int y, bool writable) {
    const uint8_t *g = writable ? PENCIL : LOCK;
    for (int r = 0; r < 8; r++)
        for (int c = 0; c < PENCIL_W; c++)
            if (g[r] & (1u << (PENCIL_W - 1 - c))) px(fb, x + c, y + r);
}

static void draw_wifi(uint8_t *fb, int x, int y, int bars) {
    draw_bitmap(fb, x, y, WIFI_DOT);
    if (bars >= 1) draw_bitmap(fb, x, y, WIFI_ARC1);
    if (bars >= 2) draw_bitmap(fb, x, y, WIFI_ARC2);
    if (bars >= 3) draw_bitmap(fb, x, y, WIFI_ARC3);
    // No radio at all: strike the glyph through, which is distinguishable
    // from "associated but weak" (a bare dot) at a glance. Those two states
    // want different actions from whoever is looking at it.
    if (bars < 0)
        for (int i = 0; i < 8; i++) px(fb, x + 1 + i, y + i);
}

static const char *status_word(disp_status_t s) {
    switch (s) {
        case DS_BOOT:     return "BOOT";
        case DS_PORTAL:   return "SETUP";
        case DS_WIFI:     return "WIFI";
        case DS_READY:    return "READY";
        case DS_DOWNLOAD: return "DOWNLOAD";
        case DS_VERIFY:   return "VERIFY";
        case DS_LOADED:   return "LOADED";
        case DS_ERROR:    return "ERROR";
    }
    return "?";
}

/**
 * Split `title` across the two middle lines at a space where one is
 * available. A hard split mid-word is legible but a break at a space reads
 * as the name it is; the fallback exists because a 30-character single word
 * is a real filename and must not vanish.
 */
static void split_title(const char *title, char a[22], char b[22]) {
    const int LINE = DISP_W / ADVANCE;          // 21 characters
    int n = (int)strlen(title);
    a[0] = b[0] = '\0';
    if (n <= LINE) { memcpy(a, title, (size_t)n + 1); return; }

    int cut = -1;
    for (int i = 0; i <= LINE && i < n; i++) if (title[i] == ' ') cut = i;
    int take = (cut > 0) ? cut : LINE;
    memcpy(a, title, (size_t)take); a[take] = '\0';

    int from = (cut > 0) ? cut + 1 : take;
    int rest = n - from;
    if (rest > LINE) {
        // Truncated rather than dropped: ".." says "there was more", which a
        // silently shortened name does not.
        memcpy(b, title + from, (size_t)LINE - 2);
        b[LINE - 2] = '.'; b[LINE - 1] = '.'; b[LINE] = '\0';
    } else {
        memcpy(b, title + from, (size_t)rest); b[rest] = '\0';
    }
}

void display_render(const display_state_t *s, uint8_t fb[DISP_FB_BYTES]) {
    memset(fb, 0, DISP_FB_BYTES);

    // --- top line: wifi glyph, status word, and the track counter ---------
    draw_wifi(fb, 0, 0, s->bars);

    // The lemming owns the top-right corner; the pencil, when there is one,
    // sits immediately left of it. Both are on the RIGHT so the left half --
    // the wifi glyph and the status word -- never moves: a status that shifted
    // sideways when a disk became writable would be harder to read at a
    // glance than the pencil is worth.
    draw_lemming(fb, DISP_W - LEM_W, 0, s->tick);
    draw_write_state(fb, DISP_W - LEM_W - 2 - PENCIL_W, 0, s->writable);
    // Constant, because the glyph is always there. The earlier version moved
    // this depending on whether a pencil was drawn, which made the status word
    // shift sideways as a disk mounted.
    draw_text(fb, WIFI_W + 3, 0, status_word(s->status),
              DISP_W - LEM_W - 2 - PENCIL_W - 2);

    // --- middle two lines: the disk name ----------------------------------
    char l1[22], l2[22];
    split_title(s->title, l1, l2);
    draw_text(fb, 0, LINE_H,     l1, DISP_W);
    draw_text(fb, 0, LINE_H * 2, l2, DISP_W);

    // --- bottom line: detail on the left, the number on the right ---------
    //
    // The counter lives here rather than the top-right because the lemming
    // took that corner. It is drawn FIRST and the detail text is clipped
    // against it, never the other way round: a half-drawn "12/79" would be a
    // lie about which track is being read, where a clipped label is only
    // shorter. Same rule as before the move, same reason.
    int right = DISP_W;
    if (s->show_track) {
        char t[16];
        snprintf(t, sizeof t, "%d/%d", s->cyl, s->max_cyl);
        int w = text_px(t);
        draw_text(fb, DISP_W - w, LINE_H * 3, t, DISP_W);
        right = DISP_W - w - ADVANCE;
    } else if (s->status == DS_DOWNLOAD && s->pct >= 0) {
        char t[8];
        snprintf(t, sizeof t, "%d%%", s->pct);
        int w = text_px(t);
        draw_text(fb, DISP_W - w, LINE_H * 3, t, DISP_W);
        right = DISP_W - w - ADVANCE;
    }
    draw_text(fb, 0, LINE_H * 3, s->detail, right);
}

// ---------------------------------------------------------------- pump
void display_init(display_t *d, disp_blit_fn blit, void *ctx) {
    memset(d, 0, sizeof *d);
    d->blit = blit;
    d->ctx  = ctx;
}

void display_set(display_t *d, const display_state_t *s) {
    display_render(s, d->fb);
}

bool display_in_sync(const display_t *d) {
    return memcmp(d->fb, d->shadow, DISP_FB_BYTES) == 0;
}

int display_pump(display_t *d, int budget) {
    if (budget <= 0 || !d->blit) return 0;

    for (int p = 0; p < DISP_PAGES; p++) {
        const int base = p * DISP_W;
        int lo = -1;
        for (int x = 0; x < DISP_W; x++)
            if (d->fb[base + x] != d->shadow[base + x]) { lo = x; break; }
        if (lo < 0) continue;

        int hi = lo;
        for (int x = DISP_W - 1; x > lo; x--)
            if (d->fb[base + x] != d->shadow[base + x]) { hi = x; break; }

        // The span may contain unchanged bytes; sending them is free next to
        // a second transaction's start/address/window overhead, and it keeps
        // one update to one contiguous write.
        int n = hi - lo + 1;
        if (n > budget) n = budget;

        if (!d->blit(d->ctx, p, lo, &d->fb[base + lo], n)) return 0;
        memcpy(&d->shadow[base + lo], &d->fb[base + lo], (size_t)n);
        return n;
    }
    return 0;
}
