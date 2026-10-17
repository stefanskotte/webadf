// wifi-floppy/firmware/test/test_display_icons.c
//
// The status element as an 8x8 icon instead of the word (1.15.0): the layout
// option that selects it, the pictures themselves, the blink, the built-in
// screens, and goldens on both panels. A separate file from
// test_display_golden.c on purpose: those goldens are the word's, and staying
// byte-identical is the proof that a layout without the option draws exactly
// what it drew before.
#include "harness.h"
#include "../src/display.h"
#include "../src/display_layout.h"
#include <stdlib.h>
#include <string.h>

static bool on(const uint8_t *fb, int x, int y) { return (fb[(y / 8) * DISP_W + x] >> (y % 8)) & 1u; }

static int lit(const uint8_t *fb, int x0, int y0, int x1, int y1) {
    int n = 0;
    for (int y = y0; y < y1; y++) for (int x = x0; x < x1; x++) if (on(fb, x, y)) n++;
    return n;
}

static display_state_t st(disp_status_t status) {
    display_state_t s;
    memset(&s, 0, sizeof s);
    s.status = status; s.bars = 3; s.max_cyl = 79; s.pct = -1;
    return s;
}

/** The panel's default with its status element switched to the icon. */
static layout_t icon_default(panel_t p) {
    layout_t l = *layout_default(p);
    for (int i = 0; i < l.n; i++) if (l.el[i].id == EL_STATUS) l.el[i].opt = STATUS_OPT_ICON;
    return l;
}

static size_t enc(const layout_t *l, uint8_t *b) { return (size_t)layout_encode(l, b, LAYOUT_BLOB_MAX); }

// ---------------------------------------------------------------- the option
static void the_option_decodes_and_sizes_the_box(void) {
    uint8_t b[LAYOUT_BLOB_MAX]; layout_t out; char why[80] = "";
    layout_t l = icon_default(PANEL_128x32);
    size_t n = enc(&l, b);
    CHECK(layout_decode(b, n, &out, why, sizeof why), why);
    int si = -1; for (int i = 0; i < out.n; i++) if (out.el[i].id == EL_STATUS) si = i;
    CHECK(si >= 0 && out.el[si].opt == STATUS_OPT_ICON, "the icon option round-trips");

    layout_el_t e = { EL_STATUS, 1, 1, 0, 0, 0, STATUS_OPT_ICON }; int w, h;
    layout_el_size(&e, &w, &h); CHECK_EQ_INT(w, 8); CHECK_EQ_INT(h, 8);
    e.scale = 2; layout_el_size(&e, &w, &h); CHECK_EQ_INT(w, 16); CHECK_EQ_INT(h, 16);
    e.scale = 1; e.opt = STATUS_OPT_WORD; layout_el_size(&e, &w, &h); CHECK_EQ_INT(w, 48); CHECK_EQ_INT(h, 8);

    // The point of the icon is the room it saves: it fits where the word cannot.
    layout_t one = { PANEL_128x32, 1, { { EL_STATUS, 1, 1, 120, 24, 0, STATUS_OPT_ICON } } };
    n = enc(&one, b); CHECK(layout_decode(b, n, &out, why, sizeof why), "icon in the corner fits");
    one.el[0].opt = STATUS_OPT_WORD; n = enc(&one, b);
    CHECK(!layout_decode(b, n, &out, why, sizeof why) && strstr(why, "outside"), "the word there does not");
    one.el[0] = (layout_el_t){ EL_STATUS, 1, 1, 121, 0, 0, STATUS_OPT_ICON }; n = enc(&one, b);
    CHECK(!layout_decode(b, n, &out, why, sizeof why) && strstr(why, "outside"), "one past the edge is refused");
    one.el[0] = (layout_el_t){ EL_STATUS, 1, 1, 0, 0, 4, STATUS_OPT_ICON }; n = enc(&one, b);
    CHECK(!layout_decode(b, n, &out, why, sizeof why) && strstr(why, "w must be 0"), "w is still 0");

    // An option this firmware does not know (a later one's) draws the word,
    // sized as the word -- never a refusal of the whole layout.
    one.el[0] = (layout_el_t){ EL_STATUS, 1, 1, 14, 0, 0, 7 }; n = enc(&one, b);
    CHECK(layout_decode(b, n, &out, why, sizeof why), why);
    layout_el_size(&out.el[0], &w, &h); CHECK_EQ_INT(w, 48);
    display_state_t s = st(DS_READY);
    uint8_t a[DISP_FB_MAX], c[DISP_FB_MAX];
    display_render(&s, &out, a);
    one.el[0].opt = STATUS_OPT_WORD; display_render(&s, &one, c);
    CHECK(memcmp(a, c, sizeof a) == 0, "an unknown option draws the word");

    for (int p = 0; p <= 1; p++) {
        const layout_t *d = layout_default((panel_t)p);
        for (int i = 0; i < d->n; i++)
            if (d->el[i].id == EL_STATUS) CHECK(d->el[i].opt == STATUS_OPT_WORD, "the defaults keep the word");
        // The icon's built-in screens are the word's, element for element,
        // but for the status option.
        const layout_t *bw = layout_builtin((panel_t)p), *bi = layout_builtin_icon((panel_t)p);
        CHECK(bw->panel == bi->panel && bw->n == bi->n, "same built-in shape");
        for (int i = 0; i < bw->n && i < bi->n; i++) {
            layout_el_t x = bi->el[i];
            if (x.id == EL_STATUS) { CHECK(x.opt == STATUS_OPT_ICON, "built-in icon"); x.opt = STATUS_OPT_WORD; }
            CHECK(memcmp(&x, &bw->el[i], sizeof x) == 0, "built-in element");
        }
    }
}

// ---------------------------------------------------------------- the pictures
typedef struct { disp_status_t s; const char *rows[8]; } picture_t;

// What each state draws, row by row ('#' lit). The blinking two (WIFI, ERROR)
// are listed in their first phase here and their second in BLINK_OFF.
// DOWNLOAD is not here: its picture depends on the percent (DOWNLOAD_FILL).
static const picture_t PICTURES[] = {
    { DS_BOOT,     { "########", ".#....#.", "..#..#..", "...##...", "...##...", "..####..", ".######.", "########" } },
    { DS_PORTAL,   { ".#....#.", "#..##..#", "#..##..#", ".#.##.#.", "...##...", "...##...", "..####..", ".######." } },
    { DS_WIFI,     { ".######.", "#......#", "..####..", ".#....#.", "...##...", "..#..#..", "........", "...##..." } },
    { DS_READY,    { "#######.", "#.#..#.#", "#.#..#.#", "#.####.#", "#......#", "#......#", "#......#", "########" } },
    { DS_VERIFY,   { ".####...", "#....#..", "#....#..", "#....#..", "#....#..", ".#####..", ".....##.", "......##" } },
    { DS_LOADED,   { "#######.", "##.##.##", "##.##.##", "########", "########", "##....##", "##....##", "########" } },
    { DS_ERROR,    { "...##...", "..#..#..", ".#.##.#.", ".#.##.#.", "#..##..#", "#......#", "#..##..#", "########" } },
};
static const picture_t BLINK_OFF[] = {
    // The arcs go out and the dot stays: blinking, never blank.
    { DS_WIFI,     { "........", "........", "........", "........", "........", "........", "........", "...##..." } },
    // The triangle fills and the mark is cut out of it: the same symbol, inverted.
    { DS_ERROR,    { "...##...", "..####..", ".##..##.", ".##..##.", "###..###", "########", "###..###", "########" } },
};

static void check_picture_pct(const picture_t *p, int tick, int pct) {
    layout_t l = { PANEL_128x32, 1, { { EL_STATUS, 1, 1, 40, 8, 0, STATUS_OPT_ICON } } };
    display_state_t s = st(p->s); s.tick = tick; s.pct = pct;
    uint8_t fb[DISP_FB_MAX]; display_render(&s, &l, fb);
    for (int r = 0; r < 8; r++) for (int c = 0; c < 8; c++)
        CHECK(on(fb, 40 + c, 8 + r) == (p->rows[r][c] == '#'), disp_status_word(p->s));
    CHECK_EQ_INT(lit(fb, 0, 0, 128, 32), lit(fb, 40, 8, 48, 16));   // nothing outside its box

    l.el[0].scale = 2;
    uint8_t big[DISP_FB_MAX]; display_render(&s, &l, big);
    for (int r = 0; r < 16; r++) for (int c = 0; c < 16; c++)
        CHECK(on(big, 40 + c, 8 + r) == (p->rows[r / 2][c / 2] == '#'), "2x block");
}

static void check_picture(const picture_t *p, int tick) { check_picture_pct(p, tick, -1); }

static void every_state_draws_its_picture(void) {
    for (size_t i = 0; i < sizeof PICTURES / sizeof PICTURES[0]; i++) check_picture(&PICTURES[i], 0);
    for (size_t i = 0; i < sizeof BLINK_OFF / sizeof BLINK_OFF[0]; i++) check_picture(&BLINK_OFF[i], DISP_BLINK_TICKS);
}

static void every_picture_is_distinct(void) {
    const size_t n = sizeof PICTURES / sizeof PICTURES[0];
    for (size_t i = 0; i < n; i++) for (size_t j = i + 1; j < n; j++) {
        bool same = true;
        for (int r = 0; r < 8; r++) if (strcmp(PICTURES[i].rows[r], PICTURES[j].rows[r]) != 0) same = false;
        CHECK(!same, "two states share a picture");
    }
}

// The blink is a function of the tick the state already carries (the
// lemming's), so a given frame is reproducible: DISP_BLINK_TICKS ticks of
// one phase, then as many of the other.
static void blink_follows_the_tick(void) {
    layout_t l = { PANEL_128x32, 1, { { EL_STATUS, 1, 1, 0, 0, 0, STATUS_OPT_ICON } } };
    const disp_status_t all[] = { DS_BOOT, DS_PORTAL, DS_WIFI, DS_READY, DS_DOWNLOAD, DS_VERIFY, DS_LOADED, DS_ERROR };
    for (size_t k = 0; k < sizeof all / sizeof all[0]; k++) {
        const bool blinks = all[k] == DS_WIFI || all[k] == DS_ERROR;
        display_state_t s = st(all[k]);
        uint8_t first[DISP_FB_MAX], fb[DISP_FB_MAX];
        s.tick = 0; display_render(&s, &l, first);
        for (int t = 0; t < 4 * DISP_BLINK_TICKS; t++) {
            s.tick = t; display_render(&s, &l, fb);
            const bool phase_a = (t / DISP_BLINK_TICKS) % 2 == 0;
            const bool same = memcmp(fb, first, sizeof fb) == 0;
            CHECK(same == (!blinks || phase_a), disp_status_word(all[k]));
            CHECK(lit(fb, 0, 0, 8, 8) > 0, "never blank");
        }
        // A tick from a long-running board (it is clock_ms / 120, so it wraps
        // negative after ~8 years) still renders one of the two phases.
        s.tick = -1; display_render(&s, &l, fb);
        CHECK(lit(fb, 0, 0, 8, 8) > 0, "negative tick");
    }
    // ~1 Hz on the board: main.c advances the tick every 120 ms.
    CHECK(DISP_BLINK_TICKS * 120 >= 400 && DISP_BLINK_TICKS * 120 <= 600, "about a second a cycle");
}

// The status word's own pictures stay the word when the option is off: the
// blink never reaches it.
static void the_word_does_not_blink(void) {
    layout_t l = { PANEL_128x32, 1, { { EL_STATUS, 1, 1, 0, 0, 0, STATUS_OPT_WORD } } };
    display_state_t s = st(DS_ERROR);
    uint8_t a[DISP_FB_MAX], b[DISP_FB_MAX];
    s.tick = 0; display_render(&s, &l, a);
    s.tick = DISP_BLINK_TICKS; display_render(&s, &l, b);
    CHECK(memcmp(a, b, sizeof a) == 0, "ERROR as a word is steady");
}

// ---------------------------------------------------------------- built-in screens
// Boot, setup, connecting and error are drawn with the built-in layout, never
// the user's -- but the user's CHOICE of icon carries over to their status
// element, or four of the eight icons would never be seen.
static void built_in_screens_follow_the_choice(void) {
    for (int p = 0; p <= 1; p++) {
        const layout_t icon = icon_default((panel_t)p);
        const layout_t *word = layout_default((panel_t)p);
        const disp_status_t sts[] = { DS_BOOT, DS_PORTAL, DS_WIFI, DS_ERROR };
        for (int k = 0; k < 4; k++) {
            display_state_t s = st(sts[k]); strcpy(s.title, "wifi-floppy"); strcpy(s.detail, "starting");
            const layout_t *li = display_layout_for(&s, &icon);
            CHECK(li != &icon, "a built-in screen, not the custom layout");
            uint8_t a[DISP_FB_MAX], b[DISP_FB_MAX];
            display_render(&s, li, a);
            display_render(&s, display_layout_for(&s, word), b);
            // The icon at the status element's place (14, 0), the word's room
            // past it dark, and every other row exactly the word layout's.
            const picture_t *pic = NULL;
            for (size_t i = 0; i < sizeof PICTURES / sizeof PICTURES[0]; i++) if (PICTURES[i].s == sts[k]) pic = &PICTURES[i];
            for (int r = 0; r < 8; r++) for (int c = 0; c < 8; c++)
                CHECK(on(a, 14 + c, r) == (pic->rows[r][c] == '#'), "built-in icon");
            CHECK_EQ_INT(lit(a, 22, 0, 62, 8), 0);
            CHECK(memcmp(a + DISP_W, b + DISP_W, DISP_FB_MAX - DISP_W) == 0, "rows below the status row unchanged");
        }
        // Hidden in the user's layout, still an icon on the built-in screens:
        // the built-in screens always show their status.
        layout_t hidden = icon;
        for (int i = 0; i < hidden.n; i++) if (hidden.el[i].id == EL_STATUS) hidden.el[i].visible = 0;
        display_state_t s = st(DS_BOOT);
        CHECK(display_layout_for(&s, &hidden) == display_layout_for(&s, &icon), "visibility does not change the built-in");
        // The word layout's built-in screens are the ones they always were.
        CHECK(display_layout_for(&s, word) == layout_builtin((panel_t)p), "word: the old built-in");
    }
}

// ---------------------------------------------------------------- download
// DOWNLOAD is the floppy filling up: READY's outline at 0 %, LOADED's filled
// floppy at 100 %, and between them the six interior rows (1..6) taken from
// LOADED bottom-up, one row per sixth of the percent, rounded down -- so the
// floppy is whole only when the download is. Rows 0 and 7 are the same in
// both pictures.
static const picture_t DOWNLOAD_FILL[7] = {
    { DS_DOWNLOAD, { "#######.", "#.#..#.#", "#.#..#.#", "#.####.#", "#......#", "#......#", "#......#", "########" } },
    { DS_DOWNLOAD, { "#######.", "#.#..#.#", "#.#..#.#", "#.####.#", "#......#", "#......#", "##....##", "########" } },
    { DS_DOWNLOAD, { "#######.", "#.#..#.#", "#.#..#.#", "#.####.#", "#......#", "##....##", "##....##", "########" } },
    { DS_DOWNLOAD, { "#######.", "#.#..#.#", "#.#..#.#", "#.####.#", "########", "##....##", "##....##", "########" } },
    { DS_DOWNLOAD, { "#######.", "#.#..#.#", "#.#..#.#", "########", "########", "##....##", "##....##", "########" } },
    { DS_DOWNLOAD, { "#######.", "#.#..#.#", "##.##.##", "########", "########", "##....##", "##....##", "########" } },
    { DS_DOWNLOAD, { "#######.", "##.##.##", "##.##.##", "########", "########", "##....##", "##....##", "########" } },
};

static const picture_t *picture_of(disp_status_t st) {
    for (size_t i = 0; i < sizeof PICTURES / sizeof PICTURES[0]; i++) if (PICTURES[i].s == st) return &PICTURES[i];
    return NULL;
}

static bool same_rows(const picture_t *a, const picture_t *b) {
    for (int r = 0; r < 8; r++) if (strcmp(a->rows[r], b->rows[r]) != 0) return false;
    return true;
}

static void download_fills_the_floppy(void) {
    // The ends are the two floppies the user already knows.
    CHECK(same_rows(&DOWNLOAD_FILL[0], picture_of(DS_READY)), "0 % is READY's outline");
    CHECK(same_rows(&DOWNLOAD_FILL[6], picture_of(DS_LOADED)), "100 % is LOADED's floppy");
    // pct -> filled rows: pct * 6 / 100, clamped; an unknown percent (-1) is
    // the empty outline, a past-the-end one the full floppy.
    for (int pct = -5; pct <= 110; pct++) {
        const int c = pct < 0 ? 0 : pct > 100 ? 100 : pct;
        check_picture_pct(&DOWNLOAD_FILL[c * 6 / 100], 0, pct);
    }
    // The steps it lands on.
    const int at[][2] = { {0,0}, {16,0}, {17,1}, {25,1}, {33,1}, {34,2}, {49,2}, {50,3}, {66,3},
                          {67,4}, {75,4}, {83,4}, {84,5}, {99,5}, {100,6} };
    for (size_t i = 0; i < sizeof at / sizeof at[0]; i++) check_picture_pct(&DOWNLOAD_FILL[at[i][1]], 0, at[i][0]);
    // Monotonic: the step drawn never goes down as the percent goes up.
    layout_t l = { PANEL_128x32, 1, { { EL_STATUS, 1, 1, 0, 0, 0, STATUS_OPT_ICON } } };
    int last = -1;
    for (int pct = 0; pct <= 100; pct++) {
        display_state_t s = st(DS_DOWNLOAD); s.pct = pct;
        uint8_t fb[DISP_FB_MAX]; display_render(&s, &l, fb);
        int filled = -1;
        for (int k = 0; k <= 6; k++) {
            bool match = true;
            for (int r = 0; r < 8; r++) for (int c = 0; c < 8; c++)
                if (on(fb, c, r) != (DOWNLOAD_FILL[k].rows[r][c] == '#')) match = false;
            if (match) filled = k;
        }
        CHECK(filled >= 0, "one of the seven steps");
        CHECK(filled >= last, "the fill never goes down as the percent goes up");
        last = filled;
    }
    CHECK_EQ_INT(last, 6);
    // Steady: a given percent is one picture whatever the tick.
    for (int pct = 0; pct <= 100; pct += 10) {
        display_state_t s = st(DS_DOWNLOAD); s.pct = pct;
        uint8_t a[DISP_FB_MAX], b[DISP_FB_MAX];
        s.tick = 0; display_render(&s, &l, a);
        for (int t = 1; t < 4 * DISP_BLINK_TICKS; t++) {
            s.tick = t; display_render(&s, &l, b);
            CHECK(memcmp(a, b, sizeof a) == 0, "no blink while downloading");
        }
    }
}

// The percent is the download element's, as it always was: the icon replaces
// the word and nothing else.
static void download_keeps_its_percent(void) {
    for (int p = 0; p <= 1; p++) {
        const layout_t icon = icon_default((panel_t)p);
        display_state_t s = st(DS_DOWNLOAD); strcpy(s.title, "Workbench 3.1 Install"); s.pct = 64;
        uint8_t a[DISP_FB_MAX], b[DISP_FB_MAX];
        display_render(&s, &icon, a);
        display_render(&s, layout_default((panel_t)p), b);
        CHECK(memcmp(a + DISP_W, b + DISP_W, DISP_FB_MAX - DISP_W) == 0, "percent and bar unchanged");
        CHECK_EQ_INT(lit(a, 22, 0, 62, 8), 0);
        for (int r = 0; r < 8; r++) for (int c = 0; c < 8; c++)
            CHECK(on(a, 14 + c, r) == (DOWNLOAD_FILL[3].rows[r][c] == '#'), "64 % fills three rows");
    }
}

// ---------------------------------------------------------------- goldens
// Every state on both panels, with the panel's default layout switched to the
// icon, plus the second phase of the two that blink. The files were written
// from this renderer (DISPLAY_GOLDEN_WRITE=1) after the pictures above passed,
// and checked by eye with test_display_icons --dump. The download goldens
// (64 %, and 0/50/100 %) were rewritten when DOWNLOAD became the filling
// floppy; every other file stayed byte-identical.
typedef struct { const char *name; display_state_t s; } golden_t;

static int golden_set(golden_t *g) {
    int n = 0; display_state_t s;
    s = st(DS_BOOT);    strcpy(s.title, "wifi-floppy"); strcpy(s.detail, "starting");        g[n++] = (golden_t){"icon_boot", s};
    s = st(DS_PORTAL);  strcpy(s.title, "Setup needed"); strcpy(s.detail, "wifi-floppy-6A38"); g[n++] = (golden_t){"icon_portal", s};
    s = st(DS_WIFI);    strcpy(s.title, "Connecting"); strcpy(s.detail, "HomeNet"); s.bars = 1; g[n++] = (golden_t){"icon_wifi", s};
    s.tick = DISP_BLINK_TICKS;                                                                g[n++] = (golden_t){"icon_wifi_blink", s};
    s = st(DS_READY);   strcpy(s.title, "no disk");                                           g[n++] = (golden_t){"icon_ready", s};
    s = st(DS_DOWNLOAD); strcpy(s.title, "Workbench 3.1 Install"); s.pct = 64;                g[n++] = (golden_t){"icon_download", s};
    s.pct = 0;                                                                                g[n++] = (golden_t){"icon_download_0", s};
    s.pct = 50;                                                                               g[n++] = (golden_t){"icon_download_50", s};
    s.pct = 100;                                                                              g[n++] = (golden_t){"icon_download_100", s};
    s = st(DS_VERIFY);  strcpy(s.title, "Turrican");                                          g[n++] = (golden_t){"icon_verify", s};
    s = st(DS_LOADED);  strcpy(s.title, "Workbench 3.1 Install"); strcpy(s.detail, "disk 1 of 6");
        s.show_track = true; s.cyl = 42; s.writable = true;                                   g[n++] = (golden_t){"icon_loaded", s};
    s = st(DS_ERROR);   strcpy(s.title, "no route"); s.bars = -1;                             g[n++] = (golden_t){"icon_error", s};
    s.tick = DISP_BLINK_TICKS;                                                                g[n++] = (golden_t){"icon_error_blink", s};
    return n;
}

static void render_icon(const display_state_t *s, panel_t p, uint8_t fb[DISP_FB_MAX]) {
    const layout_t l = icon_default(p);
    display_render(s, display_layout_for(s, &l), fb);
}

static void icon_goldens_match(void) {
    golden_t g[16]; const int n = golden_set(g);
    const bool write = getenv("DISPLAY_GOLDEN_WRITE") != NULL;
    for (int p = 0; p <= 1; p++) for (int i = 0; i < n; i++) {
        const size_t bytes = (size_t)panel_height((panel_t)p) * DISP_W / 8;
        uint8_t fb[DISP_FB_MAX]; render_icon(&g[i].s, (panel_t)p, fb);
        for (size_t k = bytes; k < DISP_FB_MAX; k++) CHECK(fb[k] == 0, "nothing below the panel");
        char path[128];
        snprintf(path, sizeof path, "fixtures/display_golden/%s_%s.fb", g[i].name, p ? "64" : "32");
        if (write) {
            FILE *f = fopen(path, "wb"); CHECK(f != NULL, path);
            if (f) { fwrite(fb, 1, bytes, f); fclose(f); }
            continue;
        }
        uint8_t want[DISP_FB_MAX]; FILE *f = fopen(path, "rb"); CHECK(f != NULL, path);
        if (!f) continue;
        size_t got = fread(want, 1, sizeof want, f); fclose(f);
        CHECK(got == bytes, path);
        CHECK(memcmp(fb, want, bytes) == 0, path);
    }
}

// For a human: every golden as ASCII. `test_display_icons --dump`.
static void dump_all(void) {
    golden_t g[16]; const int n = golden_set(g);
    for (int p = 0; p <= 1; p++) for (int i = 0; i < n; i++) {
        uint8_t fb[DISP_FB_MAX]; render_icon(&g[i].s, (panel_t)p, fb);
        printf("%s_%s\n", g[i].name, p ? "64" : "32");
        for (int y = 0; y < panel_height((panel_t)p); y++) {
            for (int x = 0; x < DISP_W; x++) putchar(on(fb, x, y) ? '#' : '.');
            putchar('\n');
        }
    }
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "--dump") == 0) { dump_all(); return 0; }
    RUN(the_option_decodes_and_sizes_the_box);
    RUN(every_state_draws_its_picture);
    RUN(every_picture_is_distinct);
    RUN(blink_follows_the_tick);
    RUN(the_word_does_not_blink);
    RUN(built_in_screens_follow_the_choice);
    RUN(download_fills_the_floppy);
    RUN(download_keeps_its_percent);
    RUN(icon_goldens_match);
    return REPORT();
}
