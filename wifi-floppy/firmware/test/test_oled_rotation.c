// wifi-floppy/firmware/test/test_oled_rotation.c
//
// 1.17.0: the panel turned 180 degrees, for a board mounted upside down. The
// board does it in the CONTROLLER (segment remap 0xA0/0xA1 and COM scan
// direction 0xC0/0xC8, the same two commands on the SSD1306 and the SH1106),
// so the framebuffer display.c renders never changes. What these tests judge:
//   - the init command sequences (oled_cmds.c), byte for byte: unrotated they
//     are exactly what 1.16 sent, rotated they differ in those two bytes only;
//   - the GLASS: a model of what the controller shows for a RAM image under a
//     command stream. The rotated glass is golden-checked on both panels and
//     must equal display_rotate180() of the framebuffer -- the function the
//     web preview (display.wasm) uses, so the preview is the glass.
#include "harness.h"
#include "../src/display.h"
#include "../src/display_layout.h"
#include "../src/oled_cmds.h"
#include <stdlib.h>
#include <string.h>

// ---- the sequences 1.16.1 sent (ssd1306.c send_init_sequence), copied
// literally: the unrotated output must stay exactly this.
static const uint8_t SSD1306_32[] = { 0xAE, 0xD5, 0x80, 0xA8, 31, 0xD3, 0x00, 0x40, 0x8D, 0x14, 0x20, 0x02,
    0xA1, 0xC8, 0xDA, 0x02, 0x81, 0xCF, 0xD9, 0xF1, 0xDB, 0x40, 0xA4, 0xA6, 0xAF };
static const uint8_t SSD1306_64[] = { 0xAE, 0xD5, 0x80, 0xA8, 63, 0xD3, 0x00, 0x40, 0x8D, 0x14, 0x20, 0x02,
    0xA1, 0xC8, 0xDA, 0x12, 0x81, 0xCF, 0xD9, 0xF1, 0xDB, 0x40, 0xA4, 0xA6, 0xAF };
static const uint8_t SH1106_32[] = { 0xAE, 0xD5, 0x80, 0xA8, 31, 0xD3, 0x00, 0x40, 0xAD, 0x8B,
    0xA1, 0xC8, 0xDA, 0x02, 0x81, 0xCF, 0xD9, 0x22, 0xDB, 0x35, 0xA4, 0xA6, 0xAF };
static const uint8_t SH1106_64[] = { 0xAE, 0xD5, 0x80, 0xA8, 63, 0xD3, 0x00, 0x40, 0xAD, 0x8B,
    0xA1, 0xC8, 0xDA, 0x12, 0x81, 0xCF, 0xD9, 0x22, 0xDB, 0x35, 0xA4, 0xA6, 0xAF };

typedef struct { bool sh; panel_t p; const uint8_t *want; size_t n; const char *name; } seq_case_t;
static const seq_case_t SEQS[] = {
    { false, PANEL_128x32, SSD1306_32, sizeof SSD1306_32, "SSD1306 128x32" },
    { false, PANEL_128x64, SSD1306_64, sizeof SSD1306_64, "SSD1306 128x64" },
    { true,  PANEL_128x32, SH1106_32,  sizeof SH1106_32,  "SH1106 128x32" },
    { true,  PANEL_128x64, SH1106_64,  sizeof SH1106_64,  "SH1106 128x64" },
};

static void unrotated_sequences_are_1_16s(void) {
    for (size_t k = 0; k < sizeof SEQS / sizeof SEQS[0]; k++) {
        uint8_t got[OLED_INIT_MAX];
        const int n = oled_init_cmds(SEQS[k].sh, SEQS[k].p, LAYOUT_ROT_0, got, sizeof got);
        CHECK_EQ_INT(n, (long)SEQS[k].n);
        CHECK(n == (int)SEQS[k].n && memcmp(got, SEQS[k].want, SEQS[k].n) == 0, SEQS[k].name);
    }
}

static void rotated_sequences_differ_in_remap_and_scan_only(void) {
    for (size_t k = 0; k < sizeof SEQS / sizeof SEQS[0]; k++) {
        uint8_t got[OLED_INIT_MAX];
        const int n = oled_init_cmds(SEQS[k].sh, SEQS[k].p, LAYOUT_ROT_180, got, sizeof got);
        CHECK(n == (int)SEQS[k].n, SEQS[k].name);
        int diffs = 0;
        for (int i = 0; i < n && i < (int)SEQS[k].n; i++) {
            if (got[i] == SEQS[k].want[i]) continue;
            diffs++;
            const bool ok = (SEQS[k].want[i] == 0xA1 && got[i] == 0xA0) || (SEQS[k].want[i] == 0xC8 && got[i] == 0xC0);
            CHECK(ok, "only A1 -> A0 and C8 -> C0");
        }
        CHECK_EQ_INT(diffs, 2);
    }
}

static void rotation_commands(void) {
    uint8_t c[2];
    oled_rotation_cmds(LAYOUT_ROT_0, c);   CHECK(c[0] == 0xA1 && c[1] == 0xC8, "upright");
    oled_rotation_cmds(LAYOUT_ROT_180, c); CHECK(c[0] == 0xA0 && c[1] == 0xC0, "turned");
    oled_rotation_cmds(1, c);              CHECK(c[0] == 0xA1 && c[1] == 0xC8, "anything else is upright");
    uint8_t small[4];
    CHECK_EQ_INT(oled_init_cmds(false, PANEL_128x32, 0, small, sizeof small), -1);   // never writes past cap
}

static void operand_counts(void) {
    const uint8_t two[] = { 0xD5, 0xA8, 0xD3, 0x8D, 0xAD, 0x20, 0xDA, 0x81, 0xD9, 0xDB };
    for (size_t i = 0; i < sizeof two; i++) CHECK_EQ_INT(oled_cmd_len(two[i]), 2);
    const uint8_t one[] = { 0xAE, 0xAF, 0x40, 0xA0, 0xA1, 0xC0, 0xC8, 0xA4, 0xA6 };
    for (size_t i = 0; i < sizeof one; i++) CHECK_EQ_INT(oled_cmd_len(one[i]), 1);
}

// ---- the glass model. A controller's RAM is the framebuffer (page layout,
// bit = row % 8). Segment remap A1 + COM scan C8 is how these modules are
// wired to read upright (1.16's settings); A0 mirrors the columns and C0 the
// rows -- of the MUX's rows, so a 128x32 panel flips within its 32. Both
// controllers: the SH1106's 132-column RAM is offset 2 at either end, so its
// visible 128 are the same columns mirrored (ssd1306.c keeps the offset 2).
static void glass(const uint8_t *cmds, int n, const uint8_t *ram, uint8_t out[DISP_FB_MAX]) {
    bool remap = false, desc = false; int rows = 64;
    for (int i = 0; i < n; i += oled_cmd_len(cmds[i])) {
        if (cmds[i] == 0xA1) remap = true;
        if (cmds[i] == 0xA0) remap = false;
        if (cmds[i] == 0xC8) desc = true;
        if (cmds[i] == 0xC0) desc = false;
        if (cmds[i] == 0xA8) rows = cmds[i + 1] + 1;
    }
    memset(out, 0, DISP_FB_MAX);
    for (int y = 0; y < rows; y++) for (int x = 0; x < DISP_W; x++) {
        const int rx = remap ? x : DISP_W - 1 - x;
        const int ry = desc ? y : rows - 1 - y;
        if (ram[(ry / 8) * DISP_W + rx] & (1u << (ry % 8))) out[(y / 8) * DISP_W + x] |= (uint8_t)(1u << (y % 8));
    }
}

static display_state_t mounted(void) {
    display_state_t s; memset(&s, 0, sizeof s);
    s.status = DS_LOADED; s.bars = 3; strcpy(s.title, "Workbench 3.1 Install"); strcpy(s.detail, "disk 1 of 6");
    s.show_track = true; s.cyl = 40; s.max_cyl = 79; s.pct = -1; s.writable = true;
    return s;
}

static void rotate180_is_a_point_reflection(void) {
    for (int p = 0; p <= 1; p++) {
        const int rows = panel_height((panel_t)p);
        uint8_t fb[DISP_FB_MAX], r[DISP_FB_MAX];
        memset(fb, 0, sizeof fb);
        fb[0] = 0x01;                                   // pixel (0, 0)
        fb[(rows / 8 - 1) * DISP_W + 5] |= 0x80;        // pixel (5, rows-1)
        memcpy(r, fb, sizeof r);
        display_rotate180(r, (panel_t)p);
        CHECK(r[(rows / 8 - 1) * DISP_W + 127] == 0x80, "(0,0) -> (127, rows-1)");
        CHECK(r[122] == 0x01, "(5, rows-1) -> (122, 0)");
        int lit = 0; for (int i = 0; i < DISP_FB_MAX; i++) lit += __builtin_popcount(r[i]);
        CHECK_EQ_INT(lit, 2);
        display_rotate180(r, (panel_t)p);
        CHECK(memcmp(r, fb, sizeof r) == 0, "twice is the identity");
    }
}

static void rotated_glass_goldens(void) {
    static const struct { const char *name; panel_t p; bool sh; } G[] = {
        { "rot180_32", PANEL_128x32, false },
        { "rot180_64", PANEL_128x64, true },
    };
    const bool write = getenv("DISPLAY_GOLDEN_WRITE") != NULL;
    for (size_t k = 0; k < sizeof G / sizeof G[0]; k++) {
        const display_state_t s = mounted();
        uint8_t fb[DISP_FB_MAX]; display_render(&s, layout_default(G[k].p), fb);
        const int bytes = panel_height(G[k].p) * DISP_W / 8;
        // Both controllers draw the same glass for the same commands' meaning.
        for (int sh = 0; sh <= 1; sh++) {
            uint8_t up[OLED_INIT_MAX], turned[OLED_INIT_MAX], g0[DISP_FB_MAX], g2[DISP_FB_MAX];
            const int n0 = oled_init_cmds(sh, G[k].p, LAYOUT_ROT_0, up, sizeof up);
            const int n2 = oled_init_cmds(sh, G[k].p, LAYOUT_ROT_180, turned, sizeof turned);
            glass(up, n0, fb, g0);
            glass(turned, n2, fb, g2);
            CHECK(memcmp(g0, fb, DISP_FB_MAX) == 0, "upright glass is the framebuffer");
            uint8_t want[DISP_FB_MAX]; memcpy(want, fb, sizeof want); display_rotate180(want, G[k].p);
            CHECK(memcmp(g2, want, DISP_FB_MAX) == 0, "turned glass is display_rotate180(framebuffer)");
            if (sh != (int)G[k].sh) continue;
            char path[96]; snprintf(path, sizeof path, "fixtures/display_golden/%s.fb", G[k].name);
            if (write) {
                FILE *f = fopen(path, "wb"); CHECK(f != NULL, path);
                if (f) { fwrite(g2, 1, (size_t)bytes, f); fclose(f); }
                continue;
            }
            uint8_t gold[DISP_FB_MAX]; FILE *f = fopen(path, "rb"); CHECK(f != NULL, path);
            if (!f) continue;
            const size_t got = fread(gold, 1, sizeof gold, f); fclose(f);
            CHECK(got == (size_t)bytes, path);
            CHECK(memcmp(g2, gold, (size_t)bytes) == 0, G[k].name);
            // And the picture really is upside down: the title's first glyph
            // (top-left upright) is now bottom-right.
            int tl = 0, br = 0;
            for (int y = 8; y < 15; y++) for (int x = 0; x < 6; x++) tl += (fb[(y / 8) * DISP_W + x] >> (y % 8)) & 1;
            const int rows = panel_height(G[k].p);
            for (int y = rows - 15; y < rows - 8; y++) for (int x = 122; x < 128; x++) br += (gold[(y / 8) * DISP_W + x] >> (y % 8)) & 1;
            CHECK(tl > 0 && tl == br, "the 'W' moved to the opposite corner");
        }
    }
}

int main(void) {
    RUN(unrotated_sequences_are_1_16s);
    RUN(rotated_sequences_differ_in_remap_and_scan_only);
    RUN(rotation_commands);
    RUN(operand_counts);
    RUN(rotate180_is_a_point_reflection);
    RUN(rotated_glass_goldens);
    return REPORT();
}
