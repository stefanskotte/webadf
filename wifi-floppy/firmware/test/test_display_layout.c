// wifi-floppy/firmware/test/test_display_layout.c
#include "harness.h"
#include "../src/display_layout.h"
#include <string.h>

static size_t enc(const layout_t *l, uint8_t *b) {
    int n = layout_encode(l, b, LAYOUT_BLOB_MAX);
    CHECK(n > 0, "encodes");
    return (size_t)n;
}

static void expect_reject(const uint8_t *b, size_t n, const char *needle) {
    layout_t l; char why[80] = "";
    CHECK(!layout_decode(b, n, &l, why, sizeof why), needle);
    CHECK(strstr(why, needle) != NULL, why);
}

static void defaults_decode_and_fit(void) {
    for (int p = 0; p <= 1; p++) {
        uint8_t b[LAYOUT_BLOB_MAX]; layout_t l; char why[80] = "";
        size_t n = enc(layout_default((panel_t)p), b);
        CHECK(layout_decode(b, n, &l, why, sizeof why), why);
        CHECK(l.panel == (panel_t)p, "panel round-trips");
    }
}

static void the_128x32_default_is_todays_layout(void) {
    const layout_t *l = layout_default(PANEL_128x32);
    // Positions from display.c as of 1.6.5 (wifi 0,0; status 14,0; write 110,0;
    // lemming 120,0; title 0,8 two lines; detail 0,24; track/percent right-aligned on row 24).
    int seen = 0;
    for (int i = 0; i < l->n; i++) {
        const layout_el_t *e = &l->el[i];
        if (e->id == EL_WIFI)    { CHECK(e->x == 0 && e->y == 0, "wifi"); seen++; }
        if (e->id == EL_STATUS)  { CHECK(e->x == 14 && e->y == 0, "status"); seen++; }
        if (e->id == EL_WRITE)   { CHECK(e->x == 110 && e->y == 0, "write"); seen++; }
        if (e->id == EL_LEMMING) { CHECK(e->x == 120 && e->y == 0, "lemming"); seen++; }
        if (e->id == EL_TITLE)   { CHECK(e->x == 0 && e->y == 8 && e->w == 128 && e->opt == 2, "title"); seen++; }
        if (e->id == EL_DETAIL)  { CHECK(e->x == 0 && e->y == 24 && e->w == 128, "detail"); seen++; }
        if (e->id == EL_TRACK)   { CHECK(e->x == 98 && e->y == 24, "track box ends at 128"); seen++; }
        if (e->id == EL_DOWNLOAD){ CHECK(e->x == 104 && e->y == 24 && e->w == 0, "percent box ends at 128"); seen++; }
    }
    CHECK_EQ_INT(seen, 8);
}

static void sizes_are_fixed_and_scale(void) {
    layout_el_t e = { EL_STATUS, 1, 1, 0, 0, 0, 0 }; int w, h;
    layout_el_size(&e, &w, &h); CHECK(w == 48 && h == 8, "status 48x8");
    e.scale = 2; layout_el_size(&e, &w, &h); CHECK(w == 96 && h == 16, "status 2x");
    layout_el_t t = { EL_TITLE, 1, 1, 0, 0, 60, 2 };
    layout_el_size(&t, &w, &h); CHECK(w == 60 && h == 16, "title w x 2 lines");
    layout_el_t d = { EL_DOWNLOAD, 1, 1, 0, 0, 40, 0 };
    layout_el_size(&d, &w, &h); CHECK(w == 66 && h == 8, "bar 40 + 2 + 24");
    layout_el_t tr = { EL_TRACK, 1, 1, 0, 0, 0, 0 };
    layout_el_size(&tr, &w, &h); CHECK(w == 30 && h == 8, "track 30x8");
}

static void each_rule_is_enforced(void) {
    uint8_t b[LAYOUT_BLOB_MAX]; layout_t l = *layout_default(PANEL_128x32); size_t n;
    n = enc(&l, b); b[0] = 2;                expect_reject(b, n, "format");
    n = enc(&l, b); b[1] = 7;                expect_reject(b, n, "panel");
    n = enc(&l, b); b[3] = 1;                expect_reject(b, n, "reserved");
    n = enc(&l, b);                          expect_reject(b, n - 1, "length");
    n = enc(&l, b); b[4] = 9;                expect_reject(b, n, "element id");
    n = enc(&l, b); b[4 + 8] = b[4];         expect_reject(b, n, "twice");
    n = enc(&l, b); b[4 + 1] = 0x04;         expect_reject(b, n, "flags");
    n = enc(&l, b); b[4 + 6] = 1;            expect_reject(b, n, "reserved");
    // bounds: the title (2 lines) moved to y=20 needs rows 20..35 on a 32-row panel
    layout_t m = l;
    for (int i = 0; i < m.n; i++) if (m.el[i].id == EL_TITLE) m.el[i].y = 20;
    n = enc(&m, b);                          expect_reject(b, n, "outside");
    m = l; for (int i = 0; i < m.n; i++) if (m.el[i].id == EL_TITLE) m.el[i].w = 8;
    n = enc(&m, b);                          expect_reject(b, n, "width");
    m = l; for (int i = 0; i < m.n; i++) if (m.el[i].id == EL_TITLE) m.el[i].opt = 3;
    n = enc(&m, b);                          expect_reject(b, n, "lines");
    m = l; for (int i = 0; i < m.n; i++) if (m.el[i].id == EL_DOWNLOAD) m.el[i].w = 4;
    n = enc(&m, b);                          expect_reject(b, n, "bar");
    m = l; for (int i = 0; i < m.n; i++) if (m.el[i].id == EL_WIFI) m.el[i].w = 3;
    n = enc(&m, b);                          expect_reject(b, n, "w must be 0");
}

static void garbage_never_decodes(void) {
    uint8_t b[LAYOUT_BLOB_MAX + 8]; layout_t l; char why[80];
    CHECK(!layout_decode(b, 0, &l, why, sizeof why), "empty");
    CHECK(!layout_decode(b, 3, &l, why, sizeof why), "short header");
    memset(b, 0xFF, sizeof b);
    CHECK(!layout_decode(b, sizeof b, &l, why, sizeof why), "all ones");
    b[0] = 1; b[1] = 0; b[2] = 17; b[3] = 0;
    CHECK(!layout_decode(b, 4 + 17 * 8, &l, why, sizeof why), "n > 16");
    uint8_t empty[4] = { 1, 1, 0, 0 };
    CHECK(layout_decode(empty, 4, &l, why, sizeof why) && l.n == 0, "n = 0 is a valid (blank) layout");
}

static void why_is_always_terminated(void) {
    uint8_t b[4] = { 9, 0, 0, 0 }; layout_t l; char why[6];
    memset(why, 'x', sizeof why);
    layout_decode(b, 4, &l, why, sizeof why);
    CHECK(memchr(why, '\0', sizeof why) != NULL, "NUL-terminated");
}

// Cross-language fixtures (Task 8 reads the same files from TypeScript).
static void fixtures_decode_as_named(void) {
    const char *ok[] = { "default32", "default64", "custom64" };
    const char *bad[][2] = { { "bad_bounds", "outside" }, { "bad_dup", "twice" }, { "bad_reserved", "reserved" } };
    for (int i = 0; i < 3; i++) {
        char p[96]; snprintf(p, sizeof p, "fixtures/layouts/%s.bin", ok[i]);
        FILE *f = fopen(p, "rb"); CHECK(f != NULL, p); if (!f) continue;
        uint8_t b[LAYOUT_BLOB_MAX + 1]; size_t n = fread(b, 1, sizeof b, f); fclose(f);
        layout_t l; char why[80] = "";
        CHECK(layout_decode(b, n, &l, why, sizeof why), p);
    }
    for (int i = 0; i < 3; i++) {
        char p[96]; snprintf(p, sizeof p, "fixtures/layouts/%s.bin", bad[i][0]);
        FILE *f = fopen(p, "rb"); CHECK(f != NULL, p); if (!f) continue;
        uint8_t b[LAYOUT_BLOB_MAX + 1]; size_t n = fread(b, 1, sizeof b, f); fclose(f);
        expect_reject(b, n, bad[i][1]);
    }
    // default32.bin is exactly the encoded default
    uint8_t want[LAYOUT_BLOB_MAX]; size_t wn = enc(layout_default(PANEL_128x32), want);
    FILE *f = fopen("fixtures/layouts/default32.bin", "rb");
    if (f) { uint8_t b[LAYOUT_BLOB_MAX + 1]; size_t n = fread(b, 1, sizeof b, f); fclose(f);
             CHECK(n == wn && memcmp(b, want, n) == 0, "default32.bin == encode(default)"); }
}

int main(void) {
    RUN(defaults_decode_and_fit);
    RUN(the_128x32_default_is_todays_layout);
    RUN(sizes_are_fixed_and_scale);
    RUN(each_rule_is_enforced);
    RUN(garbage_never_decodes);
    RUN(why_is_always_terminated);
    RUN(fixtures_decode_as_named);
    return REPORT();
}
