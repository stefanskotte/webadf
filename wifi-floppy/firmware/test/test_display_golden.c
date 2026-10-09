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

int main(void) {
    RUN(every_golden_state_matches);
    RUN(test_track_wins_overlap_with_download);
    RUN(test_2x_doubles_pixels);
    RUN(test_built_in_states_ignore_a_custom_layout);
    RUN(test_128x64_default_draws_below_row_32);
    return REPORT();
}
