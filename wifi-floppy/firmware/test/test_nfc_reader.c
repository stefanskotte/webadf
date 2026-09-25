#include "harness.h"
#include "si512_fake.h"
#include "../src/nfc_reader.h"

// Two ids with the disk-id shape (a UUIDv5: '5' at 14, [89ab] at 19).
static const char *ID  = "0123abcd-4567-5abc-8def-0123456789ab";
static const char *ID2 = "fedcba98-7654-5321-9abc-def012345678";

static uint32_t now;
static uint32_t clk(void) { return now; }

static si512_fake_t F;
static nfc_reader_t R;
static nfc_event_t evs[64];
static int nev;
static int budget_breaks;

static void setup(void) {
    now = 0;
    nev = 0;
    budget_breaks = 0;
    si512_fake_init(&F, &now);
    nfc_bus_t bus = si512_fake_bus(&F);
    nfc_init(&R, &bus, clk);
}

// One step per millisecond. After EVERY step: the reader used at most
// NFC_MAX_OPS_PER_STEP operations, and the count it returned is the count
// the bus saw -- this is the budget test, run inside every other test.
static void run(int ms) {
    for (int k = 0; k < ms; k++) {
        int before = F.ops;
        int n = nfc_step(&R);
        if (n > NFC_MAX_OPS_PER_STEP || F.ops - before != n) {
            if (budget_breaks++ == 0)
                printf("  budget: step at %u ms returned %d, bus saw %d\n",
                       (unsigned)now, n, F.ops - before);
        }
        nfc_event_t e;
        if (nfc_take_event(&R, &e) && nev < 64) evs[nev++] = e;
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

static void end_checks(void) { CHECK_EQ_INT(budget_breaks, 0); }

static void put_id(const char *id) { CHECK(nfc_tag_encode(id, F.sector1), "encode"); }

// The op index at which a clean run first sends a READ -- so a fault can be
// placed inside the READ states without hard-coding the reader's op counts.
static int first_read_op(void) {
    setup();
    put_id(ID);
    run(1000);
    return F.first_read_at;
}

static void absent_chip_stays_absent_and_rechecks(void) {
    setup();
    F.vanish_after_ops = 0;
    run(10000);
    CHECK_EQ_INT(nev, 0);
    CHECK_EQ_INT(F.version_reads, 2);        // at 0 s and at 5 s
    CHECK_EQ_INT(F.ops, 2);                  // and nothing else
    CHECK(!nfc_present(&R), "absent");
    end_checks();
}

static void present_chip_inits_and_emits_present(void) {
    setup();
    F.tag_present = false;
    run(1000);
    CHECK_EQ_INT(nev, 1);
    CHECK_EQ_INT(count(NFC_EV_PRESENT), 1);
    CHECK(nfc_present(&R), "present");
    CHECK(F.initiator_at >= 0, "ControlReg Initiator written");
    CHECK(F.txcontrol_at > F.initiator_at, "Initiator before any TxControlReg write");
    // The init took: the soft reset's ModeReg 0x3B was replaced by 0x3D.
    CHECK_EQ_INT(F.reg[0x11], 0x3D);
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
        CHECK(memcmp(e->uid, F.uid, 4) == 0, "uid");
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
    CHECK_EQ_INT(F.reads, 3);                // held, it is not read again either
    end_checks();
}

static void tag_removed_and_returned_reports_twice(void) {
    setup();
    put_id(ID);
    run(2000);
    F.tag_present = false;
    run(2000);
    F.tag_present = true;
    run(2000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 2);
    CHECK_EQ_INT(nev, 3);
    end_checks();
}

static void blank_tag_is_not_ours(void) {
    setup();
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_NOT_OURS), 1);
    CHECK_EQ_INT(nev, 2);
    const nfc_event_t *e = first(NFC_EV_NOT_OURS);
    if (e) CHECK(memcmp(e->uid, F.uid, 4) == 0 && e->uid_len == 4, "uid");
    end_checks();
}

static void locked_tag_is_unreadable_locked(void) {
    setup();
    put_id(ID);
    F.locked = true;
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_UNREADABLE), 1);
    CHECK_EQ_INT(nev, 2);
    const nfc_event_t *e = first(NFC_EV_UNREADABLE);
    if (e) CHECK(e->why && strcmp(e->why, "locked") == 0, "why locked");
    end_checks();
}

static void chip_vanishes_mid_read(void) {
    int at = first_read_op();
    CHECK(at > 0, "a clean run reads");
    setup();
    put_id(ID);
    F.vanish_after_ops = at + 3;             // inside the first READ's exchange
    run(4000);
    CHECK_EQ_INT(count(NFC_EV_PRESENT), 1);
    CHECK_EQ_INT(count(NFC_EV_ABSENT), 1);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 0);
    CHECK_EQ_INT(count(NFC_EV_UNREADABLE), 0);
    CHECK_EQ_INT(count(NFC_EV_NOT_OURS), 0);
    CHECK(!nfc_present(&R), "absent");
    // It comes back: a fresh PRESENT, and the half-read tag is read whole --
    // nothing of the lost attempt (not even its debounce) survived.
    F.vanish_after_ops = -1;
    run(3000);
    CHECK_EQ_INT(count(NFC_EV_PRESENT), 2);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
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
        CHECK(memcmp(e->uid, F.uid, 4) == 0, "uid");
    }
    CHECK(memcmp(F.sector1, want, NFC_TAG_BYTES) == 0, "the tag holds the encoding");
    CHECK_EQ_INT(F.trailer_writes, 0);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 0);
    // Away 1.5 s, back: a plain read now -- the write disarmed itself.
    F.tag_present = false;
    run(1500);
    F.tag_present = true;
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 1);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    e = first(NFC_EV_TAG_READ);
    if (e) CHECK(strcmp(e->disk_id, ID) == 0, "reads back the written id");
    end_checks();
}

static void write_to_locked_tag_fails_locked(void) {
    setup();
    F.locked = true;
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
    CHECK(memcmp(F.sector1, zero, NFC_TAG_BYTES) == 0, "untouched");
    end_checks();
}

static void write_readback_mismatch_fails_verify(void) {
    setup();
    F.flip_next_read = true;
    nfc_arm_write(&R, 9, ID);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 1);
    const nfc_event_t *e = first(NFC_EV_WRITE_DONE);
    if (e) {
        CHECK_EQ_INT(e->seq, 9);
        CHECK(!e->ok, "not ok");
        CHECK(e->why && strcmp(e->why, "verify") == 0, "why verify");
    }
    end_checks();
}

static void disarm_before_tag_means_plain_read(void) {
    setup();
    put_id(ID2);
    nfc_arm_write(&R, 3, ID);
    nfc_disarm(&R);
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 0);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    const nfc_event_t *e = first(NFC_EV_TAG_READ);
    if (e) CHECK(strcmp(e->disk_id, ID2) == 0, "the tag's own id");
    uint8_t want[NFC_TAG_BYTES];
    nfc_tag_encode(ID2, want);
    CHECK(memcmp(F.sector1, want, NFC_TAG_BYTES) == 0, "untouched");
    end_checks();
}

// ---- beyond the brief's twelve --------------------------------------------

static void non_classic_tag_is_not_ours(void) {
    setup();
    F.sak = 0x04;                            // an NTAG's cascade-level-1 SAK
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_NOT_OURS), 1);
    CHECK_EQ_INT(count(NFC_EV_UNREADABLE), 0);
    end_checks();
}

static void tag_pulled_mid_read_is_unreadable_moved(void) {
    int at = first_read_op();
    setup();
    put_id(ID);
    F.tag_leaves_after_ops = at;
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_UNREADABLE), 1);
    CHECK_EQ_INT(count(NFC_EV_ABSENT), 0);   // the chip is fine; the tag left
    const nfc_event_t *e = first(NFC_EV_UNREADABLE);
    if (e) CHECK(e->why && strcmp(e->why, "moved") == 0, "why moved");
    end_checks();
}

static void tag_pulled_mid_write_fails_moved(void) {
    // Leaves after the first block is written: part of the tag is new.
    setup();
    nfc_arm_write(&R, 4, ID);
    while (F.sector1[0] != 'W' && now < 1000) run(1);
    F.tag_present = false;
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 1);
    const nfc_event_t *e = first(NFC_EV_WRITE_DONE);
    if (e) {
        CHECK(!e->ok, "not ok");
        CHECK(e->why && strcmp(e->why, "moved") == 0, "why moved");
    }
    end_checks();
}

static void two_failed_transfers_are_not_a_loss(void) {
    setup();
    put_id(ID);
    while (F.first_read_at < 0 && now < 1000) run(1);
    F.vanish_after_ops = F.ops;              // the next two steps each fail once
    run(2);
    F.vanish_after_ops = -1;
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_ABSENT), 0);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    end_checks();
}

static void bad_id_is_refused_not_written(void) {
    setup();
    nfc_arm_write(&R, 5, "not-a-disk-id");
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_WRITE_DONE), 1);
    const nfc_event_t *e = first(NFC_EV_WRITE_DONE);
    if (e) {
        CHECK_EQ_INT(e->seq, 5);
        CHECK(!e->ok, "not ok");
        CHECK(e->why && strcmp(e->why, "bad data") == 0, "why bad data");
    }
    CHECK_EQ_INT(count(NFC_EV_NOT_OURS), 1);  // the blank tag was read instead
    end_checks();
}

static void untaken_event_holds_the_reader(void) {
    setup();
    put_id(ID);
    int idle_ops = 0;
    CHECK(nfc_step(&R) <= NFC_MAX_OPS_PER_STEP, "budget");   // finds the chip
    for (now = 1; now < 1000; now++) idle_ops += nfc_step(&R);   // nobody takes PRESENT
    CHECK_EQ_INT(idle_ops, 0);
    nfc_event_t e;
    CHECK(nfc_take_event(&R, &e) && e.kind == NFC_EV_PRESENT, "PRESENT kept");
    CHECK(!nfc_take_event(&R, &e), "one slot");
    run(1000);
    CHECK_EQ_INT(count(NFC_EV_TAG_READ), 1);
    end_checks();
}

int main(void) {
    RUN(absent_chip_stays_absent_and_rechecks);
    RUN(present_chip_inits_and_emits_present);
    RUN(tag_read_reports_disk_id);
    RUN(same_tag_held_reports_once);
    RUN(tag_removed_and_returned_reports_twice);
    RUN(blank_tag_is_not_ours);
    RUN(locked_tag_is_unreadable_locked);
    RUN(chip_vanishes_mid_read);
    RUN(write_armed_writes_and_verifies);
    RUN(write_to_locked_tag_fails_locked);
    RUN(write_readback_mismatch_fails_verify);
    RUN(disarm_before_tag_means_plain_read);
    RUN(non_classic_tag_is_not_ours);
    RUN(tag_pulled_mid_read_is_unreadable_moved);
    RUN(tag_pulled_mid_write_fails_moved);
    RUN(two_failed_transfers_are_not_a_loss);
    RUN(bad_id_is_refused_not_written);
    RUN(untaken_event_holds_the_reader);
    return REPORT();
}
