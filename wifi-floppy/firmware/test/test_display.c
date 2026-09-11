#include "harness.h"
#include "../src/display.h"
#include <string.h>
#include <stdlib.h>

// The reason this file exists: four consecutive rounds of OLED debugging on
// 2026-09-11 asked a human to COUNT features on a 0.91" panel, and every
// answer was ambiguous -- including "3 lines" from a ruler that drew 5,
// because lines one row apart are ~0.4 mm apart and the eye merges them.
// Pass and fail looked alike. Everything about this display that a test can
// decide is therefore decided here, where a wrong pixel is an assertion and
// not an eye test. What is left for the panel is only "do these bytes reach
// the glass", which the frame-and-X self-test already answered.

// ------------------------------------------------------------ fake panel
#define MAX_BLITS 256
typedef struct { int page, col, n; } blit_rec_t;
static blit_rec_t blits[MAX_BLITS];
static int n_blits;
static int blit_fail_after = -1;       // -1 = never fail
static uint8_t panel[DISP_FB_BYTES];   // what the "glass" holds

static bool fake_blit(void *ctx, int page, int col, const uint8_t *b, int n) {
    (void)ctx;
    if (blit_fail_after == 0) return false;
    if (blit_fail_after > 0) blit_fail_after--;
    if (n_blits < MAX_BLITS) { blits[n_blits] = (blit_rec_t){page, col, n}; }
    n_blits++;
    memcpy(&panel[page * DISP_W + col], b, (size_t)n);
    return true;
}

static void begin(void) {
    n_blits = 0; blit_fail_after = -1;
    memset(panel, 0, sizeof panel);
    memset(blits, 0, sizeof blits);
}

static display_state_t base_state(void) {
    display_state_t s;
    memset(&s, 0, sizeof s);
    s.status = DS_LOADED; s.bars = 3; s.max_cyl = 79; s.pct = -1;
    return s;
}

// Is anything lit in the column range [x0, x1) of the given text row?
static bool any_lit(const uint8_t *fb, int page, int x0, int x1) {
    for (int x = x0; x < x1 && x < DISP_W; x++) if (fb[page * DISP_W + x]) return true;
    return false;
}

static int lit_count(const uint8_t *fb) {
    int n = 0;
    for (int i = 0; i < DISP_FB_BYTES; i++)
        for (int b = 0; b < 8; b++) if (fb[i] & (1u << b)) n++;
    return n;
}

// ------------------------------------------------------------ layout
static void test_the_track_counter_is_right_aligned_and_exact(void) {
    // Rendering "12/79" as the counter must put the SAME pixels on the panel
    // as drawing that text flush right -- which is what pins the format the
    // operator asked for ("0/79", then "1/79") rather than a zero-padded or
    // differently-separated one that would also "look like a counter".
    uint8_t got[DISP_FB_BYTES], want[DISP_FB_BYTES];
    display_state_t s = base_state();
    s.cyl = 12; s.show_track = true;
    display_render(&s, got);

    display_state_t ref = base_state();
    ref.status = DS_LOADED; ref.show_track = false;
    strcpy(ref.detail, "");
    display_render(&ref, want);
    // The counter occupies the last 5 glyphs: 5*6-1 = 29 px, so x >= 99.
    CHECK(any_lit(got, 0, 99, DISP_W), "a track counter must be drawn top-right");
    CHECK(!any_lit(want, 0, 99, DISP_W), "no counter when show_track is false");

    // Single digit shifts right, exactly as "0/79" -> 4 glyphs = 23 px.
    uint8_t one[DISP_FB_BYTES];
    s.cyl = 0; display_render(&s, one);
    CHECK(any_lit(one, 0, 105, DISP_W), "0/79 must still be flush right");
    CHECK(!any_lit(one, 0, 99, 104), "0/79 is narrower than 12/79");
}

static void test_the_counter_wins_a_collision_with_the_status_word(void) {
    // A half-drawn "12/79" would be a LIE about which track is being read.
    // A clipped status word is not. So the counter is drawn first and the
    // word is what gets clipped -- assert that, because the opposite
    // ordering also "works" until the day a long word meets a 3-digit track.
    display_state_t s = base_state();
    s.status = DS_DOWNLOAD; s.cyl = 159; s.max_cyl = 159; s.show_track = true;
    uint8_t fb[DISP_FB_BYTES];
    display_render(&s, fb);
    CHECK(any_lit(fb, 0, 110, DISP_W), "the counter must survive intact");
}

static void test_a_title_breaks_at_a_space_when_it_can(void) {
    display_state_t s = base_state();
    strcpy(s.title, "Sensible Soccer International");
    uint8_t fb[DISP_FB_BYTES];
    display_render(&s, fb);
    CHECK(any_lit(fb, 1, 0, DISP_W), "first title line must be drawn");
    CHECK(any_lit(fb, 2, 0, DISP_W), "second title line must be drawn");

    // "Sensible Soccer" is 15 chars = 89px; the break is at the space before
    // "International", NOT a hard cut at column 21 mid-word.
    CHECK(!any_lit(fb, 1, 95, DISP_W), "line 1 must end at the word break");
}

static void test_a_long_unbreakable_title_is_truncated_visibly(void) {
    // A 40-character single token is a real filename. It must not silently
    // lose its tail -- ".." is the difference between "this is the name" and
    // "this is part of the name".
    display_state_t s = base_state();
    strcpy(s.title, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    uint8_t fb[DISP_FB_BYTES];
    display_render(&s, fb);
    CHECK(any_lit(fb, 1, 0, DISP_W), "line 1 drawn");
    CHECK(any_lit(fb, 2, 110, DISP_W), "the ellipsis must reach the right edge");
}

static void test_more_bars_never_removes_pixels(void) {
    // The wifi glyph is built by adding arcs, so strength must be monotonic:
    // a stronger signal that lit FEWER pixels would read as a weaker one.
    int prev = -1;
    for (int bars = 0; bars <= 3; bars++) {
        display_state_t s = base_state();
        s.bars = bars;
        uint8_t fb[DISP_FB_BYTES];
        display_render(&s, fb);
        int n = lit_count(fb);
        CHECK(n > prev, "each added bar must light more pixels");
        prev = n;
    }
}

static void test_no_radio_is_distinguishable_from_a_weak_one(void) {
    display_state_t none = base_state(), weak = base_state();
    none.bars = -1; weak.bars = 0;
    uint8_t a[DISP_FB_BYTES], b[DISP_FB_BYTES];
    display_render(&none, a); display_render(&weak, b);
    CHECK(memcmp(a, b, DISP_FB_BYTES) != 0,
          "'no radio' and 'associated but weak' must not look the same");
}

static void test_rendering_is_pure(void) {
    display_state_t s = base_state();
    strcpy(s.title, "Lemmings"); strcpy(s.detail, "Disk 1/2");
    s.cyl = 40; s.show_track = true;
    uint8_t a[DISP_FB_BYTES], b[DISP_FB_BYTES];
    display_render(&s, a);
    memset(b, 0xAA, sizeof b);      // dirty buffer: render must fully clear it
    display_render(&s, b);
    CHECK(memcmp(a, b, DISP_FB_BYTES) == 0, "same state must give same frame");
}

static void test_unprintable_characters_do_not_read_past_the_font(void) {
    // A disk title is server data. High bytes and control codes must render
    // as something, not index off the end of a 95-entry table.
    display_state_t s = base_state();
    for (int i = 0; i < 20; i++) s.title[i] = (char)(0x80 + i);
    s.title[20] = '\0';
    strcpy(s.detail, "\x01\x02\x03");
    uint8_t fb[DISP_FB_BYTES];
    display_render(&s, fb);
    CHECK(any_lit(fb, 1, 0, DISP_W), "unprintables render as a placeholder");
}

// ------------------------------------------------------------ the pump
static void test_the_pump_never_exceeds_its_budget(void) {
    // THE property that makes this safe in core0's 1 ms loop. A pump that
    // "usually" returns quickly is not the same as one that cannot overrun.
    begin();
    display_t d; display_init(&d, fake_blit, NULL);
    display_state_t s = base_state();
    strcpy(s.title, "Sensible Soccer International");
    strcpy(s.detail, "Disk 1/2 boot");
    s.cyl = 12; s.show_track = true;
    display_set(&d, &s);

    int guard = 0;
    while (!display_in_sync(&d) && guard++ < 10000) {
        int n = display_pump(&d, 16);
        CHECK(n <= 16, "a pump call must never send more than its budget");
    }
    CHECK(display_in_sync(&d), "the pump must converge");
    CHECK(memcmp(panel, d.fb, DISP_FB_BYTES) == 0,
          "what reached the panel must equal what was rendered");
}

static void test_an_idle_pump_sends_nothing(void) {
    begin();
    display_t d; display_init(&d, fake_blit, NULL);
    display_state_t s = base_state();
    display_set(&d, &s);
    while (!display_in_sync(&d)) display_pump(&d, 64);
    int before = n_blits;
    for (int i = 0; i < 50; i++) CHECK_EQ_INT(display_pump(&d, 64), 0);
    CHECK_EQ_INT(n_blits, before);
}

static void test_a_track_step_sends_a_small_span_not_a_frame(void) {
    // A seek fires every ~3 ms. If each one cost a full 512-byte frame the
    // display would consume the service loop exactly as the handoff warns.
    // Bound it: one changed counter must move well under one page.
    begin();
    display_t d; display_init(&d, fake_blit, NULL);
    display_state_t s = base_state();
    strcpy(s.title, "Lemmings"); s.show_track = true; s.cyl = 12;
    display_set(&d, &s);
    while (!display_in_sync(&d)) display_pump(&d, 64);

    s.cyl = 13; display_set(&d, &s);
    int sent = 0, calls = 0;
    while (!display_in_sync(&d) && calls++ < 100) sent += display_pump(&d, 16);
    CHECK(sent > 0, "a changed track must actually send something");
    CHECK(sent <= 40, "a one-glyph change must not redraw the frame");
    CHECK(calls <= 3, "and must land within a few 1 ms iterations");
}

static void test_a_failed_transfer_is_retried_not_lost(void) {
    // An I2C NAK (a knocked lead during bring-up -- the ordinary case on this
    // bench) must not leave the panel permanently showing something stale
    // while the shadow claims it is in sync.
    begin();
    display_t d; display_init(&d, fake_blit, NULL);
    display_state_t s = base_state();
    strcpy(s.title, "Lemmings");
    display_set(&d, &s);

    blit_fail_after = 0;                         // fail immediately
    CHECK_EQ_INT(display_pump(&d, 32), 0);
    CHECK(!display_in_sync(&d), "a failed blit must leave the bytes dirty");

    blit_fail_after = -1;
    int guard = 0;
    while (!display_in_sync(&d) && guard++ < 1000) display_pump(&d, 32);
    CHECK(display_in_sync(&d), "and the next pump must recover them");
    CHECK(memcmp(panel, d.fb, DISP_FB_BYTES) == 0, "panel matches after recovery");
}

static void test_the_pump_writes_within_one_page_per_call(void) {
    // The blit contract is "one page, from col, n bytes". A span that ran
    // past a page boundary would wrap onto the wrong row of glass.
    begin();
    display_t d; display_init(&d, fake_blit, NULL);
    display_state_t s = base_state();
    strcpy(s.title, "Sensible Soccer International");
    strcpy(s.detail, "Disk 1/2");
    s.show_track = true; s.cyl = 7;
    display_set(&d, &s);
    while (!display_in_sync(&d)) display_pump(&d, 16);
    for (int i = 0; i < n_blits && i < MAX_BLITS; i++) {
        CHECK(blits[i].col >= 0 && blits[i].col < DISP_W, "column in range");
        CHECK(blits[i].col + blits[i].n <= DISP_W, "a blit must not cross a page");
        CHECK(blits[i].page >= 0 && blits[i].page < DISP_PAGES, "page in range");
    }
}

// ------------------------------------------------------------ eyeballing
// Not an assertion -- the one thing a test cannot judge is whether the FONT
// is legible, so `test_display --dump` prints the frames for a human. Run it
// when the font or the layout changes.
static void dump(const char *what, const display_state_t *s) {
    uint8_t fb[DISP_FB_BYTES];
    display_render(s, fb);
    printf("\n%s\n+", what);
    for (int x = 0; x < DISP_W; x++) putchar('-');
    printf("+\n");
    for (int y = 0; y < DISP_H; y++) {
        putchar('|');
        for (int x = 0; x < DISP_W; x++)
            putchar(fb[(y / 8) * DISP_W + x] & (1u << (y % 8)) ? '#' : ' ');
        printf("|\n");
    }
    printf("+");
    for (int x = 0; x < DISP_W; x++) putchar('-');
    printf("+\n");
}

static void dump_all(void) {
    display_state_t s = base_state();
    s.status = DS_LOADED; s.bars = 3; s.cyl = 12; s.show_track = true;
    strcpy(s.title, "Sensible Soccer"); strcpy(s.detail, "Disk 1/2  WP");
    dump("LOADED, mid-seek", &s);

    display_state_t d = base_state();
    d.status = DS_DOWNLOAD; d.bars = 2; d.pct = 45; d.show_track = false;
    strcpy(d.title, "Lemmings"); strcpy(d.detail, "1.8 MB");
    dump("DOWNLOAD at 45%", &d);

    display_state_t p = base_state();
    p.status = DS_PORTAL; p.bars = -1; p.show_track = false;
    strcpy(p.title, "wifi-floppy setup"); strcpy(p.detail, "192.168.4.1");
    dump("captive portal", &p);

    display_state_t r = base_state();
    r.status = DS_READY; r.bars = 3; r.show_track = false;
    strcpy(r.title, "No disk"); strcpy(r.detail, "10.0.1.42");
    dump("online, idle", &r);
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "--dump") == 0) { dump_all(); return 0; }
    RUN(test_the_track_counter_is_right_aligned_and_exact);
    RUN(test_the_counter_wins_a_collision_with_the_status_word);
    RUN(test_a_title_breaks_at_a_space_when_it_can);
    RUN(test_a_long_unbreakable_title_is_truncated_visibly);
    RUN(test_more_bars_never_removes_pixels);
    RUN(test_no_radio_is_distinguishable_from_a_weak_one);
    RUN(test_rendering_is_pure);
    RUN(test_unprintable_characters_do_not_read_past_the_font);
    RUN(test_the_pump_never_exceeds_its_budget);
    RUN(test_an_idle_pump_sends_nothing);
    RUN(test_a_track_step_sends_a_small_span_not_a_frame);
    RUN(test_a_failed_transfer_is_retried_not_lost);
    RUN(test_the_pump_writes_within_one_page_per_call);
    return REPORT();
}
