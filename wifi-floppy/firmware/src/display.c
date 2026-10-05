#include "display.h"
#include <string.h>
#include <stdio.h>

// ---------------------------------------------------------------- font
// The classic 5x7 ASCII table (as in the Nokia 5110 / Adafruit GFX example
// fonts; see THIRD-PARTY-NOTICES.md).
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
// it was not. That is unreadable: no disk was writable at the time (WPROT was
// asserted for every mount, before write-back existed), so the panel showed
// nothing at all, and nothing is indistinguishable from a firmware that has no
// such indicator. Reported by the operator the moment it was flashed.
//
// The same rule the wifi glyph already follows, where "no radio" is a struck
// glyph rather than a blank: a state worth showing is worth showing in both of
// its values. The cloud replaces the pencil: a cloud is only ever drawn on a
// writable disk, so it still says "writable" (and the padlock still says
// "read-only"), which keeps both values of the write state visible. Both
// occupy the same 8 columns, so the status word beside them never moves.
//
//   cloud (synced/pending/offline), writable    padlock, read-only
//   .....##.  (synced: filled)                  ..####..
//   ....####  (pending: up-arrow cut out)       .##..##.     the shackle
//   ...####.  (offline: diagonal strike)        .##..##.
//   ..####..                                    ########
//   .####...                                    ###..###     a keyhole, so
//   ####....                                    ###..###     it reads as a lock
//   ###.....                                    ########     and not as a
//   #.......                                    ........     filled box
#define PENCIL_W 8
static const uint8_t LOCK[8] = { 0x3C, 0x66, 0x66, 0xFF, 0xE7, 0xE7, 0xFF, 0x00 };
// synced: a plain cloud. pending: the same cloud with an up-arrow cut out of
// it. offline: the same cloud with a diagonal strike through it. All three
// share an outline, so they read as one symbol in three states.
static const uint8_t CLOUD[3][8] = {
    { 0x00, 0x18, 0x3C, 0x7E, 0xFF, 0xFF, 0x7E, 0x00 },   // DISP_SYNC_SYNCED
    { 0x00, 0x18, 0x24, 0x42, 0xE7, 0xE7, 0x66, 0x00 },   // DISP_SYNC_PENDING
    { 0x80, 0x58, 0x1C, 0x6E, 0xF7, 0xFB, 0x7C, 0x01 },   // DISP_SYNC_OFFLINE
};

// ---------------------------------------------------------------- drawing
// Every drawing primitive goes through px(); a scale of 2 makes each pixel a
// 2x2 block, so glyphs, bitmaps and text all double without separate fonts.
// Callers draw in the element's own 1x units: (x, y) here is in scaled space,
// and the clip is the panel's real height, set per render from the layout.
static int g_scale = 1;
static int g_rows  = 32;
static void px(uint8_t *fb, int x, int y) {
    for (int dy = 0; dy < g_scale; dy++) for (int dx = 0; dx < g_scale; dx++) {
        const int X = x * g_scale + dx, Y = y * g_scale + dy;
        if (X < 0 || X >= DISP_W || Y < 0 || Y >= g_rows) continue;
        fb[(Y / 8) * DISP_W + X] |= (uint8_t)(1u << (Y % 8));
    }
}

// An element origin in the current scaled coordinate space. 2x origins are
// even in any layout the editor saves (it snaps them); an odd one decoded
// from elsewhere simply lands one pixel up/left, still inside the bounds the
// validator checked.
#define AT(v) ((v) / g_scale)

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

static void draw_write_state(uint8_t *fb, int x, int y, bool writable, disp_sync_t sync) {
    const uint8_t *g = writable ? CLOUD[sync] : LOCK;
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
 * Split `title` across two lines of `line` characters at a space where one is
 * available. A hard split mid-word is legible but a break at a space reads
 * as the name it is; the fallback exists because a 30-character single word
 * is a real filename and must not vanish. At line = 21 (128 px) this is
 * exactly 1.6.5's split_title; the goldens hold it to that.
 */
static void split_title_n(const char *title, char a[64], char b[64], int line) {
    int n = (int)strlen(title);
    a[0] = b[0] = '\0';
    if (line > 63) line = 63;
    if (line < 2) line = 2;     // the ".." tail below needs two columns; a tiny hand-built w must not underflow
    if (n <= line) { memcpy(a, title, (size_t)n + 1); return; }

    int cut = -1;
    for (int i = 0; i <= line && i < n; i++) if (title[i] == ' ') cut = i;
    int take = (cut > 0) ? cut : line;
    memcpy(a, title, (size_t)take); a[take] = '\0';

    int from = (cut > 0) ? cut + 1 : take;
    int rest = n - from;
    if (rest > line) {
        // Truncated rather than dropped: ".." says "there was more", which a
        // silently shortened name does not.
        memcpy(b, title + from, (size_t)line - 2);
        b[line - 2] = '.'; b[line - 1] = '.'; b[line] = '\0';
    } else {
        memcpy(b, title + from, (size_t)rest); b[rest] = '\0';
    }
}

/** One line of at most `line` characters; a longer title ends in "..". */
static void one_line_n(const char *title, char a[64], int line) {
    int n = (int)strlen(title);
    if (line > 63) line = 63;
    if (n <= line) { memcpy(a, title, (size_t)n + 1); return; }
    memcpy(a, title, (size_t)line); a[line] = '\0';
    if (line >= 3) { a[line - 2] = '.'; a[line - 1] = '.'; }
}

// Outline 7 rows tall, filled left to right to pct; the percent text sits
// right-aligned after it (the element's size reserves a 2 px gap).
static void draw_bar(uint8_t *fb, int x, int y, int w, int pct) {
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    for (int i = 0; i < w; i++) { px(fb, x + i, y); px(fb, x + i, y + 6); }
    for (int j = 0; j < 7; j++) { px(fb, x, y + j); px(fb, x + w - 1, y + j); }
    const int fill = (w - 2) * pct / 100;
    for (int i = 0; i < fill; i++) for (int j = 2; j < 5; j++) px(fb, x + 1 + i, y + j);
}

bool display_state_is_running(disp_status_t st) {
    return st == DS_READY || st == DS_DOWNLOAD || st == DS_VERIFY || st == DS_LOADED;
}

const layout_t *display_layout_for(const display_state_t *s, const layout_t *custom) {
    // No layout at all (a display_t that was never display_init'ed) draws the
    // 128x32 default rather than dereferencing NULL.
    if (!custom) return layout_default(PANEL_128x32);
    return display_state_is_running(s->status) ? custom : layout_default(custom->panel);
}

static const layout_el_t *find(const layout_t *l, int id) {
    for (int i = 0; i < l->n; i++) if (l->el[i].id == id && l->el[i].visible) return &l->el[i];
    return NULL;
}

// Where the right-aligned text of a track/download element starts: the
// element's fixed box, flush right. Screen pixels.
static int right_text(const layout_el_t *e, const char *t) {
    int bw, bh; layout_el_size(e, &bw, &bh);
    return e->x + bw - text_px(t) * e->scale;
}

// Both numbers clamped to 0..99, which is what TRACK_MAX_CHARS (5, "99/99")
// sizes the element for. 1.6.5 printed them raw; no real disk has 100
// cylinders, and a box that fits every state is the layout model's rule.
static void track_text(const display_state_t *s, char out[8]) {
    const int c = s->cyl < 0 ? 0 : s->cyl > 99 ? 99 : s->cyl;
    const int m = s->max_cyl < 0 ? 0 : s->max_cyl > 99 ? 99 : s->max_cyl;
    snprintf(out, 8, "%d/%d", c, m);
}

// Clamped, not merely assumed. `pct` is an int and a caller can hand this
// anything; "%d%%" of INT_MAX is 12 bytes into 8. GCC says so and clang does
// not, which is why it took a second toolchain to notice. Clamping beats
// widening the buffer: a percentage over 100 is a bug in the caller, and
// showing "100%" is a better failure than a number that cannot be true.
static void pct_text(const display_state_t *s, char out[8]) {
    const int pct = s->pct < 0 ? 0 : s->pct > 100 ? 100 : s->pct;
    snprintf(out, 8, "%d%%", pct);
}

// Uses the file-scope g_scale/g_rows while drawing: not reentrant.
void display_render(const display_state_t *s, const layout_t *l, uint8_t fb[DISP_FB_MAX]) {
    memset(fb, 0, DISP_FB_MAX);
    g_rows = panel_height(l->panel);

    // The track counter only while a disk is mounted; the percent only while
    // downloading with a known percent.
    const layout_el_t *track = s->show_track ? find(l, EL_TRACK) : NULL;
    const layout_el_t *dl = (s->status == DS_DOWNLOAD && s->pct >= 0) ? find(l, EL_DOWNLOAD) : NULL;
    // Review Focus 1: where both would be drawn on top of each other, the
    // counter wins -- a half-drawn "12/79" is a lie about which track is
    // being read (1.6.5's rule: a swap downloading while a disk is mounted).
    if (track && dl) {
        int tw, th, dw, dh; layout_el_size(track, &tw, &th); layout_el_size(dl, &dw, &dh);
        const bool overlap = track->x < dl->x + dw && dl->x < track->x + tw &&
                             track->y < dl->y + dh && dl->y < track->y + th;
        if (overlap) dl = NULL;
    }

    for (int i = 0; i < l->n; i++) {
        const layout_el_t *e = &l->el[i];
        if (!e->visible) continue;
        g_scale = e->scale == 2 ? 2 : 1;
        const int x = AT(e->x), y = AT(e->y);
        int bw, bh; layout_el_size(e, &bw, &bh);
        switch (e->id) {
            case EL_WIFI:    draw_wifi(fb, x, y, s->bars); break;
            case EL_LEMMING: draw_lemming(fb, x, y, s->tick); break;
            case EL_WRITE:   draw_write_state(fb, x, y, s->writable, s->sync); break;
            case EL_STATUS:  draw_text(fb, x, y, status_word(s->status), x + bw / g_scale); break;
            case EL_TITLE: {
                const int line = e->w / ADVANCE;            // characters per line, 1x units
                char a[64], b[64];
                if (e->opt == 2) {
                    split_title_n(s->title, a, b, line);
                    draw_text(fb, x, y, a, x + e->w);
                    draw_text(fb, x, y + LINE_H, b, x + e->w);
                } else {
                    one_line_n(s->title, a, line);
                    draw_text(fb, x, y, a, x + e->w);
                }
                break;
            }
            case EL_TRACK:
                if (track == e) {
                    char t[8]; track_text(s, t);
                    draw_text(fb, AT(right_text(e, t)), y, t, AT(e->x + bw));
                }
                break;
            case EL_DOWNLOAD:
                if (dl == e) {
                    char t[8]; pct_text(s, t);
                    if (e->w) draw_bar(fb, x, y, e->w, s->pct);
                    draw_text(fb, AT(right_text(e, t)), y, t, AT(e->x + bw));
                }
                break;
            case EL_DETAIL: {
                // Clipped against a drawn counter/percent on its rows to its
                // right, exactly as 1.6.5: the limit is that text's first pixel
                // minus one ADVANCE. The number is never the one clipped -- a
                // clipped label is only shorter.
                int limit = e->x + bw;
                const layout_el_t *rt[2] = { track, dl };
                for (int k = 0; k < 2; k++) {
                    const layout_el_t *o = rt[k];
                    if (!o) continue;
                    int ow, oh; layout_el_size(o, &ow, &oh);
                    if (o->y >= e->y + bh || e->y >= o->y + oh) continue;   // different rows
                    char t[8];
                    if (o->id == EL_TRACK) track_text(s, t); else pct_text(s, t);
                    const int left = right_text(o, t) - ADVANCE * g_scale;
                    if (left > e->x && left < limit) limit = left;
                }
                draw_text(fb, x, y, s->detail, AT(limit));
                break;
            }
            default: break;
        }
    }
    g_scale = 1;
}

// ---------------------------------------------------------------- pump
static int pages_of(const display_t *d) { return panel_height(d->panel) / 8; }

void display_init(display_t *d, disp_blit_fn blit, void *ctx) {
    memset(d, 0, sizeof *d);
    d->blit   = blit;
    d->ctx    = ctx;
    d->panel  = PANEL_128x32;
    d->layout = layout_default(PANEL_128x32);
    d->resend_page = -1;
}

void display_set(display_t *d, const display_state_t *s) {
    display_render(s, display_layout_for(s, d->layout), d->fb);
}

bool display_set_layout(display_t *d, const layout_t *l) {
    if (!l || l->panel != d->panel) return false;   // pump and layout must agree on the panel
    d->layout = l;
    return true;
}

void display_set_panel(display_t *d, panel_t p) {
    d->panel  = p;
    d->layout = layout_default(p);
    memset(d->fb, 0, DISP_FB_MAX);
    memset(d->shadow, 0, DISP_FB_MAX);
    // An explicit resend cursor, NOT a sentinel shadow: a lit 0xFF framebuffer
    // byte would compare equal to a 0xFF shadow and never be sent, leaving
    // stale glass after the controller's re-init.
    d->resend_page = 0;
    d->resend_col  = 0;
}

bool display_in_sync(const display_t *d) {
    if (d->resend_page >= 0) return false;
    return memcmp(d->fb, d->shadow, (size_t)(pages_of(d) * DISP_W)) == 0;
}

int display_pump(display_t *d, int budget) {
    if (budget <= 0 || !d->blit) return 0;

    const int pages = pages_of(d);

    // A pending panel change: send every byte of every page, in order,
    // regardless of what the shadow says.
    if (d->resend_page >= 0) {
        const int p = d->resend_page, col = d->resend_col;
        int n = DISP_W - col;
        if (n > budget) n = budget;
        if (!d->blit(d->ctx, p, col, &d->fb[p * DISP_W + col], n)) return 0;
        memcpy(&d->shadow[p * DISP_W + col], &d->fb[p * DISP_W + col], (size_t)n);
        d->resend_col += n;
        if (d->resend_col >= DISP_W) { d->resend_col = 0; d->resend_page++; }
        if (d->resend_page >= pages) d->resend_page = -1;
        return n;
    }

    for (int p = 0; p < pages; p++) {
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
