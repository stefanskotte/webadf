#include "harness.h"
#include <stdlib.h>
#include "si512_fake.h"
#include "pn532_fake.h"
#include "../src/nfc_reader_priv.h"

// The PN532 backend's own behaviour (UM0701-02), and the choice of chip.
// The session it shares with the Si512 is test_nfc_session.c's.
// Runs under ASan + UBSan (run.sh): a frame parsed past its buffer is a report.

static const char *ID = "0123abcd-4567-5abc-8def-0123456789ab";

static uint32_t now;
static uint32_t clk(void) { return now; }

static si512_fake_t S;
static pn532_fake_t P;
static nfc_reader_t R;
static nfc_event_t evs[64];
static int nev;

static void setup_both(bool si, bool pn) {
    now = 0;
    nev = 0;
    si512_fake_init(&S, &now);
    pn532_fake_init(&P, &now);
    if (!si) S.vanish_after_ops = 0;
    P.chip_present = pn;
    nfc_bus_t bus = si512_fake_bus(&S);
    nfc_frame_bus_t fbus = pn532_fake_bus(&P);
    nfc_init(&R, &bus, clk);
    nfc_attach_pn532(&R, &fbus);
}
static void setup(void) { setup_both(false, true); }

static void run(int ms) {
    for (int k = 0; k < ms; k++) {
        pn532_fake_step_begin(&P);
        nfc_step(&R);
        nfc_event_t e;
        if (nfc_take_event(&R, &e) && nev < 64) evs[nev++] = e;
        nfc_gap_t g;
        (void)nfc_take_gap(&R, &g);
        now++;
    }
}

static int count(nfc_ev_kind_t kind) {
    int c = 0;
    for (int k = 0; k < nev; k++) c += evs[k].kind == kind;
    return c;
}

static const nfc_event_t *first(nfc_ev_kind_t kind) {
    for (int k = 0; k < nev; k++) if (evs[k].kind == kind) return &evs[k];
    return NULL;
}

// ---- the frame codec (§6.2.1, §6.2.4) ------------------------------------------

static void frame_is_the_manuals_normal_information_frame(void) {
    uint8_t out[16];
    static const uint8_t sam[2] = { 0x14, 0x01 };
    int n = pn532_frame(out, sizeof out, sam, 2);
    static const uint8_t want[] = { 0x00, 0x00, 0xFF, 0x03, 0xFD, 0xD4, 0x14, 0x01, 0x17, 0x00 };
    CHECK_EQ_INT(n, (int)sizeof want);
    CHECK(n == (int)sizeof want && memcmp(out, want, sizeof want) == 0, "00 00 FF 03 FD D4 14 01 17 00");
    CHECK_EQ_INT(pn532_frame(out, 9, sam, 2), -1);      // does not fit: refused, not truncated
    CHECK_EQ_INT(pn532_frame(out, sizeof out, sam, 0), -1);
}

// A good answer, as the I2C read sees it: status byte, then the frame.
static int good_read(uint8_t *b) {
    // InDataExchange READ: D5 41 00 + 16 bytes.
    uint8_t d[19] = { 0xD5, 0x41, 0x00 };
    for (int i = 0; i < 16; i++) d[3 + i] = (uint8_t)(i * 7 + 1);
    int k = 0;
    b[k++] = 0x01;
    b[k++] = 0x00; b[k++] = 0x00; b[k++] = 0xFF;
    b[k++] = 19; b[k++] = (uint8_t)(0x100 - 19);
    uint8_t sum = 0;
    for (int i = 0; i < 19; i++) { b[k++] = d[i]; sum += d[i]; }
    b[k++] = (uint8_t)(0x100 - sum);
    b[k++] = 0x00;
    return k;
}

static void parse_takes_a_good_frame_and_the_ack(void) {
    uint8_t b[40];
    int n = good_read(b);
    int at = -1, len = -1, need = -1;
    CHECK_EQ_INT(pn532_parse(b, n, &at, &len, &need), PN_OK);
    CHECK_EQ_INT(len, 19);
    CHECK(at > 0 && b[at] == 0xD5 && b[at + 1] == 0x41, "at the TFI");
    static const uint8_t ack[7] = { 0x01, 0x00, 0x00, 0xFF, 0x00, 0xFF, 0x00 };
    CHECK_EQ_INT(pn532_parse(ack, 7, &at, &len, &need), PN_ACK);
    static const uint8_t busy[7] = { 0x00, 0xA5, 0xA5, 0xA5, 0xA5, 0xA5, 0xA5 };
    CHECK_EQ_INT(pn532_parse(busy, 7, &at, &len, &need), PN_NOT_READY);
    static const uint8_t err[9] = { 0x01, 0x00, 0x00, 0xFF, 0x01, 0xFF, 0x7F, 0x81, 0x00 };
    CHECK_EQ_INT(pn532_parse(err, 9, &at, &len, &need), PN_BAD);   // the syntax error frame
}

// Every prefix of a good read, each in a heap block of exactly its length:
// a read past the end is an ASan report, and every one is SHORT (or BAD when
// not even the header is in), never OK.
static void parse_never_reads_past_a_short_read(void) {
    uint8_t b[40];
    int n = good_read(b);
    for (int k = 1; k < n; k++) {
        uint8_t *h = malloc((size_t)k);
        memcpy(h, b, (size_t)k);
        int at = -1, len = -1, need = -1;
        pn_parse_t res = pn532_parse(h, k, &at, &len, &need);
        CHECK(res == PN_SHORT || res == PN_BAD, "a prefix is never OK");
        if (res == PN_SHORT) CHECK_EQ_INT(need, n);
        free(h);
    }
}

static void parse_refuses_bad_checksums_and_lengths(void) {
    uint8_t b[40];
    int n = good_read(b);
    int at, len, need;
    b[n - 2] ^= 1;                                       // DCS
    CHECK_EQ_INT(pn532_parse(b, n, &at, &len, &need), PN_BAD);
    n = good_read(b);
    b[5] ^= 1;                                           // LCS
    CHECK_EQ_INT(pn532_parse(b, n, &at, &len, &need), PN_BAD);
    n = good_read(b);
    b[4] = 0xF0; b[5] = 0x10;                            // a LEN far past the read, LCS agreeing
    CHECK_EQ_INT(pn532_parse(b, n, &at, &len, &need), PN_SHORT);
    CHECK(need > NFC_PN532_BUF, "says how much it would need");
    n = good_read(b);
    b[4] = 0xFF; b[5] = 0xFF;                            // an extended frame (§6.2.1.2)
    CHECK_EQ_INT(pn532_parse(b, n, &at, &len, &need), PN_BAD);
    n = good_read(b);
    b[6] = 0xD4;                                         // the host's TFI, not the PN532's
    CHECK_EQ_INT(pn532_parse(b, n, &at, &len, &need), PN_BAD);
}

// Random bytes in exact-size heap blocks: parse may say anything but OK on
// garbage it cannot check, and must never read out of bounds or claim a
// frame that runs past the read.
static void parse_survives_noise(void) {
    srand(12345);
    for (int t = 0; t < 20000; t++) {
        int k = 1 + rand() % 48;
        uint8_t *h = malloc((size_t)k);
        for (int i = 0; i < k; i++) h[i] = (uint8_t)rand();
        if (k > 0 && (t & 1)) h[0] = 0x01;
        if (k > 4 && (t & 2)) { h[1] = 0x00; h[2] = 0x00; h[3] = 0xFF; }
        int at = 0, len = 0, need = 0;
        if (pn532_parse(h, k, &at, &len, &need) == PN_OK)
            CHECK(at >= 1 && len >= 2 && at + len < k, "the frame, DCS included, is inside the read");
        free(h);
    }
}

// ---- the chip's protocol -----------------------------------------------------------

static void init_leaves_lowvbat_and_makes_polls_finite(void) {
    setup();
    P.tag_present = false;
    run(1000);
    CHECK(P.sam_done, "SAMConfiguration normal mode (§3.1.3.3)");
    CHECK_EQ_INT(P.cmds[0x14], 1);
    CHECK(P.retries_passive != 0xFF, "MxRtyPassiveActivation finite (§7.3.1 CfgItem 5)");
    CHECK(P.cmds[0x4A] >= 2, "it polls");
    CHECK_EQ_INT(count(NFC_EV_PRESENT), 1);
    CHECK_EQ_INT(nfc_chip(&R), NFC_CHIP_PN532);
}

static void every_step_is_one_frame_at_most(void) {
    setup();
    nfc_tag_encode(ID, P.sector1);
    nfc_arm_write(&R, 1, ID);
    int worst = 0;
    for (int k = 0; k < 3000; k++) {
        pn532_fake_step_begin(&P);
        int n = nfc_step(&R);
        CHECK(n <= NFC_MAX_OPS_PER_STEP, "budget");
        if (P.max_step_frames > worst) worst = P.max_step_frames;
        nfc_event_t e;
        if (nfc_take_event(&R, &e) && nev < 64) evs[nev++] = e;
        now++;
    }
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 1);
    CHECK_EQ_INT(worst, 1);
    CHECK(P.max_xfer <= 28, "no transfer over 28 bytes (an InDataExchange WRITE)");
}

static void a_garbled_answer_is_nacked_and_read_again(void) {
    setup();
    nfc_tag_encode(ID, P.sector1);
    run(100);                                            // found, polling
    P.garble_next = 1;
    run(1000);
    CHECK(P.host_nacks >= 1, "NACK (§6.2.2.1 c)");
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    CHECK_EQ_INT(count(NFC_EV_ABSENT), 0);
}

static void a_lying_len_is_never_followed_out_of_bounds(void) {
    setup();
    nfc_tag_encode(ID, P.sector1);
    run(100);
    P.bad_len_next = 0xF0;                               // claims 240 bytes
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    CHECK_EQ_INT(count(NFC_EV_ABSENT), 0);
    P.bad_len_next = 30;                                 // claims a little more than there is
    P.tag_present = false;
    run(3500);
    P.tag_present = true;
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 2);
}

static void a_wedged_chip_is_aborted_then_lost_then_found_again(void) {
    setup();
    P.tag_present = false;
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_PRESENT), 1);
    P.never_answer = true;
    run(2000);
    CHECK(P.host_acks >= 1, "aborted with an ACK (§6.2.2.1 d)");
    CHECK_EQ_INT(count(NFC_EV_ABSENT), 1);
    CHECK(!nfc_present(&R), "absent");
    P.never_answer = false;
    run(6000);
    CHECK_EQ_INT(count(NFC_EV_PRESENT), 2);
}

static void one_lost_answer_is_not_a_lost_chip(void) {
    setup();
    nfc_tag_encode(ID, P.sector1);
    run(100);
    P.never_answer = true;
    while (P.host_acks == 0 && now < 2000) run(1);       // the first abort
    P.never_answer = false;
    run(2000);
    CHECK_EQ_INT(count(NFC_EV_ABSENT), 0);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
}

static void a_seven_byte_uid_is_not_ours(void) {
    setup();
    static const uint8_t u7[7] = { 0x04, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66 };
    memcpy(P.uid, u7, 7);
    P.uid_len = 7;
    P.sak = 0x00;                                        // an NTAG / Ultralight
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_NOT_OURS), 1);
    const nfc_event_t *e = first(NFC_EV_NOT_OURS);
    // As the Si512 reports it: cascade level 1 -- CT 0x88 and the first three bytes.
    static const uint8_t cl1[4] = { 0x88, 0x04, 0x11, 0x22 };
    if (e) CHECK(memcmp(e->uid, cl1, 4) == 0, "88 04 11 22");
    CHECK_EQ_INT(P.cmds[0x40], 0);                       // no auth tried
    CHECK_EQ_INT(P.host_nacks, 0);                       // 23 bytes: read whole the first time
}

static void an_iso14443_4_card_with_a_long_ats_is_not_ours(void) {
    setup();
    P.sak = 0x20;
    P.ats_len = 20;                                      // the answer is 33 bytes: re-read whole
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_NOT_OURS), 1);
    CHECK_EQ_INT(count(NFC_EV_ABSENT), 0);
    setup();
    P.sak = 0x20;
    P.ats_len = 60;                                      // past the frame buffer: refused
    run(2000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 0);
    CHECK_EQ_INT(count(NFC_EV_ABSENT), 0);               // the chip is fine
    CHECK(P.max_xfer <= NFC_PN532_BUF, "never read past the buffer");
}

// ---- the bus clock (core0's time) ------------------------------------------------------
//
// A frame at the boot probe's 100 kHz is ~2.6 ms of core0 (the 64-byte re-read
// ~5.8 ms) -- inside PaulaNET's SIDE-edge window (1.0-5.4 ms). The PN532 runs
// at 400 kHz (UM0701-02 §6.2.4), so once one has answered the reader asks for it.

static void a_found_pn532_puts_the_bus_at_400khz_and_keeps_it(void) {
    setup();
    nfc_tag_encode(ID, P.sector1);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    CHECK_EQ_INT(P.bus_hz, 400000);
    CHECK(P.slow_frames <= 3, "only the probe's SAMConfiguration, its ACK and its answer at 100 kHz");
    // Lost and found again: never asked for less.
    P.chip_present = false;
    run(2000);
    P.chip_present = true;
    run(6000);
    CHECK_EQ_INT(count(NFC_EV_PRESENT), 2);
    CHECK_EQ_INT(P.lowest_hz_asked, 400000);
    CHECK(P.slow_frames <= 3, "no slow frames after the first answer");
}

// The worst step once at 400 kHz, the 64-byte re-read included (an ATS card):
// (64 + 1) x 9 bits / 400 kHz = 1.46 ms. The documented bound is 1.5 ms.
static void every_step_at_400khz_is_under_1500us(void) {
    setup();
    P.tag_present = false;
    run(100);                                            // found: 400 kHz from here
    CHECK_EQ_INT(P.bus_hz, 400000);
    P.max_step_us = 0;
    nfc_arm_write(&R, 1, ID);
    P.tag_present = true;
    run(2000);                                           // a write, its verify, and polls
    P.tag_present = false;
    run(3500);
    P.sak = 0x20;
    P.ats_len = 44;                                      // LEN 56: 64 bytes to read, the longest re-read
    P.tag_present = true;
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 1);
    CHECK(P.host_nacks >= 1, "the long answer was re-read");
    CHECK(P.max_step_us <= 1500, "no step over 1.5 ms of bus");
    printf("  worst step at 400 kHz: %u us\n", (unsigned)P.max_step_us);
}

// ---- the choice of chip -------------------------------------------------------------

static void only_0x28_is_the_si512(void) {
    setup_both(true, false);
    S.tag_present = false;
    run(1000);
    CHECK_EQ_INT(nfc_chip(&R), NFC_CHIP_SI512);
    CHECK_EQ_INT(count(NFC_EV_PRESENT), 1);
}

static void only_0x24_is_the_pn532(void) {
    setup_both(false, true);
    P.tag_present = false;
    run(1000);
    CHECK_EQ_INT(nfc_chip(&R), NFC_CHIP_PN532);
    CHECK_EQ_INT(count(NFC_EV_PRESENT), 1);
}

static void both_is_the_si512_and_the_pn532_is_never_touched(void) {
    setup_both(true, true);
    S.tag_present = false;
    run(10000);
    CHECK_EQ_INT(nfc_chip(&R), NFC_CHIP_SI512);
    CHECK_EQ_INT(P.xfers, 0);
}

static void neither_is_absent_and_each_check_costs_two_transfers(void) {
    setup_both(false, false);
    run(10000);
    CHECK(!nfc_present(&R), "absent");
    CHECK_EQ_INT(nfc_chip(&R), NFC_CHIP_NONE);
    CHECK_EQ_INT(nev, 0);
    CHECK_EQ_INT(S.version_reads, 2);                    // at 0 s and 5 s
    CHECK_EQ_INT(P.xfers, 2);                            // one SAMConfiguration write each
}

static void a_pn532_plugged_in_late_is_found(void) {
    setup_both(false, false);
    run(6000);
    P.chip_present = true;
    P.tag_present = false;
    run(6000);
    CHECK_EQ_INT(nfc_chip(&R), NFC_CHIP_PN532);
    CHECK_EQ_INT(count(NFC_EV_PRESENT), 1);
}

static void a_si512_plugged_in_late_is_found(void) {
    setup_both(false, false);
    run(6000);
    S.vanish_after_ops = -1;
    S.tag_present = false;
    run(6000);
    CHECK_EQ_INT(nfc_chip(&R), NFC_CHIP_SI512);
    CHECK_EQ_INT(count(NFC_EV_PRESENT), 1);
}

static void a_lost_pn532_swapped_for_a_si512_is_the_si512(void) {
    setup_both(false, true);
    P.tag_present = false;
    run(1000);
    CHECK_EQ_INT(nfc_chip(&R), NFC_CHIP_PN532);
    P.chip_present = false;
    run(2000);
    CHECK_EQ_INT(count(NFC_EV_ABSENT), 1);
    S.vanish_after_ops = -1;
    S.tag_present = false;
    run(6000);
    CHECK_EQ_INT(nfc_chip(&R), NFC_CHIP_SI512);
    CHECK_EQ_INT(count(NFC_EV_PRESENT), 2);
}

// The boot scan did not see 0x24 (main.c attaches the PN532 only if it did):
// nothing is ever written there, whatever lives at 0x24 later.
static void without_0x24_in_the_boot_scan_nothing_is_written_there(void) {
    now = 0;
    nev = 0;
    si512_fake_init(&S, &now);
    pn532_fake_init(&P, &now);
    S.vanish_after_ops = 0;                              // no Si512 either
    nfc_bus_t bus = si512_fake_bus(&S);
    nfc_init(&R, &bus, clk);                             // no nfc_attach_pn532
    run(20000);
    CHECK_EQ_INT(P.xfers, 0);
    CHECK(!nfc_present(&R), "absent");
}

// Both fitted, and the Si512 misses the recheck after an outage: the PN532
// takes over -- but only until the Si512 answers again, at the next 5 s check.
static void both_fitted_a_missed_si512_recheck_does_not_lose_it_for_good(void) {
    setup_both(true, true);
    S.tag_present = false;
    P.tag_present = false;
    run(1000);
    CHECK_EQ_INT(nfc_chip(&R), NFC_CHIP_SI512);
    S.vanish_after_ops = S.ops;                          // the Si512 drops out ...
    run(6000);                                           // ... through the next recheck
    CHECK_EQ_INT(nfc_chip(&R), NFC_CHIP_PN532);
    S.vanish_after_ops = -1;                             // and is back
    run(6000);
    CHECK_EQ_INT(nfc_chip(&R), NFC_CHIP_SI512);
    CHECK(nfc_present(&R), "present throughout the switch back");
    // And it reads tags again.
    nfc_tag_encode(ID, S.sector1);
    S.tag_present = true;
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
}

static void a_si512_that_answers_its_recheck_is_kept(void) {
    setup_both(true, true);
    S.tag_present = false;
    run(1000);
    S.vanish_after_ops = S.ops;                          // a glitch: three failed transfers
    run(400);                                            // (the next poll finds it gone)
    CHECK_EQ_INT(count(NFC_EV_ABSENT), 1);
    S.vanish_after_ops = -1;                             // over by the recheck
    run(6000);
    CHECK_EQ_INT(nfc_chip(&R), NFC_CHIP_SI512);
    CHECK_EQ_INT(P.xfers, 0);
}

int main(void) {
    RUN(frame_is_the_manuals_normal_information_frame);
    RUN(parse_takes_a_good_frame_and_the_ack);
    RUN(parse_never_reads_past_a_short_read);
    RUN(parse_refuses_bad_checksums_and_lengths);
    RUN(parse_survives_noise);
    RUN(init_leaves_lowvbat_and_makes_polls_finite);
    RUN(every_step_is_one_frame_at_most);
    RUN(a_garbled_answer_is_nacked_and_read_again);
    RUN(a_lying_len_is_never_followed_out_of_bounds);
    RUN(a_wedged_chip_is_aborted_then_lost_then_found_again);
    RUN(one_lost_answer_is_not_a_lost_chip);
    RUN(a_seven_byte_uid_is_not_ours);
    RUN(an_iso14443_4_card_with_a_long_ats_is_not_ours);
    RUN(a_found_pn532_puts_the_bus_at_400khz_and_keeps_it);
    RUN(every_step_at_400khz_is_under_1500us);
    RUN(without_0x24_in_the_boot_scan_nothing_is_written_there);
    RUN(both_fitted_a_missed_si512_recheck_does_not_lose_it_for_good);
    RUN(a_si512_that_answers_its_recheck_is_kept);
    RUN(only_0x28_is_the_si512);
    RUN(only_0x24_is_the_pn532);
    RUN(both_is_the_si512_and_the_pn532_is_never_touched);
    RUN(neither_is_absent_and_each_check_costs_two_transfers);
    RUN(a_pn532_plugged_in_late_is_found);
    RUN(a_si512_plugged_in_late_is_found);
    RUN(a_lost_pn532_swapped_for_a_si512_is_the_si512);
    return REPORT();
}
