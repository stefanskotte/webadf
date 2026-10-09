// wifi-floppy/firmware/test/test_display_golden.c
#include "harness.h"
#include "../src/display.h"
#include "../src/display_layout.h"
#include <stdlib.h>
#include <string.h>

// Spec 2026-10-04-oled-layouts §6: the 128x32 default layout must reproduce
// the 1.6.5 panel byte for byte. These files ARE 1.6.5's output, captured
// before display.c changed. DISPLAY_GOLDEN_WRITE=1 rewrites them -- only ever
// from an unmodified renderer, and never in the same commit as a renderer change.

#define FB_BYTES 512   // 128 x 32 / 8: the golden set is 128x32 only

// Truncation is the point of the long_title golden: fill `dst` from a string
// known to be too long and assert that it was (snprintf's return is the length
// it WOULD have written; using it also tells GCC the truncation is intended).
static void put_truncated(char *dst, size_t cap, const char *src) {
    int want = snprintf(dst, cap, "%s", src);
    if (want < 0 || (size_t)want < cap) { fprintf(stderr, "put_truncated: source fits, test is wrong\n"); abort(); }
}

static display_state_t st(disp_status_t status) {
    display_state_t s;
    memset(&s, 0, sizeof s);
    s.status = status; s.bars = 3; s.max_cyl = 79; s.pct = -1;
    return s;
}

typedef struct { const char *name; display_state_t s; } golden_t;

static int golden_set(golden_t *g) {
    int n = 0;
    display_state_t s;
    s = st(DS_BOOT);                                              g[n++] = (golden_t){"boot", s};
    s = st(DS_PORTAL); strcpy(s.title, "wifi-floppy-6A38");
        strcpy(s.detail, "join to set up");                       g[n++] = (golden_t){"portal", s};
    s = st(DS_WIFI); strcpy(s.title, "HomeNet"); s.bars = 1;      g[n++] = (golden_t){"wifi", s};
    s = st(DS_READY); strcpy(s.title, "no disk");                 g[n++] = (golden_t){"ready", s};
    s = st(DS_DOWNLOAD); strcpy(s.title, "Workbench 3.1 Install"); s.pct = 0;   g[n++] = (golden_t){"dl0", s};
    s = st(DS_DOWNLOAD); strcpy(s.title, "Workbench 3.1 Install"); s.pct = 64;  g[n++] = (golden_t){"dl64", s};
    s = st(DS_DOWNLOAD); strcpy(s.title, "Workbench 3.1 Install"); s.pct = 100; g[n++] = (golden_t){"dl100", s};
    // Review Focus 1: a swap downloading while a disk is mounted -- the counter wins.
    s = st(DS_DOWNLOAD); strcpy(s.title, "Turrican"); s.pct = 40;
        s.show_track = true; s.cyl = 12;                          g[n++] = (golden_t){"dl_with_track", s};
    s = st(DS_VERIFY); strcpy(s.title, "Turrican");               g[n++] = (golden_t){"verify", s};
    s = st(DS_LOADED); strcpy(s.title, "Workbench 3.1 Install"); strcpy(s.detail, "disk 1 of 6");
        s.show_track = true; s.cyl = 0; s.writable = true;        g[n++] = (golden_t){"mounted_w_t0", s};
    s = st(DS_LOADED); strcpy(s.title, "Workbench 3.1 Install"); strcpy(s.detail, "disk 1 of 6");
        s.show_track = true; s.cyl = 79;                          g[n++] = (golden_t){"mounted_ro_t79", s};
    s = st(DS_LOADED); strcpy(s.title, "A"); s.show_track = true; s.cyl = 80; s.max_cyl = 83;
        s.writable = true; s.sync = DISP_SYNC_PENDING; s.tick = 1; g[n++] = (golden_t){"mounted_pending", s};
    s = st(DS_LOADED); strcpy(s.title, "A"); s.show_track = true; s.cyl = 5;
        s.writable = true; s.sync = DISP_SYNC_OFFLINE;            g[n++] = (golden_t){"mounted_offline", s};
    s = st(DS_LOADED);
        put_truncated(s.title, sizeof s.title, "Gods v1.00 (1991-03-28)(Renegade)(Disk 1 of 2)");
        put_truncated(s.detail, sizeof s.detail, "a detail that is far too long");
        s.show_track = true; s.cyl = 42;                          g[n++] = (golden_t){"long_title", s};
    s = st(DS_LOADED); s.title[0] = '\0'; s.show_track = true; s.cyl = 1; g[n++] = (golden_t){"empty_title", s};
    s = st(DS_ERROR); strcpy(s.title, "no route"); s.bars = -1;   g[n++] = (golden_t){"error_noradio", s};
    return n;
}

static void path_for(char *out, size_t n, const char *name) {
    snprintf(out, n, "fixtures/display_golden/%s.fb", name);
}

static void render_golden(display_state_t s, uint8_t fb[FB_BYTES]) {
    uint8_t full[DISP_FB_MAX];
    display_render(&s, display_layout_for(&s, layout_default(PANEL_128x32)), full);
    memcpy(fb, full, FB_BYTES);          // a 32-row panel uses pages 0..3
    for (int i = FB_BYTES; i < DISP_FB_MAX; i++) CHECK(full[i] == 0, "nothing below row 32");
}

static void every_golden_state_matches(void) {
    golden_t g[32];
    const int n = golden_set(g);
    const bool write = getenv("DISPLAY_GOLDEN_WRITE") != NULL;
    for (int i = 0; i < n; i++) {
        uint8_t fb[FB_BYTES];
        render_golden(g[i].s, fb);
        char path[128];
        path_for(path, sizeof path, g[i].name);
        if (write) {
            FILE *f = fopen(path, "wb");
            CHECK(f != NULL, path);
            if (f) { fwrite(fb, 1, FB_BYTES, f); fclose(f); }
            continue;
        }
        uint8_t want[FB_BYTES];
        FILE *f = fopen(path, "rb");
        CHECK(f != NULL, path);
        if (!f) continue;
        size_t got = fread(want, 1, FB_BYTES, f);
        fclose(f);
        CHECK(got == FB_BYTES, path);
        CHECK(memcmp(fb, want, FB_BYTES) == 0, g[i].name);
    }
}

static int lit(const uint8_t *fb, int x0, int y0, int x1, int y1) {
    int n = 0;
    for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++)
        if (fb[(y / 8) * DISP_W + x] & (1u << (y % 8))) n++;
    return n;
}

static void test_track_wins_overlap_with_download(void) {
    // Review Focus 1, in a CUSTOM layout: download and track overlapping.
    layout_t l = *layout_default(PANEL_128x32);
    display_state_t s; memset(&s, 0, sizeof s);
    s.status = DS_DOWNLOAD; s.pct = 50; s.show_track = true; s.cyl = 12; s.max_cyl = 79; s.bars = 3;
    uint8_t fb[DISP_FB_MAX]; display_render(&s, &l, fb);
    // "50%" would start at 128-23 = 105; "12/79" starts at 128-29 = 99. Only the counter's pixels.
    uint8_t only_track[DISP_FB_MAX]; display_state_t t = s; t.status = DS_LOADED;
    display_render(&t, &l, only_track);
    CHECK(memcmp(fb + 3 * DISP_W + 98, only_track + 3 * DISP_W + 98, 30) == 0, "row 3 right side = counter only");
}

static void test_2x_doubles_pixels(void) {
    layout_t one = { PANEL_128x64, 1, { { EL_WIFI, 1, 1, 0, 0, 0, 0 } } };
    layout_t two = { PANEL_128x64, 1, { { EL_WIFI, 1, 2, 0, 0, 0, 0 } } };
    display_state_t s; memset(&s, 0, sizeof s); s.status = DS_READY; s.bars = 3;
    uint8_t a[DISP_FB_MAX], b[DISP_FB_MAX];
    display_render(&s, &one, a); display_render(&s, &two, b);
    CHECK_EQ_INT(lit(b, 0, 0, 22, 16), 4 * lit(a, 0, 0, 11, 8));
}

static void test_built_in_states_ignore_a_custom_layout(void) {
    layout_t l = { PANEL_128x32, 0, {{0}} };           // blank custom layout
    display_state_t s; memset(&s, 0, sizeof s); s.status = DS_PORTAL; strcpy(s.title, "wifi-floppy-6A38");
    uint8_t fb[DISP_FB_MAX];
    display_render(&s, display_layout_for(&s, &l), fb);
    CHECK(lit(fb, 0, 8, 128, 16) > 0, "the portal SSID still shows");
    s.status = DS_LOADED; display_render(&s, display_layout_for(&s, &l), fb);
    CHECK_EQ_INT(lit(fb, 0, 0, 128, 32), 0);   // running state: the blank layout really is blank
}

static void test_128x64_default_draws_below_row_32(void) {
    display_state_t s; memset(&s, 0, sizeof s);
    s.status = DS_LOADED; strcpy(s.title, "Turrican"); s.show_track = true; s.cyl = 9; s.max_cyl = 79;
    uint8_t fb[DISP_FB_MAX]; display_render(&s, layout_default(PANEL_128x64), fb);
    CHECK(lit(fb, 0, 32, 128, 64) > 0, "lower half used");
}

// ---- the NFC element (1.10.0). Its own goldens, on CUSTOM layouts (no
// default lists it): the default goldens above staying byte-identical is the
// proof that a board without the element draws what 1.9.x drew.
typedef struct { const char *name; panel_t panel; int x, y, scale; disp_nfc_t nfc; } nfc_golden_t;
static const nfc_golden_t NFC_GOLDENS[] = {
    { "nfc_present_32",   PANEL_128x32, 100,  0, 1, DISP_NFC_PRESENT },
    { "nfc_absent_32",    PANEL_128x32, 100,  0, 1, DISP_NFC_ABSENT  },
    { "nfc_armed_32",     PANEL_128x32, 100,  0, 1, DISP_NFC_ARMED   },
    { "nfc_present_2x_64",PANEL_128x64,   0, 40, 2, DISP_NFC_PRESENT },
    { "nfc_absent_2x_64", PANEL_128x64,   0, 40, 2, DISP_NFC_ABSENT  },
    { "nfc_armed_2x_64",  PANEL_128x64,   0, 40, 2, DISP_NFC_ARMED   },
};

static void render_nfc(const nfc_golden_t *g, uint8_t fb[DISP_FB_MAX]) {
    layout_t l = *layout_default(g->panel);
    l.el[l.n++] = (layout_el_t){ EL_NFC, 1, (uint8_t)g->scale, (uint8_t)g->x, (uint8_t)g->y, 0, 0 };
    display_state_t s = st(DS_LOADED);
    strcpy(s.title, "Turrican"); strcpy(s.detail, "Disk 1/2");
    s.show_track = true; s.cyl = 12; s.writable = true; s.nfc = g->nfc;
    display_render(&s, &l, fb);
}

static void nfc_goldens_match(void) {
    const bool write = getenv("DISPLAY_GOLDEN_WRITE") != NULL;
    for (size_t i = 0; i < sizeof NFC_GOLDENS / sizeof NFC_GOLDENS[0]; i++) {
        const nfc_golden_t *g = &NFC_GOLDENS[i];
        const size_t bytes = (size_t)panel_height(g->panel) * DISP_W / 8;
        uint8_t fb[DISP_FB_MAX]; render_nfc(g, fb);
        char path[128]; path_for(path, sizeof path, g->name);
        if (write) {
            FILE *f = fopen(path, "wb"); CHECK(f != NULL, path);
            if (f) { fwrite(fb, 1, bytes, f); fclose(f); }
            continue;
        }
        uint8_t want[DISP_FB_MAX]; FILE *f = fopen(path, "rb"); CHECK(f != NULL, path);
        if (!f) continue;
        size_t got = fread(want, 1, sizeof want, f); fclose(f);
        CHECK(got == bytes, path);
        CHECK(memcmp(fb, want, bytes) == 0, g->name);
    }
}

static bool on(const uint8_t *fb, int x, int y) { return (fb[(y / 8) * DISP_W + x] >> (y % 8)) & 1u; }

// The picture itself, row by row, against display.c's comment: an assertion
// on the SHAPE, which the wifi glyph's history says counts must not stand in for.
static void nfc_glyph_is_the_picture(void) {
    static const char *const want[3][8] = {
        { "....#...", "..#..#..", "...#..#.", "#..#..#.", "#..#..#.", "...#..#.", "..#..#..", "....#..." },
        { "#...#...", ".##..#..", "..##..#.", "#..#..#.", "#..##.#.", "...#.##.", "..#..##.", "....#..#" },
        { "####.###", "##.##.##", "###.##.#", ".##.##.#", ".##.##.#", "###.##.#", "##.##.##", "####.###" },
    };
    const disp_nfc_t states[3] = { DISP_NFC_PRESENT, DISP_NFC_ABSENT, DISP_NFC_ARMED };
    for (int k = 0; k < 3; k++) {
        layout_t l = { PANEL_128x32, 1, { { EL_NFC, 1, 1, 40, 8, 0, 0 } } };
        display_state_t s; memset(&s, 0, sizeof s); s.status = DS_READY; s.nfc = states[k];
        uint8_t fb[DISP_FB_MAX]; display_render(&s, &l, fb);
        for (int r = 0; r < 8; r++) for (int c = 0; c < 8; c++)
            CHECK(on(fb, 40 + c, 8 + r) == (want[k][r][c] == '#'), want[k][r]);
        CHECK_EQ_INT(lit(fb, 0, 0, 128, 32), lit(fb, 40, 8, 48, 16));   // nothing outside its box

        // 2x: every pixel a 2x2 block, at the same origin.
        l.el[0].scale = 2;
        uint8_t big[DISP_FB_MAX]; display_render(&s, &l, big);
        for (int r = 0; r < 16; r++) for (int c = 0; c < 16; c++)
            CHECK(on(big, 40 + c, 8 + r) == (want[k][r / 2][c / 2] == '#'), "2x block");
    }
}

static void nfc_hidden_or_absent_from_the_layout_draws_nothing(void) {
    display_state_t s; memset(&s, 0, sizeof s); s.status = DS_READY; s.nfc = DISP_NFC_ARMED;
    layout_t l = { PANEL_128x32, 1, { { EL_NFC, 0, 1, 40, 8, 0, 0 } } };
    uint8_t fb[DISP_FB_MAX]; display_render(&s, &l, fb);
    CHECK_EQ_INT(lit(fb, 0, 0, 128, 32), 0);
    // The default layout ignores the reader's state entirely.
    uint8_t a[DISP_FB_MAX], b[DISP_FB_MAX];
    s.nfc = DISP_NFC_ABSENT;  display_render(&s, layout_default(PANEL_128x32), a);
    s.nfc = DISP_NFC_ARMED;   display_render(&s, layout_default(PANEL_128x32), b);
    CHECK(memcmp(a, b, sizeof a) == 0, "default 128x32 does not draw the nfc state");
    s.nfc = DISP_NFC_ABSENT;  display_render(&s, layout_default(PANEL_128x64), a);
    s.nfc = DISP_NFC_PRESENT; display_render(&s, layout_default(PANEL_128x64), b);
    CHECK(memcmp(a, b, sizeof a) == 0, "default 128x64 does not draw the nfc state");
}

// 1.10.0: on 128x64 the built-in screens draw exactly the 128x32 ones at the
// top. The 128x64 default's 2x title holds ten characters, and the real
// strings (main.c: "wifi-floppy", "Setup needed") came out "wifi-flo.." and
// "Setup ne..". Checked against the 128x32 goldens, with the real strings.
static void builtin_screens_on_128x64_are_the_128x32_ones(void) {
    golden_t g[32];
    const int n = golden_set(g);
    for (int i = 0; i < n; i++) {
        if (display_state_is_running(g[i].s.status)) continue;
        uint8_t small[FB_BYTES]; render_golden(g[i].s, small);
        uint8_t big[DISP_FB_MAX];
        display_render(&g[i].s, display_layout_for(&g[i].s, layout_default(PANEL_128x64)), big);
        CHECK(memcmp(big, small, FB_BYTES) == 0, g[i].name);
        CHECK_EQ_INT(lit(big, 0, 32, 128, 64), 0);
    }
    const char *titles[] = { "wifi-floppy", "Setup needed", "Connecting" };
    const disp_status_t sts[] = { DS_BOOT, DS_PORTAL, DS_WIFI };
    for (int k = 0; k < 3; k++) {
        display_state_t s = st(sts[k]); strcpy(s.title, titles[k]); strcpy(s.detail, "wifi-floppy-6A38");
        uint8_t a[DISP_FB_MAX], b[DISP_FB_MAX];
        display_render(&s, display_layout_for(&s, layout_default(PANEL_128x64)), a);
        display_render(&s, display_layout_for(&s, layout_default(PANEL_128x32)), b);
        CHECK(memcmp(a, b, FB_BYTES) == 0, titles[k]);
        // The whole title is drawn: 6 px a character, so its last glyph ends
        // at 6n-1 and nothing ("..") follows it.
        const int end = 6 * (int)strlen(titles[k]);
        CHECK(lit(a, end - 6, 8, end, 16) > 0, "last character drawn");
        CHECK_EQ_INT(lit(a, end, 8, 128, 16), 0);
    }
}

int main(void) {
    RUN(every_golden_state_matches);
    RUN(builtin_screens_on_128x64_are_the_128x32_ones);
    RUN(nfc_goldens_match);
    RUN(nfc_glyph_is_the_picture);
    RUN(nfc_hidden_or_absent_from_the_layout_draws_nothing);
    RUN(test_track_wins_overlap_with_download);
    RUN(test_2x_doubles_pixels);
    RUN(test_built_in_states_ignore_a_custom_layout);
    RUN(test_128x64_default_draws_below_row_32);
    return REPORT();
}
