#include "harness.h"
#include "si512_fake.h"
#include "pn532_fake.h"
#include "../src/nfc_reader.h"

// The session (nfc_reader.c) is one copy for both chips, so its behaviour is
// tested once and run against each backend: the Si512 (si512_fake.c, the only
// chip on the bus) and the PN532 (pn532_fake.c, no Si512 answering). Anything
// chip-specific lives in test_nfc_reader.c (Si512, unchanged since 1.17.0)
// and test_nfc_pn532.c.

static const char *ID  = "0123abcd-4567-5abc-8def-0123456789ab";
static const char *ID2 = "fedcba98-7654-5321-9abc-def012345678";

static uint32_t now;
static uint32_t clk(void) { return now; }

static si512_fake_t S;
static pn532_fake_t P;
static nfc_reader_t R;
static nfc_event_t evs[64];
static int nev;
static nfc_gap_t gaps[16];
static int ngap;
static int budget_breaks;

// ---- the backend under test --------------------------------------------------

typedef struct {
    const char *name;
    nfc_chip_t chip;
    bool    *tag_present;
    uint8_t *sector1;
    uint8_t *uid;
    bool    *locked;
    uint8_t *sak;
    bool    *flip_next_read;
    int     *reads;
    int     *trailer_writes;
} backend_t;

static backend_t B;
static bool is_pn;

static void setup(void) {
    now = 0;
    nev = 0;
    ngap = 0;
    budget_breaks = 0;
    si512_fake_init(&S, &now);
    pn532_fake_init(&P, &now);
    if (is_pn) {
        S.vanish_after_ops = 0;              // no Si512 on the bus
        B = (backend_t){ "pn532", NFC_CHIP_PN532, &P.tag_present, P.sector1, P.uid, &P.locked,
                         &P.sak, &P.flip_next_read, &P.reads, &P.trailer_writes };
    } else {
        P.chip_present = false;              // no PN532 on the bus
        B = (backend_t){ "si512", NFC_CHIP_SI512, &S.tag_present, S.sector1, S.uid, &S.locked,
                         &S.sak, &S.flip_next_read, &S.reads, &S.trailer_writes };
    }
    nfc_bus_t bus = si512_fake_bus(&S);
    nfc_frame_bus_t fbus = pn532_fake_bus(&P);
    nfc_init(&R, &bus, clk);
    nfc_attach_pn532(&R, &fbus);
}

static uint32_t field_on_ms(void) {
    return is_pn ? pn532_fake_field_on_ms(&P) : si512_fake_field_on_ms(&S);
}

static void take(void) {
    nfc_event_t e;
    if (nfc_take_event(&R, &e) && nev < 64) evs[nev++] = e;
    nfc_gap_t g;
    if (nfc_take_gap(&R, &g) && ngap < 16) gaps[ngap++] = g;
}

// One step, and its budget: never more than `cap` ops; for the Si512 the
// count it returned is the count its bus saw; for the PN532 at most one frame
// transfer in the step, none longer than the frame buffer.
static void step_checked(int cap) {
    int s_before = S.ops;
    pn532_fake_step_begin(&P);
    int n = nfc_step(&R);
    bool bad = n > cap || n < 0;
    if (!is_pn) bad = bad || S.ops - s_before != n;
    else        bad = bad || P.max_step_frames > 1 || P.max_xfer > NFC_PN532_BUF;
    if (bad && budget_breaks++ == 0)
        printf("  budget (%s): step at %u ms returned %d (cap %d), frames %d, longest %d\n",
               B.name, (unsigned)now, n, cap, P.max_step_frames, P.max_xfer);
    take();
}

static void run(int ms) {
    for (int k = 0; k < ms; k++) { step_checked(NFC_MAX_OPS_PER_STEP); now++; }
}

static void run_capped(int steps, uint32_t gap, int cap) {
    for (int k = 0; k < steps; k++) { step_checked(cap); now += gap; }
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

static void end_checks(void) { CHECK_EQ_INT(budget_breaks, 0); }

static void put_id(const char *id) { CHECK(nfc_tag_encode(id, B.sector1), "encode"); }
static void put_next(void) { CHECK(nfc_tag_encode_next(B.sector1), "encode next"); }
static void tag(bool on) { *B.tag_present = on; }

// ---- the tests -----------------------------------------------------------------

static void present_chip_is_found_and_named(void) {
    setup();
    tag(false);
    run(1000);
    CHECK_EQ_INT(nev, 1);
    CHECK_EQ_INT(count(NFC_EV_PRESENT), 1);
    CHECK(nfc_present(&R), "present");
    CHECK_EQ_INT(nfc_chip(&R), B.chip);
    end_checks();
}

static void tag_read_reports_disk_id(void) {
    setup();
    put_id(ID);
    run(1000);
    CHECK_EQ_INT(nev, 2);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    const nfc_event_t *e = first(NFC_EV_TAG_READ);
    if (e) {
        CHECK(strcmp(e->disk_id, ID) == 0, "disk id");
        CHECK_EQ_INT(e->uid_len, 4);
        CHECK(memcmp(e->uid, B.uid, 4) == 0, "uid");
        CHECK(e->why == NULL, "no why");
    }
    end_checks();
}

static void same_tag_held_reports_once(void) {
    setup();
    put_id(ID);
    run(10000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    CHECK_EQ_INT(nev, 2);
    CHECK_EQ_INT(*B.reads, 3);               // held, it is not read again either
    CHECK_EQ_INT(ngap, 0);
    end_checks();
}

static void tag_removed_and_returned_after_the_window_reports_twice(void) {
    setup();
    put_id(ID);
    run(2000);
    tag(false);
    run(3500);
    tag(true);
    run(2000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 2);
    CHECK_EQ_INT(nev, 3);
    end_checks();
}

static void held_tag_dropout_2s_is_the_same_tap(void) {
    setup();
    put_id(ID);
    run(2000);
    tag(false);
    run(2000);
    tag(true);
    run(3000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    CHECK_EQ_INT(nev, 2);
    end_checks();
}

static void blank_tag_is_not_ours(void) {
    setup();
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_NOT_OURS), 1);
    CHECK_EQ_INT(nev, 2);
    const nfc_event_t *e = first(NFC_EV_NOT_OURS);
    if (e) CHECK(memcmp(e->uid, B.uid, 4) == 0 && e->uid_len == 4, "uid");
    end_checks();
}

static void non_classic_tag_is_not_ours(void) {
    setup();
    *B.sak = 0x04;
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_NOT_OURS), 1);
    CHECK_EQ_INT(count(NFC_EV_UNREADABLE), 0);
    end_checks();
}

static void locked_tag_is_unreadable_locked(void) {
    setup();
    put_id(ID);
    *B.locked = true;
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_UNREADABLE), 1);
    CHECK_EQ_INT(nev, 2);
    const nfc_event_t *e = first(NFC_EV_UNREADABLE);
    if (e) CHECK(e->why && strcmp(e->why, "locked") == 0, "why locked");
    end_checks();
}

static void tag_pulled_mid_read_is_unreadable_moved(void) {
    setup();
    put_id(ID);
    while (*B.reads < 1 && now < 2000) run(1);   // the first block is in
    tag(false);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_UNREADABLE), 1);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 0);
    CHECK_EQ_INT(count(NFC_EV_ABSENT), 0);   // the chip is fine; the tag left
    const nfc_event_t *e = first(NFC_EV_UNREADABLE);
    if (e) CHECK(e->why && strcmp(e->why, "moved") == 0, "why moved");
    end_checks();
}

static void write_armed_writes_and_verifies(void) {
    setup();
    uint8_t want[NFC_TAG_BYTES];
    CHECK(nfc_tag_encode(ID, want), "encode");
    nfc_arm_write(&R, 7, ID);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 1);
    const nfc_event_t *e = first(NFC_EV_WRITE_DONE);
    if (e) {
        CHECK_EQ_INT(e->seq, 7);
        CHECK(e->ok, "ok");
        CHECK(e->why == NULL, "no why");
        CHECK(memcmp(e->uid, B.uid, 4) == 0, "uid");
    }
    CHECK(memcmp(B.sector1, want, NFC_TAG_BYTES) == 0, "the tag holds the encoding");
    CHECK_EQ_INT(*B.trailer_writes, 0);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 0);
    tag(false);
    run(3500);
    tag(true);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 1);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    e = first(NFC_EV_TAG_READ);
    if (e) CHECK(strcmp(e->disk_id, ID) == 0, "reads back the written id");
    end_checks();
}

static void write_to_locked_tag_fails_locked(void) {
    setup();
    *B.locked = true;
    nfc_arm_write(&R, 8, ID);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 1);
    const nfc_event_t *e = first(NFC_EV_WRITE_DONE);
    if (e) {
        CHECK_EQ_INT(e->seq, 8);
        CHECK(!e->ok, "not ok");
        CHECK(e->why && strcmp(e->why, "locked") == 0, "why locked");
    }
    static const uint8_t zero[NFC_TAG_BYTES];
    CHECK(memcmp(B.sector1, zero, NFC_TAG_BYTES) == 0, "untouched");
    end_checks();
}

static void write_readback_mismatch_fails_verify(void) {
    setup();
    *B.flip_next_read = true;
    nfc_arm_write(&R, 9, ID);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 1);
    const nfc_event_t *e = first(NFC_EV_WRITE_DONE);
    if (e) {
        CHECK(!e->ok, "not ok");
        CHECK(e->why && strcmp(e->why, "verify") == 0, "why verify");
    }
    end_checks();
}

static void tag_pulled_mid_write_fails_moved(void) {
    setup();
    nfc_arm_write(&R, 4, ID);
    while (B.sector1[0] != 'W' && now < 1000) run(1);
    tag(false);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 1);
    const nfc_event_t *e = first(NFC_EV_WRITE_DONE);
    if (e) {
        CHECK(!e->ok, "not ok");
        CHECK(e->why && strcmp(e->why, "moved") == 0, "why moved");
    }
    end_checks();
}

static void lying_tag_then_arm(const char *id, uint32_t seq) {
    setup();
    put_id(id);
    run(2000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    nfc_arm_write(&R, seq, ID);
    run(1000);
}

static void write_armed_over_a_lying_tag_skips_a_2s_dropout(void) {
    lying_tag_then_arm(ID2, 11);
    tag(false);
    run(2000);
    tag(true);
    run(3000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 0);
    uint8_t want[NFC_TAG_BYTES];
    nfc_tag_encode(ID2, want);
    CHECK(memcmp(B.sector1, want, NFC_TAG_BYTES) == 0, "the lying tag is untouched");
    CHECK(R.armed, "still armed");
    end_checks();
}

static void write_armed_over_a_lying_tag_waits_for_it_to_return(void) {
    lying_tag_then_arm(ID2, 12);
    tag(false);
    run(3500);
    tag(true);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 1);
    uint8_t want[NFC_TAG_BYTES];
    nfc_tag_encode(ID, want);
    CHECK(memcmp(B.sector1, want, NFC_TAG_BYTES) == 0, "written");
    end_checks();
}

static void write_armed_over_a_lying_tag_goes_to_a_different_tag_at_once(void) {
    lying_tag_then_arm(ID2, 13);
    tag(false);
    run(300);
    static const uint8_t other[4] = { 0x24, 0x19, 0xB6, 0x01 };
    memcpy(B.uid, other, 4);
    tag(true);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 1);
    const nfc_event_t *e = first(NFC_EV_WRITE_DONE);
    if (e) {
        CHECK_EQ_INT(e->seq, 13);
        CHECK(e->ok, "ok");
        CHECK(memcmp(e->uid, other, 4) == 0, "the other tag");
    }
    end_checks();
}

static void next_tag_reports_tag_next_once(void) {
    setup();
    put_next();
    run(10000);
    CHECK_EQ_INT(count(NFC_EV_TAG_NEXT), 1);
    CHECK_EQ_INT(nev, 2);
    const nfc_event_t *e = first(NFC_EV_TAG_NEXT);
    if (e) CHECK(e->disk_id[0] == '\0', "empty disk id");
    end_checks();
}

static void arm_write_next_writes_the_next_card(void) {
    setup();
    uint8_t want[NFC_TAG_BYTES];
    nfc_tag_encode_next(want);
    nfc_arm_write_next(&R, 15);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 1);
    const nfc_event_t *e = first(NFC_EV_WRITE_DONE);
    if (e) CHECK(e->ok && e->seq == 15, "ok, seq 15");
    CHECK(memcmp(B.sector1, want, NFC_TAG_BYTES) == 0, "the next payload");
    end_checks();
}

static void tap_pattern(int taps, int on_ms, int off_ms, int phase) {
    for (int k = 0; k < taps; k++) {
        if (k > 0) {
            tag(false);
            run(off_ms);
            tag(true);
        }
        run(on_ms + (k == 0 ? phase : 0));
    }
}

#define EACH_PHASE for (int phase = 0; phase < 260; phase += 10)

static void a_next_card_retapped_after_1500ms_is_five_taps(void) {
    EACH_PHASE {
        setup();
        put_next();
        tap_pattern(5, 2500, 1500, phase);
        CHECK_EQ_INT(count(NFC_EV_TAG_NEXT), 5);
        CHECK_EQ_INT(nev, 6);
        end_checks();
    }
}

static void a_disk_tag_retapped_after_1500ms_is_one_tap(void) {
    EACH_PHASE {
        setup();
        put_id(ID);
        tap_pattern(5, 2500, 1500, phase);
        CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
        CHECK_EQ_INT(nev, 2);
        end_checks();
    }
}

static void a_next_card_unseen_450ms_is_still_the_same_tap(void) {
    EACH_PHASE {
        setup();
        put_next();
        tap_pattern(2, 2500, 450, phase);
        CHECK_EQ_INT(count(NFC_EV_TAG_NEXT), 1);
        for (int g = 0; g < ngap; g++) CHECK(!gaps[g].new_arrival, "the same tap");
        end_checks();
    }
}

static void a_disk_tag_away_3100ms_is_a_new_arrival(void) {
    EACH_PHASE {
        setup();
        put_id(ID);
        tap_pattern(2, 2500, 3100, phase);
        CHECK_EQ_INT(count(NFC_EV_TAG_READ), 2);
        CHECK_EQ_INT(nev, 3);
        end_checks();
    }
}

static void a_1800ms_dropout_is_reported_once_with_its_length(void) {
    setup();
    put_id(ID);
    run(2000);
    tag(false);
    run(1800);
    tag(true);
    run(3000);
    CHECK_EQ_INT(ngap, 1);
    if (ngap >= 1) {
        CHECK(gaps[0].ms >= 1800 && gaps[0].ms <= 2400, "about 1800 ms");
        CHECK(!gaps[0].new_arrival, "still the same tap");
    }
    end_checks();
}

static void the_field_is_off_between_polls(void) {
    setup();
    tag(false);
    run(10000);
    uint32_t on = field_on_ms();
    CHECK(on > 0, "the reader still polls");
    CHECK(on < 1500, "field on under 15% of the time with no tag");
    end_checks();
}

static void the_field_is_off_between_polls_with_a_tag_held(void) {
    setup();
    put_id(ID);
    run(1000);
    uint32_t before = field_on_ms();
    run(10000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    CHECK(field_on_ms() - before < 2000, "field on under 20% of the time with a tag held");
    end_checks();
}

static void the_ops_cap_is_honoured_and_a_slow_read_reports_once(void) {
    setup();
    nfc_set_max_ops(&R, 1);
    put_id(ID);
    run_capped(3000, 10, 1);                 // 30 s, one op per pass, held throughout
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    CHECK_EQ_INT(ngap, 0);
    end_checks();
}

static void chip_vanishes_mid_read_and_comes_back(void) {
    setup();
    put_id(ID);
    while (*B.reads < 1 && now < 2000) run(1);
    if (is_pn) P.chip_present = false; else S.vanish_after_ops = S.ops;
    run(4000);
    CHECK_EQ_INT(count(NFC_EV_ABSENT), 1);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 0);
    CHECK_EQ_INT(count(NFC_EV_UNREADABLE), 0);
    CHECK(!nfc_present(&R), "absent");
    CHECK_EQ_INT(nfc_chip(&R), NFC_CHIP_NONE);
    if (is_pn) P.chip_present = true; else S.vanish_after_ops = -1;
    run(6000);
    CHECK_EQ_INT(count(NFC_EV_PRESENT), 2);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    CHECK_EQ_INT(nfc_chip(&R), B.chip);
    end_checks();
}

static void all(void) {
    RUN(present_chip_is_found_and_named);
    RUN(tag_read_reports_disk_id);
    RUN(same_tag_held_reports_once);
    RUN(tag_removed_and_returned_after_the_window_reports_twice);
    RUN(held_tag_dropout_2s_is_the_same_tap);
    RUN(blank_tag_is_not_ours);
    RUN(non_classic_tag_is_not_ours);
    RUN(locked_tag_is_unreadable_locked);
    RUN(tag_pulled_mid_read_is_unreadable_moved);
    RUN(write_armed_writes_and_verifies);
    RUN(write_to_locked_tag_fails_locked);
    RUN(write_readback_mismatch_fails_verify);
    RUN(tag_pulled_mid_write_fails_moved);
    RUN(write_armed_over_a_lying_tag_skips_a_2s_dropout);
    RUN(write_armed_over_a_lying_tag_waits_for_it_to_return);
    RUN(write_armed_over_a_lying_tag_goes_to_a_different_tag_at_once);
    RUN(next_tag_reports_tag_next_once);
    RUN(arm_write_next_writes_the_next_card);
    RUN(a_next_card_retapped_after_1500ms_is_five_taps);
    RUN(a_disk_tag_retapped_after_1500ms_is_one_tap);
    RUN(a_next_card_unseen_450ms_is_still_the_same_tap);
    RUN(a_disk_tag_away_3100ms_is_a_new_arrival);
    RUN(a_1800ms_dropout_is_reported_once_with_its_length);
    RUN(the_field_is_off_between_polls);
    RUN(the_field_is_off_between_polls_with_a_tag_held);
    RUN(the_ops_cap_is_honoured_and_a_slow_read_reports_once);
    RUN(chip_vanishes_mid_read_and_comes_back);
}

int main(void) {
    printf("== Si512 backend\n");
    is_pn = false;
    all();
    printf("== PN532 backend\n");
    is_pn = true;
    all();
    return REPORT();
}
