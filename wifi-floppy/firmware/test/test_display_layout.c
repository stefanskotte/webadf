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
    {   // an element a later firmware added is skipped, the rest kept
        char why[64]; layout_t got;
        n = enc(&l, b); const uint8_t first = b[4]; b[4] = EL_LAST + 1; b[4 + 2] = 200; b[4 + 4] = 99;
        CHECK(layout_decode(b, n, &got, why, sizeof why), why);
        CHECK(got.n == l.n - 1, "the unknown element is dropped, every other one kept");
        bool any = false;
        for (int i = 0; i < got.n; i++) if (got.el[i].id == first) any = true;
        CHECK(!any, "the record it replaced is not there either");
        n = enc(&l, b); b[4] = EL_LAST + 1; b[4 + 8] = EL_LAST + 1;
        CHECK(layout_decode(b, n, &got, why, sizeof why), "two unknown ids are not 'listed twice'");
    }
    n = enc(&l, b); b[4] = 0;                expect_reject(b, n, "element id");
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

// 1.10.0: the NFC element is an 8x8 icon like write and lemming -- placed
// anywhere it fits, 1x or 2x, shown or hidden -- and in neither default, so a
// board with no custom layout draws what 1.9.x drew.
static void the_nfc_element(void) {
    layout_el_t e = { EL_NFC, 1, 1, 0, 0, 0, 0 }; int w, h;
    layout_el_size(&e, &w, &h); CHECK(w == 8 && h == 8, "nfc 8x8");
    e.scale = 2; layout_el_size(&e, &w, &h); CHECK(w == 16 && h == 16, "nfc 2x 16x16");

    for (int p = 0; p <= 1; p++) {
        const layout_t *d = layout_default((panel_t)p);
        for (int i = 0; i < d->n; i++) CHECK(d->el[i].id != EL_NFC, "no default lists the nfc element");
    }

    uint8_t b[LAYOUT_BLOB_MAX]; layout_t l = *layout_default(PANEL_128x32), out; char why[80] = "";
    l.el[l.n++] = (layout_el_t){ EL_NFC, 1, 1, 100, 0, 0, 0 };
    size_t n = enc(&l, b);
    CHECK(layout_decode(b, n, &out, why, sizeof why), why);
    CHECK(out.n == 9 && out.el[8].id == EL_NFC && out.el[8].x == 100 && out.el[8].visible, "nfc round-trips");

    l.el[8].visible = 0; n = enc(&l, b);
    CHECK(layout_decode(b, n, &out, why, sizeof why) && !out.el[8].visible, "a hidden nfc element is valid");

    l.el[8] = (layout_el_t){ EL_NFC, 1, 2, 112, 16, 0, 0 }; n = enc(&l, b);   // 2x: 112..127 x 16..31
    CHECK(layout_decode(b, n, &out, why, sizeof why) && out.el[8].scale == 2, "2x in the corner fits");
    l.el[8].x = 114; n = enc(&l, b);                                         expect_reject(b, n, "outside");
    l.el[8] = (layout_el_t){ EL_NFC, 1, 1, 121, 0, 0, 0 }; n = enc(&l, b);  expect_reject(b, n, "outside");
    l.el[8] = (layout_el_t){ EL_NFC, 1, 1, 100, 0, 4, 0 }; n = enc(&l, b);  expect_reject(b, n, "w must be 0");
    l.el[8] = (layout_el_t){ EL_NFC, 1, 1, 100, 0, 0, 1 }; n = enc(&l, b);  expect_reject(b, n, "opt must be 0");
    l.el[8] = (layout_el_t){ EL_NFC, 1, 1, 100, 0, 0, 0 };
    l.el[l.n++] = (layout_el_t){ EL_NFC, 0, 1, 0, 24, 0, 0 }; n = enc(&l, b); expect_reject(b, n, "twice");
}

// 1.17.0: the head position, "cylinder.side" (FlashFloppy's "40.1") -- a
// fixed four-character box like the track counter's, placed like any other
// element, in neither default.
static void the_head_element(void) {
    CHECK(EL_HEAD > EL_NFC, "a new id, after every id 1.16 knows: 1.10-1.16 skip it");
    layout_el_t e = { EL_HEAD, 1, 1, 0, 0, 0, 0 }; int w, h;
    layout_el_size(&e, &w, &h); CHECK(w == 24 && h == 8, "head 24x8 (\"99.1\")");
    e.scale = 2; layout_el_size(&e, &w, &h); CHECK(w == 48 && h == 16, "head 2x 48x16");
    for (int p = 0; p <= 1; p++) {
        const layout_t *d = layout_default((panel_t)p);
        for (int i = 0; i < d->n; i++) CHECK(d->el[i].id != EL_HEAD, "no default lists the head element");
    }
    uint8_t b[LAYOUT_BLOB_MAX]; layout_t l = *layout_default(PANEL_128x32), out; char why[80] = "";
    l.el[l.n++] = (layout_el_t){ EL_HEAD, 1, 1, 104, 24, 0, 0 };
    size_t n = enc(&l, b);
    CHECK(layout_decode(b, n, &out, why, sizeof why), why);
    CHECK(out.n == 9 && out.el[8].id == EL_HEAD && out.el[8].x == 104 && out.el[8].y == 24, "head round-trips");
    l.el[8].x = 105; n = enc(&l, b);                                          expect_reject(b, n, "outside");
    l.el[8] = (layout_el_t){ EL_HEAD, 1, 1, 0, 0, 3, 0 }; n = enc(&l, b);    expect_reject(b, n, "w must be 0");
    l.el[8] = (layout_el_t){ EL_HEAD, 1, 1, 0, 0, 0, 1 }; n = enc(&l, b);    expect_reject(b, n, "opt must be 0");
}

// 1.17.0: the panel's rotation rides in the layout blob as a SETTING record
// (id REC_ROTATION, not an element): [id][0][0][0][0][quarter turns][0][0].
// Boards on 1.10.0-1.16.x skip any id above EL_NFC, so an older board shows
// the layout unrotated instead of refusing it; 1.7.1-1.9.x refuse any unknown
// id, which is why the web app sends rotation only to 1.17.0+.
static void the_rotation_record(void) {
    CHECK(REC_ROTATION > EL_LAST, "not an element id; 1.10-1.16 skip it");
    CHECK(REC_ROTATION != EL_LAST + 1, "and not the next element's id either");
    uint8_t b[LAYOUT_BLOB_MAX]; layout_t l = *layout_default(PANEL_128x64), out; char why[80] = "";
    uint8_t d[LAYOUT_BLOB_MAX]; size_t dn = enc(layout_default(PANEL_128x64), d);
    CHECK_EQ_INT(layout_rotation(d, dn), LAYOUT_ROT_0);  // the defaults are not rotated
    size_t n = (size_t)layout_encode_rotated(&l, LAYOUT_ROT_180, b, sizeof b);
    CHECK_EQ_INT(n, 4 + 8 * (l.n + 1));
    CHECK_EQ_INT(b[2], l.n + 1);                        // the header counts every record
    const uint8_t *r = b + 4 + 8 * l.n;                 // appended after the elements
    CHECK(r[0] == REC_ROTATION && r[1] == 0 && r[2] == 0 && r[3] == 0 && r[4] == 0 &&
          r[5] == LAYOUT_ROT_180 && r[6] == 0 && r[7] == 0, "the record's bytes");
    CHECK(layout_decode(b, n, &out, why, sizeof why), why);
    CHECK_EQ_INT(layout_rotation(b, n), LAYOUT_ROT_180);
    CHECK_EQ_INT(out.n, l.n);                           // not an element: not drawn, not counted
    for (int i = 0; i < out.n; i++) CHECK(out.el[i].id != REC_ROTATION, "never in el[]");

    n = (size_t)layout_encode_rotated(&l, LAYOUT_ROT_0, b, sizeof b);
    CHECK_EQ_INT(n, 4 + 8 * l.n);                       // unrotated: no record, the 1.16 bytes exactly
    CHECK(n == dn && memcmp(b, d, n) == 0, "== layout_encode");
    CHECK(layout_decode(b, n, &out, why, sizeof why) && layout_rotation(b, n) == LAYOUT_ROT_0, "no record = 0");

    // A rotation-only layout (no elements) is valid; anywhere in the list.
    uint8_t only[12] = { 1, 0, 1, 0, REC_ROTATION, 0, 0, 0, 0, LAYOUT_ROT_180, 0, 0 };
    CHECK(layout_decode(only, sizeof only, &out, why, sizeof why) && out.n == 0, why);
    CHECK_EQ_INT(layout_rotation(only, sizeof only), LAYOUT_ROT_180);

    n = (size_t)layout_encode_rotated(&l, LAYOUT_ROT_180, b, sizeof b); r = b + 4 + 8 * l.n;
    uint8_t c[LAYOUT_BLOB_MAX];
    memcpy(c, b, n); c[4 + 8 * l.n + 5] = 0;            CHECK(layout_decode(c, n, &out, why, sizeof why) && layout_rotation(c, n) == 0, "an explicit 0 is fine");
    memcpy(c, b, n); c[4 + 8 * l.n + 5] = 1;            expect_reject(c, n, "rotation");
    memcpy(c, b, n); c[4 + 8 * l.n + 5] = 3;            expect_reject(c, n, "rotation");
    memcpy(c, b, n); c[4 + 8 * l.n + 1] = 1;            expect_reject(c, n, "rotation");
    memcpy(c, b, n); c[4 + 8 * l.n + 2] = 4;            expect_reject(c, n, "rotation");
    memcpy(c, b, n); c[4 + 8 * l.n + 6] = 1;            expect_reject(c, n, "reserved");
    {   // listed twice
        uint8_t two[20] = { 1, 0, 2, 0, REC_ROTATION, 0, 0, 0, 0, 2, 0, 0, REC_ROTATION, 0, 0, 0, 0, 2, 0, 0 };
        expect_reject(two, sizeof two, "twice");
    }
    (void)r;
}

// The fixture the web app's encoder must reproduce byte for byte: the 128x32
// default, rotated, with the head element shown in the track's place (track hidden).
static void head_and_rotation_fixture(void) {
    FILE *f = fopen("fixtures/layouts/custom32_head_rot180.bin", "rb"); CHECK(f != NULL, "fixture"); if (!f) return;
    uint8_t b[LAYOUT_BLOB_MAX + 1]; size_t n = fread(b, 1, sizeof b, f); fclose(f);
    layout_t l; char why[80] = "";
    CHECK(layout_decode(b, n, &l, why, sizeof why), why);
    CHECK_EQ_INT(layout_rotation(b, n), LAYOUT_ROT_180);
    bool head = false;
    for (int i = 0; i < l.n; i++) if (l.el[i].id == EL_HEAD && l.el[i].visible) head = true;
    CHECK(head, "head shown");
}

static void garbage_never_decodes(void) {
    uint8_t b[LAYOUT_BLOB_MAX + 8] = {0}; layout_t l; char why[80];   // len 0/3 reads nothing; GCC cannot know
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
    const char *ok[] = { "default32", "default64", "custom64", "custom32_nfc" };
    const char *bad[][2] = { { "bad_bounds", "outside" }, { "bad_dup", "twice" }, { "bad_reserved", "reserved" } };
    for (int i = 0; i < 4; i++) {
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
    RUN(the_nfc_element);
    RUN(the_head_element);
    RUN(the_rotation_record);
    RUN(head_and_rotation_fixture);
    RUN(garbage_never_decodes);
    RUN(why_is_always_terminated);
    RUN(fixtures_decode_as_named);
    return REPORT();
}
