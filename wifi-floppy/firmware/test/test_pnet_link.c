/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#include "harness.h"
#include "../src/pnet_link.h"
#include <stdint.h>
#include <string.h>

static pnet_hdr_t hdr(uint8_t amiga, uint8_t pico) {
    pnet_hdr_t h;
    memset(&h, 0, sizeof h);
    h.mode = PNET_MODE_ETHERNET;
    h.amiga_ctr = amiga;
    h.pico_ctr = pico;
    return h;
}

static void counters_start_as_paulanets(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    CHECK_EQ_INT(s.last_amiga, 0xFF);
    CHECK_EQ_INT(s.pico, 0x7F);
    CHECK(!s.backup, "nothing out");
}

static void a_new_batch_is_taken_once(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    pnet_hdr_t h = hdr(0x00, 0x7F);
    CHECK(pnet_link_is_new(&s, &h), "new");
    CHECK_EQ_INT(pnet_link_take(&s, &h, 2, 32), PNET_TAKE_NEW);
    CHECK_EQ_INT(s.last_amiga, 0x00);
    CHECK(!pnet_link_is_new(&s, &h), "now a resend");
    CHECK_EQ_INT(pnet_link_take(&s, &h, 2, 32), PNET_TAKE_DUP);
    CHECK_EQ_INT(s.fresh, 1);
    CHECK_EQ_INT(s.dup, 1);
    h = hdr(0x01, 0x7F);
    CHECK_EQ_INT(pnet_link_take(&s, &h, 0, 0), PNET_TAKE_NEW);   /* an empty batch fits anywhere */
}

static void a_batch_that_does_not_fit_the_tx_ring_is_not_taken(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    pnet_hdr_t h = hdr(0x05, 0x7F);
    CHECK_EQ_INT(pnet_link_take(&s, &h, 3, 2), PNET_TAKE_FULL);
    CHECK_EQ_INT(s.last_amiga, 0xFF);                       /* unacknowledged: the Amiga resends */
    CHECK_EQ_INT(s.txfull, 1);
    CHECK(pnet_link_is_new(&s, &h), "still new when it comes again");
    CHECK_EQ_INT(pnet_link_take(&s, &h, 3, 3), PNET_TAKE_NEW);
    CHECK_EQ_INT(s.last_amiga, 0x05);
}

static void an_ack_frees_the_batch_out(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    pnet_link_start(&s, 3);
    CHECK(s.backup && s.nframes == 3 && s.pico == 0x80, "out under 0x80");
    pnet_hdr_t h = hdr(0x00, 0x7F);
    CHECK_EQ_INT(pnet_link_ack(&s, &h), 0);                 /* echoes the old counter: no */
    h = hdr(0x00, 0x80);
    CHECK_EQ_INT(pnet_link_ack(&s, &h), 3);
    CHECK(!s.backup && s.nframes == 0, "freed");
    CHECK_EQ_INT(pnet_link_ack(&s, &h), 0);                 /* the same ack again frees nothing */
    CHECK_EQ_INT(s.acked, 1);
}

static void an_unacknowledged_batch_is_rebuilt_unchanged(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    pnet_link_start(&s, 2);
    /* NetLoop restarted (or Ctrl-A-A): its first header echoes some other counter. */
    pnet_hdr_t h = hdr(0x42, 0x13);
    CHECK_EQ_INT(pnet_link_ack(&s, &h), 0);
    CHECK_EQ_INT(pnet_link_take(&s, &h, 0, 32), PNET_TAKE_NEW);
    pnet_link_start(&s, 5);                                 /* a caller trying to start over it */
    CHECK(s.backup && s.nframes == 2 && s.pico == 0x80, "the same two frames, the same counter");
}

static void empty_batches_do_not_move_the_counter(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    pnet_link_start(&s, 0);
    CHECK(!s.backup && s.pico == 0x7F, "nothing out, 0x7F");
}

static void counters_wrap(void) {
    pnet_link_t s;
    pnet_link_init(&s);
    s.pico = 0xFF;
    pnet_link_start(&s, 1);
    CHECK_EQ_INT(s.pico, 0x00);
    pnet_hdr_t h = hdr(0x10, 0x00);
    CHECK_EQ_INT(pnet_link_ack(&s, &h), 1);
}

static void fit_respects_the_buffer_and_twenty_frames(void) {
    uint16_t lens[25];
    for (unsigned i = 0; i < 25; i++) lens[i] = 64;
    CHECK_EQ_INT(pnet_link_fit(lens, 25, 100000), PNET_MAX_FRAMES);
    CHECK_EQ_INT(pnet_link_fit(lens, 3, 100000), 3);
    CHECK_EQ_INT(pnet_link_fit(lens, 0, 100000), 0);
    for (unsigned i = 0; i < 25; i++) lens[i] = PNET_ETH_MTU;
    const size_t cap = 14336u - 80u;                        /* DF1's buffer less the extra lead-in */
    const unsigned n = pnet_link_fit(lens, 25, cap);
    CHECK(n >= 1, "one full frame always fits");
    CHECK(pnet_to_amiga_bound(lens, n) <= cap, "n fits");
    CHECK(pnet_to_amiga_bound(lens, n + 1) > cap, "n + 1 does not");
    /* And the builder agrees: n real frames build into exactly `cap` bytes or fewer. */
    static uint8_t frame[PNET_ETH_MTU], out[14336];
    for (unsigned i = 0; i < sizeof frame; i++) frame[i] = (uint8_t)(i * 37u);   /* RLE's worst case-ish */
    pnet_frame_ref_t f[PNET_MAX_FRAMES];
    for (unsigned i = 0; i < n; i++) { f[i].data = frame; f[i].len = PNET_ETH_MTU; }
    CHECK(pnet_build_to_amiga(out, cap, 0, 0, 0, f, n) != 0, "built within cap");
}

static void ota_waits_for_quiet(void) {
    CHECK(pnet_ota_quiet(5000, 0, false), "never active");
    CHECK(!pnet_ota_quiet(5000, 0, true), "frames still queued");
    CHECK(!pnet_ota_quiet(19999, 10000, false), "9,999 ms");
    CHECK(pnet_ota_quiet(20000, 10000, false), "10,000 ms");
    CHECK(!pnet_ota_quiet(5, 0xFFFFFF00u, false), "across the wrap: 261 ms");
    CHECK(pnet_ota_quiet(10000u + 0x100u - 1u, 0xFFFFFF00u, false), "across the wrap: 10,255 ms");
}

int main(void) {
    RUN(counters_start_as_paulanets);
    RUN(a_new_batch_is_taken_once);
    RUN(a_batch_that_does_not_fit_the_tx_ring_is_not_taken);
    RUN(an_ack_frees_the_batch_out);
    RUN(an_unacknowledged_batch_is_rebuilt_unchanged);
    RUN(empty_batches_do_not_move_the_counter);
    RUN(counters_wrap);
    RUN(fit_respects_the_buffer_and_twenty_frames);
    RUN(ota_waits_for_quiet);
    return REPORT();
}
