#include "harness.h"
#include "../src/nfc_handoff.h"
#include <pthread.h>

/*
 * The two single-slot mailboxes between the cores (spec 2026-09-25 §4.2):
 * reader events core0 -> core1, the write request core1 -> core0. Each has one
 * writer and one reader, and each is a seqlock -- the same shape as main.c's
 * ui_publish/ui_snapshot.
 */

static nfc_event_t ev_n(uint32_t n) {
    nfc_event_t e;
    memset(&e, 0, sizeof e);
    e.kind = NFC_EV_TAG_READ;
    e.uid_len = 4;
    for (int i = 0; i < 4; i++) e.uid[i] = (uint8_t)(n >> (8 * i));
    for (int i = 0; i < 36; i++) e.disk_id[i] = (char)('a' + n % 26);
    e.seq = n;
    return e;
}

static void empty_box_has_nothing(void) {
    static nfc_ev_box_t b;
    uint32_t last = 0;
    nfc_event_t e;
    CHECK(!nfc_ev_box_pending(&b, last), "nothing published");
    CHECK(!nfc_ev_box_take(&b, &last, &e), "nothing to take");
}

static void one_put_is_taken_once(void) {
    static nfc_ev_box_t b;
    uint32_t last = 0;
    nfc_event_t in = ev_n(5), out;
    nfc_ev_box_put(&b, &in);
    CHECK(nfc_ev_box_pending(&b, last), "pending after a put");
    CHECK(nfc_ev_box_take(&b, &last, &out), "taken");
    CHECK_EQ_INT(out.seq, 5);
    CHECK(memcmp(out.disk_id, in.disk_id, sizeof in.disk_id) == 0, "whole payload");
    CHECK(!nfc_ev_box_pending(&b, last), "consumed");
    CHECK(!nfc_ev_box_take(&b, &last, &out), "and not twice");
}

// The brief's rule: an unconsumed event is overwritten by a newer one.
static void a_newer_put_replaces_an_unconsumed_one(void) {
    static nfc_ev_box_t b;
    uint32_t last = 0;
    nfc_event_t a = ev_n(1), c = ev_n(2), out;
    nfc_ev_box_put(&b, &a);
    nfc_ev_box_put(&b, &c);
    CHECK(nfc_ev_box_take(&b, &last, &out), "taken");
    CHECK_EQ_INT(out.seq, 2);
    CHECK(!nfc_ev_box_take(&b, &last, &out), "the first is gone, not queued");
}

static void a_write_in_progress_is_not_taken(void) {
    static nfc_ev_box_t b;
    uint32_t last = 0;
    nfc_event_t in = ev_n(3), out;
    nfc_ev_box_put(&b, &in);
    b.seq++;                                   // the writer is half-way through the next
    CHECK(nfc_ev_box_pending(&b, last), "still worth waking for");
    CHECK(!nfc_ev_box_take(&b, &last, &out), "odd: torn, try again next pass");
    CHECK_EQ_INT(last, 0);
    b.seq++;                                   // it finished
    CHECK(nfc_ev_box_take(&b, &last, &out), "now it is taken");
}

static void write_request_box(void) {
    static nfc_wreq_box_t b;
    uint32_t last = 0;
    nfc_wreq_t r, out;
    memset(&r, 0, sizeof r);
    r.seq = 12;
    snprintf(r.disk_id, sizeof r.disk_id, "%s", "0e5c1a2b-3c4d-5e6f-8a9b-0c1d2e3f4a5b");
    snprintf(r.title, sizeof r.title, "%s", "Turrican II");
    CHECK(!nfc_wreq_box_take(&b, &last, &out), "nothing yet");
    nfc_wreq_box_put(&b, &r);
    CHECK(nfc_wreq_box_take(&b, &last, &out), "taken");
    CHECK_EQ_INT(out.seq, 12);
    CHECK(strcmp(out.disk_id, r.disk_id) == 0, "the id");
    CHECK(strcmp(out.title, r.title) == 0, "the title");
    CHECK(!nfc_wreq_box_take(&b, &last, &out), "once");
    // A disarm is a request with no disk.
    memset(&r, 0, sizeof r);
    r.seq = 13;
    nfc_wreq_box_put(&b, &r);
    CHECK(nfc_wreq_box_take(&b, &last, &out), "the disarm");
    CHECK(out.disk_id[0] == '\0', "empty id = disarm");
}

// Torn-read safety under a real second thread: every event the reader accepts
// must be one the writer wrote whole. Each event's fields are all derived from
// one counter, so a mix of two writes shows up as fields that disagree.
static nfc_ev_box_t g_box;
static volatile int g_stop;

static void *writer(void *arg) {
    (void)arg;
    for (uint32_t n = 1; !g_stop; n++) {
        nfc_event_t e = ev_n(n);
        nfc_ev_box_put(&g_box, &e);
    }
    return NULL;
}

static bool whole(const nfc_event_t *e) {
    for (int i = 0; i < 4; i++)
        if (e->uid[i] != (uint8_t)(e->seq >> (8 * i))) return false;
    for (int i = 0; i < 36; i++)
        if (e->disk_id[i] != (char)('a' + e->seq % 26)) return false;
    return true;
}

static void no_torn_event_is_ever_accepted(void) {
    pthread_t t;
    g_stop = 0;
    CHECK(pthread_create(&t, NULL, writer, NULL) == 0, "thread");
    uint32_t last = 0, taken = 0, torn = 0, prev = 0;
    bool ordered = true;
    for (int i = 0; i < 2000000 && taken < 20000; i++) {
        nfc_event_t e;
        if (!nfc_ev_box_take(&g_box, &last, &e)) continue;
        taken++;
        if (!whole(&e)) torn++;
        if (e.seq <= prev) ordered = false;
        prev = e.seq;
    }
    g_stop = 1;
    pthread_join(t, NULL);
    CHECK(taken > 0, "the reader saw events at all");
    CHECK_EQ_INT(torn, 0);
    CHECK(ordered, "never an older event after a newer one");
}

int main(void) {
    RUN(empty_box_has_nothing);
    RUN(one_put_is_taken_once);
    RUN(a_newer_put_replaces_an_unconsumed_one);
    RUN(a_write_in_progress_is_not_taken);
    RUN(write_request_box);
    RUN(no_torn_event_is_ever_accepted);
    return REPORT();
}
