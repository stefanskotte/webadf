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

// A 4-byte-UID tag that is not a MIFARE Classic (SAK without bit 3) is a
// kind this reader does not handle: "not supported", not "not a disk tag".
static void non_classic_tag_is_not_supported(void) {
    setup();
    *B.sak = 0x04;
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_NOT_SUPPORTED), 1);
    CHECK_EQ_INT(count(NFC_EV_NOT_OURS), 0);
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


// ---- NFC Forum Type 2 tags: NTAG213/215/216 ---------------------------------------
//
// The tester's NTAG215 (2026-10-19): ATQA 0x0044, SAK 0x00, 7-byte UID
// 04:B3:2F:3E:34:02:89, 135 pages. The payload is nfc_tag.h's 48 bytes in
// pages 4-15; no auth; pages 0-3 and the configuration pages are never written.

static const uint8_t U7[7]  = { 0x04, 0xB3, 0x2F, 0x3E, 0x34, 0x02, 0x89 };
// The same first four bytes: only a 7-byte comparison tells them apart.
static const uint8_t U7B[7] = { 0x04, 0xB3, 0x2F, 0x3E, 0x99, 0x98, 0x97 };

static void use_ntag(int pages, const uint8_t uid[7]) {
    if (is_pn) { pn532_fake_ntag(&P, pages, uid); B.sector1 = P.mem + 16; }
    else       { si512_fake_ntag(&S, pages, uid); B.sector1 = S.mem + 16; }
}
static int ntag_pages(void)  { return is_pn ? P.ntag_pages : S.ntag_pages; }
static int page_writes(void) { return is_pn ? P.page_writes : S.page_writes; }
static int low_writes(void)  { return is_pn ? P.low_page_writes : S.low_page_writes; }
static int cfg_writes(void)  { return is_pn ? P.cfg_page_writes : S.cfg_page_writes; }
static int max_page(void)    { return is_pn ? P.max_page_written : S.max_page_written; }
static int compat(void)      { return is_pn ? P.compat_writes : S.compat_writes; }
static void protect(bool on) { if (is_pn) P.write_protected = on; else S.write_protected = on; }
static void ntag_uid(const uint8_t uid[7]) { memcpy(B.uid, uid, 7); }

// No WRITE ever aimed at pages 0-3 (UID, lock bytes, CC) or at the dynamic
// lock / configuration pages, and no COMPATIBILITY WRITE.
static void no_forbidden_writes(void) {
    CHECK_EQ_INT(low_writes(), 0);
    CHECK_EQ_INT(cfg_writes(), 0);
    CHECK_EQ_INT(compat(), 0);
}

static void ntag_disk_tag_is_read_with_its_7_byte_uid(void) {
    setup();
    use_ntag(135, U7);
    put_id(ID);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    CHECK_EQ_INT(nev, 2);
    const nfc_event_t *e = first(NFC_EV_TAG_READ);
    if (e) {
        CHECK(strcmp(e->disk_id, ID) == 0, "disk id");
        CHECK_EQ_INT(e->uid_len, 7);
        CHECK(memcmp(e->uid, U7, 7) == 0, "the whole 7-byte uid");
    }
    no_forbidden_writes();
    end_checks();
}

static void ntag_blank_is_not_a_disk_tag(void) {
    setup();
    use_ntag(135, U7);                       // factory: 03 00 FE in page 4
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_NOT_OURS), 1);
    CHECK_EQ_INT(count(NFC_EV_NOT_SUPPORTED), 0);
    CHECK_EQ_INT(nev, 2);
    const nfc_event_t *e = first(NFC_EV_NOT_OURS);
    if (e) CHECK(e->uid_len == 7 && memcmp(e->uid, U7, 7) == 0, "uid");
    end_checks();
}

static void ntag_next_card_reports_tag_next(void) {
    setup();
    use_ntag(135, U7);
    put_next();
    run(10000);
    CHECK_EQ_INT(count(NFC_EV_TAG_NEXT), 1);
    CHECK_EQ_INT(nev, 2);
    end_checks();
}

static void ntag_armed_write_writes_pages_4_to_15_and_verifies(void) {
    setup();
    use_ntag(135, U7);
    uint8_t cc[4];
    memcpy(cc, B.sector1 - 4, 4);            // page 3
    uint8_t want[NFC_TAG_BYTES];
    CHECK(nfc_tag_encode(ID, want), "encode");
    nfc_arm_write(&R, 21, ID);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 1);
    const nfc_event_t *e = first(NFC_EV_WRITE_DONE);
    if (e) {
        CHECK_EQ_INT(e->seq, 21);
        CHECK(e->ok, "ok");
        CHECK(e->why == NULL, "no why");
        CHECK(e->uid_len == 7 && memcmp(e->uid, U7, 7) == 0, "uid");
    }
    CHECK(memcmp(B.sector1, want, NFC_TAG_BYTES) == 0, "pages 4-15 hold the encoding");
    CHECK_EQ_INT(page_writes(), 12);         // one WRITE per page, each once
    CHECK_EQ_INT(max_page(), 15);
    CHECK(memcmp(B.sector1 - 4, cc, 4) == 0, "the CC is untouched");
    no_forbidden_writes();
    // Lifted and tapped again: it reads as the disk.
    tag(false);
    run(3500);
    tag(true);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    e = first(NFC_EV_TAG_READ);
    if (e) CHECK(strcmp(e->disk_id, ID) == 0, "reads back the written id");
    end_checks();
}

static void ntag_next_card_can_be_written(void) {
    setup();
    use_ntag(135, U7);
    uint8_t want[NFC_TAG_BYTES];
    nfc_tag_encode_next(want);
    nfc_arm_write_next(&R, 22);
    run(1000);
    const nfc_event_t *e = first(NFC_EV_WRITE_DONE);
    CHECK(e && e->ok && e->seq == 22, "ok, seq 22");
    CHECK(memcmp(B.sector1, want, NFC_TAG_BYTES) == 0, "the next payload");
    no_forbidden_writes();
    end_checks();
}

// NTAG213 is the smallest: 45 pages, user memory 4-39 (144 bytes), the
// dynamic lock at 0x28. The 48-byte payload fits, and nothing past 15 is written.
static void ntag213_holds_the_payload_and_no_config_page_is_written(void) {
    setup();
    use_ntag(45, U7);
    CHECK(NFC_TAG_BYTES <= 144, "the payload fits NTAG213's user memory");
    nfc_arm_write(&R, 23, ID);
    run(1000);
    const nfc_event_t *e = first(NFC_EV_WRITE_DONE);
    CHECK(e && e->ok, "written");
    CHECK(max_page() <= 39, "inside NTAG213's user pages");
    CHECK_EQ_INT(ntag_pages(), 45);
    no_forbidden_writes();
    tag(false);
    run(3500);
    tag(true);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    end_checks();
}

static void ntag_write_protected_fails_locked(void) {
    setup();
    use_ntag(135, U7);
    protect(true);
    nfc_arm_write(&R, 24, ID);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 1);
    const nfc_event_t *e = first(NFC_EV_WRITE_DONE);
    if (e) {
        CHECK(!e->ok, "not ok");
        CHECK(e->why && strcmp(e->why, "locked") == 0, "why locked");
    }
    CHECK_EQ_INT(page_writes(), 0);
    no_forbidden_writes();
    end_checks();
}

static void ntag_readback_mismatch_fails_verify(void) {
    setup();
    use_ntag(135, U7);
    *B.flip_next_read = true;
    nfc_arm_write(&R, 25, ID);
    run(1000);
    const nfc_event_t *e = first(NFC_EV_WRITE_DONE);
    CHECK(e && !e->ok && e->why && strcmp(e->why, "verify") == 0, "why verify");
    end_checks();
}

static void ntag_pulled_mid_write_fails_moved(void) {
    setup();
    use_ntag(135, U7);
    nfc_arm_write(&R, 26, ID);
    while (page_writes() < 5 && now < 1000) run(1);
    tag(false);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 1);
    const nfc_event_t *e = first(NFC_EV_WRITE_DONE);
    CHECK(e && !e->ok && e->why && strcmp(e->why, "moved") == 0, "why moved");
    no_forbidden_writes();
    end_checks();
}

static void ntag_held_reports_once_and_a_retap_after_the_window_twice(void) {
    setup();
    use_ntag(135, U7);
    put_id(ID);
    run(10000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    CHECK_EQ_INT(*B.reads, 3);               // held, it is not read again
    tag(false);
    run(2000);                               // a 2 s dropout: the same tap
    tag(true);
    run(3000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    CHECK_EQ_INT(ngap, 1);
    if (ngap >= 1) CHECK(gaps[0].uid_len == 7 && memcmp(gaps[0].uid, U7, 7) == 0, "the gap names all 7 bytes");
    tag(false);
    run(3500);                               // gone for the whole window
    tag(true);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 2);
    end_checks();
}

static void ntags_sharing_their_first_4_uid_bytes_are_different_tags(void) {
    EACH_PHASE {
        setup();
        use_ntag(135, U7);
        put_id(ID);
        run(2000 + phase);
        CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
        tag(false);
        run(300);                            // well inside the 3 s window
        ntag_uid(U7B);
        put_id(ID2);
        tag(true);
        run(1000);
        CHECK_EQ_INT(count(NFC_EV_TAG_READ), 2);
        const nfc_event_t *e = nev >= 3 ? &evs[2] : NULL;
        if (e) {
            CHECK(strcmp(e->disk_id, ID2) == 0, "the second tag's own id");
            CHECK(memcmp(e->uid, U7B, 7) == 0, "the second uid");
        }
        end_checks();
    }
}

static void an_armed_write_goes_at_once_to_an_ntag_differing_only_in_uid_bytes_4_to_6(void) {
    setup();
    use_ntag(135, U7);
    put_id(ID2);
    run(2000);
    nfc_arm_write(&R, 27, ID);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 0);   // the tag lying there is not written
    tag(false);
    run(300);
    ntag_uid(U7B);
    tag(true);
    run(1000);
    const nfc_event_t *e = first(NFC_EV_WRITE_DONE);
    CHECK(e && e->ok && e->seq == 27, "written");
    if (e) CHECK(memcmp(e->uid, U7B, 7) == 0, "to the other tag");
    no_forbidden_writes();
    end_checks();
}

// The 4-byte Classic and a 7-byte NTAG whose first bytes match are different
// -- even one whose last three bytes are zero, where only the length differs.
static void a_classic_and_an_ntag_are_different_tags(void) {
    setup();
    static const uint8_t c4[4] = { 0x04, 0xB3, 0x2F, 0x3E };
    static const uint8_t z7[7] = { 0x04, 0xB3, 0x2F, 0x3E, 0x00, 0x00, 0x00 };
    memcpy(B.uid, c4, 4);
    put_id(ID);
    run(2000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    tag(false);
    run(300);
    use_ntag(135, z7);
    put_id(ID2);
    tag(true);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 2);
    end_checks();
}

static void ntag_under_a_one_op_cap_reads_once(void) {
    setup();
    nfc_set_max_ops(&R, 1);
    use_ntag(135, U7);
    put_id(ID);
    run_capped(3000, 10, 1);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    CHECK_EQ_INT(ngap, 0);
    end_checks();
}

static void ntag_field_is_off_between_polls_while_held(void) {
    setup();
    use_ntag(135, U7);
    put_id(ID);
    run(1000);
    uint32_t before = field_on_ms();
    run(10000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    CHECK(field_on_ms() - before < 2000, "field on under 20% of the time with an NTAG held");
    end_checks();
}

// Any other kind -- an ISO-DEP card (SAK 0x20), a 7-byte MIFARE Classic, a
// DESFire -- is "not supported", and never "not a disk tag".
static void other_tag_kinds_are_not_supported(void) {
    static const uint8_t saks4[] = { 0x20, 0x00, 0x10 };
    for (int k = 0; k < 3; k++) {
        setup();
        *B.sak = saks4[k];                   // 4-byte UID
        run(1000);
        CHECK_EQ_INT(count(NFC_EV_NOT_SUPPORTED), 1);
        CHECK_EQ_INT(count(NFC_EV_NOT_OURS), 0);
        end_checks();
    }
    static const uint8_t saks7[] = { 0x20, 0x08, 0x18 };
    for (int k = 0; k < 3; k++) {
        setup();
        use_ntag(135, U7);
        *B.sak = saks7[k];                   // 7-byte UID, not Type 2
        run(1000);
        CHECK_EQ_INT(count(NFC_EV_NOT_SUPPORTED), 1);
        CHECK_EQ_INT(count(NFC_EV_NOT_OURS), 0);
        const nfc_event_t *e = first(NFC_EV_NOT_SUPPORTED);
        if (e) CHECK(e->uid_len == 7 && memcmp(e->uid, U7, 7) == 0, "uid");
        CHECK_EQ_INT(page_writes(), 0);
        end_checks();
    }
}

static void an_armed_write_skips_an_unsupported_tag_and_stays_armed(void) {
    setup();
    *B.sak = 0x20;
    nfc_arm_write(&R, 28, ID);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_NOT_SUPPORTED), 1);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 0);
    CHECK(R.armed, "still armed");
    end_checks();
}

static void all(void) {
    RUN(present_chip_is_found_and_named);
    RUN(tag_read_reports_disk_id);
    RUN(same_tag_held_reports_once);
    RUN(tag_removed_and_returned_after_the_window_reports_twice);
    RUN(held_tag_dropout_2s_is_the_same_tap);
    RUN(blank_tag_is_not_ours);
    RUN(non_classic_tag_is_not_supported);
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
    RUN(ntag_disk_tag_is_read_with_its_7_byte_uid);
    RUN(ntag_blank_is_not_a_disk_tag);
    RUN(ntag_next_card_reports_tag_next);
    RUN(ntag_armed_write_writes_pages_4_to_15_and_verifies);
    RUN(ntag_next_card_can_be_written);
    RUN(ntag213_holds_the_payload_and_no_config_page_is_written);
    RUN(ntag_write_protected_fails_locked);
    RUN(ntag_readback_mismatch_fails_verify);
    RUN(ntag_pulled_mid_write_fails_moved);
    RUN(ntag_held_reports_once_and_a_retap_after_the_window_twice);
    RUN(ntags_sharing_their_first_4_uid_bytes_are_different_tags);
    RUN(an_armed_write_goes_at_once_to_an_ntag_differing_only_in_uid_bytes_4_to_6);
    RUN(a_classic_and_an_ntag_are_different_tags);
    RUN(ntag_under_a_one_op_cap_reads_once);
    RUN(ntag_field_is_off_between_polls_while_held);
    RUN(other_tag_kinds_are_not_supported);
    RUN(an_armed_write_skips_an_unsupported_tag_and_stays_armed);
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
