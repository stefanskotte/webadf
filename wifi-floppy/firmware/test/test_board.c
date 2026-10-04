#include <stdio.h>
#include <string.h>
#include "../src/board.h"
#include "../src/bus_gate.h"

static int checks, failed;
#define CHECK(c, msg) do { checks++; if (!(c)) { failed++; printf("FAIL: %s (%s:%d)\n", msg, __FILE__, __LINE__); } } while (0)

static void test_board_default_is_pim726(void) {
    CHECK(g_board == &BOARD_PIM726, "g_board points at the PIM726 before anything runs");
    CHECK(strcmp(g_board->name, "pim726") == 0, "name");
}

static void test_pim726_matches_rev_b(void) {
    // The rev B netlist (pnpm hw:verify) and floppy_io.h as of 1.6.2.
    const board_t *b = &BOARD_PIM726;
    CHECK(b->sel0 == 2 && b->sel1 == 3 && b->mtr == 4 && b->dir == 5, "SEL0..DIR GP2-5");
    CHECK(b->step == 6 && b->wdata == 7 && b->wgate == 8 && b->side == 9, "inputs GP6-9");
    CHECK(b->wprot == 10 && b->rdata == 11 && b->rdy == 12 && b->trk0 == 13, "outputs GP10-13");
    CHECK(b->index == 0 && b->chng == 1, "INDEX GP0, CHNG GP1");
    CHECK(b->act_led == 22 && b->i2c_sda == 18 && b->i2c_scl == 19 && b->i2c_index == 1, "LED, I2C1");
}

static void test_pim726_passes(void) {
    char why[96] = "";
    CHECK(board_check(&BOARD_PIM726, why, sizeof why), why);
}

static board_t broken(void) { return BOARD_PIM726; }

static void expect_fail(board_t b, const char *needle, const char *label) {
    char why[96] = "";
    bool ok = board_check(&b, why, sizeof why);
    CHECK(!ok, label);
    CHECK(strstr(why, needle) != NULL, label);
}

static void test_each_invariant_is_enforced(void) {
    board_t b;
    b = broken(); b.sel1 = 7;            expect_fail(b, "consecutive", "SEL1 not SEL0+1");
    b = broken(); b.dir = 9;             expect_fail(b, "consecutive", "DIR not SEL0+3");
    b = broken(); b.sel0 = 26; b.sel1 = 27; b.mtr = 28; b.dir = 29;
                                         expect_fail(b, "GP2", "drive_id still needs SEL0 == GP2 in P1");
    b = broken(); b.step = b.wdata;      expect_fail(b, "twice", "two roles on one pin");
    b = broken(); b.rdy = 20;            expect_fail(b, "window", "status pin outside the status_gate window");
    b = broken(); b.radio_pins[0] = b.step;
                                         expect_fail(b, "radio", "a role on a radio pin");
    b = broken(); b.i2c_index = 2;       expect_fail(b, "I2C", "I2C index must be 0 or 1");
}

static void test_why_is_always_terminated(void) {
    board_t b = broken(); b.sel1 = 7;
    char why[8];
    memset(why, 'x', sizeof why);
    board_check(&b, why, sizeof why);
    CHECK(memchr(why, '\0', sizeof why) != NULL, "why is NUL-terminated even when truncated");
}

int main(void) {
    test_board_default_is_pim726();
    test_pim726_matches_rev_b();
    test_pim726_passes();
    test_each_invariant_is_enforced();
    test_why_is_always_terminated();
    printf("test_board.c: %d checks, %d failed\n", checks, failed);
    return failed ? 1 : 0;
}
