// wifi-floppy/firmware/test/test_display_golden.c
#include "harness.h"
#include "../src/display.h"
#include <stdlib.h>
#include <string.h>

// Spec 2026-10-04-oled-layouts §6: the 128x32 default layout must reproduce
// the 1.6.5 panel byte for byte. These files ARE 1.6.5's output, captured
// before display.c changed. DISPLAY_GOLDEN_WRITE=1 rewrites them -- only ever
// from an unmodified renderer, and never in the same commit as a renderer change.

#define FB_BYTES 512   // 128 x 32 / 8: the golden set is 128x32 only

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
        snprintf(s.title, sizeof s.title, "%s", "Gods v1.00 (1991-03-28)(Renegade)(Disk 1 of 2)");
        snprintf(s.detail, sizeof s.detail, "%s", "a detail that is far too long");
        s.show_track = true; s.cyl = 42;                          g[n++] = (golden_t){"long_title", s};
    s = st(DS_LOADED); s.title[0] = '\0'; s.show_track = true; s.cyl = 1; g[n++] = (golden_t){"empty_title", s};
    s = st(DS_ERROR); strcpy(s.title, "no route"); s.bars = -1;   g[n++] = (golden_t){"error_noradio", s};
    return n;
}

static void path_for(char *out, size_t n, const char *name) {
    snprintf(out, n, "fixtures/display_golden/%s.fb", name);
}

static void render_golden(display_state_t s, uint8_t fb[FB_BYTES]) {
    display_render(&s, fb);
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

int main(void) {
    RUN(every_golden_state_matches);
    return REPORT();
}
