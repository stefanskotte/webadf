#include "harness.h"
#include "transport_fake.h"
#include "../src/uploader.h"
#include "../src/device_client.h"
#include "../src/psram_image.h"
#include "../src/mfm.h"
#include "../src/sha256.h"
#include "../src/wf_log.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#define TB MFM_TRACK_DATA_BYTES                  // 5632
static uint8_t adf[NUM_TRACKS * TB];             // what the board holds, decoded
static device_client_t c;
static uploader_t u;
static uint32_t gen, last_ms;
static bool gen_moves;                           // Task 6: a write lands mid-hash
// Final review F1: runs just AFTER write_gen() has been read -- the moment
// core0 can start a store between the uploader's read and whatever the
// uploader does next (its hash, or its close).
static void (*after_gen_read)(void);
static uint32_t write_gen(void) {
    uint32_t g = gen_moves ? gen++ : gen;
    if (after_gen_read) { void (*f)(void) = after_gen_read; after_gen_read = NULL; f(); }
    return g;
}
static uint32_t last_write(void) { return last_ms; }

// Everything the uploader logged, drained into one buffer: the WARN/ERROR
// lines are behaviour too -- the operator's only view of a park or a
// refused request.
static char logbuf[16384];
static void log_sink(const char *line) {
    size_t n = strlen(logbuf);
    snprintf(logbuf + n, sizeof logbuf - n, "%s\n", line);
}
static const char *logs(void) { wf_log_drain(1000); return logbuf; }

static void store_track(int t, const uint8_t *data, bool dirty) {
    static uint8_t mfm[MFM_TRACK_BYTES];
    uint32_t bits = mfm_encode_track(data, (uint8_t)t, mfm);
    if (dirty) { psram_image_mark_dirty(0, t, mfm, bits); return; }
    psram_image_write_at(0, t, 0, mfm, (int)((bits + 7) / 8));
    psram_image_commit(0, t, bits);
}

// A mounted disk in slot 0, every track present and clean, then the Amiga's
// writes on top: the image the board would hold after a save.
static void mounted(void) {
    fake_reset(); fake_set_clock(10000);
    wf_log_test_reset(); wf_log_test_set_sink(log_sink); logbuf[0] = '\0';
    psram_image_reset_slot(0); psram_image_reset_slot(1);
    for (int t = 0; t < NUM_TRACKS; t++) {
        for (int i = 0; i < TB; i++) adf[t * TB + i] = (uint8_t)(t * 7 + i);
        store_track(t, adf + t * TB, false);
    }
    psram_publish_slot(0);
    dc_init(&c, fake_transport(), fake_clock_ms, "h", "tok");
    strcpy(c.mounted_sha256, "aa"); strcpy(c.mounted_disk_id, "d1");
    c.mounted_version = 7; c.since = 7;
    gen = 0; last_ms = 10000; gen_moves = false; after_gen_read = NULL;
    up_init(&u, &c, "boot-abc", write_gen, last_write);
}

// core0's store, as main.c does it (write_back_gen_begin/_end): the
// generation is odd for the whole store and even once it has settled.
static void amiga_writes(int t, uint8_t fill) {
    gen++;
    memset(adf + t * TB, fill, TB);
    store_track(t, adf + t * TB, true);
    last_ms = fake_clock_ms(); gen++;
}

static void push_json(const char *status, const char *body) {
    static char r[512];
    snprintf(r, sizeof r, "%s\r\nContent-Length: %zu\r\n\r\n%s", status, strlen(body), body);
    fake_push_response(r);
}

/* ---- HD (HD writes spec §4.4) ------------------------------------------- */

#define HB MFM_HD_TRACK_DATA_BYTES                // 11264
static uint8_t hd_adf[NUM_TRACKS * HB];          // the HD disk the board holds

// An HD disk in slot 0: an ADF_HD slot of ADF bytes (not MFM), every track
// present and clean. Otherwise exactly mounted().
static void mounted_hd(void) {
    fake_reset(); fake_set_clock(10000);
    wf_log_test_reset(); wf_log_test_set_sink(log_sink); logbuf[0] = '\0';
    psram_image_reset_slot(0); psram_image_reset_slot(1);
    psram_image_set_slot_kind(0, SLOT_KIND_ADF_HD);
    for (int t = 0; t < NUM_TRACKS; t++) {
        for (int i = 0; i < HB; i++) hd_adf[t * HB + i] = (uint8_t)(t * 3 + i * 5);
        psram_image_write_at(0, t, 0, hd_adf + t * HB, HB);
        psram_image_commit(0, t, HB * 8u);
    }
    psram_publish_slot(0);
    dc_init(&c, fake_transport(), fake_clock_ms, "h", "tok");
    strcpy(c.mounted_sha256, "aa"); strcpy(c.mounted_disk_id, "d1");
    c.mounted_version = 7; c.since = 7;
    gen = 0; last_ms = 10000; gen_moves = false; after_gen_read = NULL;
    up_init(&u, &c, "boot-abc", write_gen, last_write);
}

static void amiga_writes_hd(int t, uint8_t fill) {
    memset(hd_adf + t * HB, fill, HB);
    gen++;
    CHECK(psram_image_store_adf(0, t, hd_adf + t * HB), "core0 stored the verified track");
    last_ms = fake_clock_ms(); gen++;
}

static void hd_digest(char hex[65]) {
    sha256_t s; uint8_t d[32];
    sha256_init(&s); sha256_update(&s, hd_adf, sizeof hd_adf); sha256_final(&s, d);
    sha256_hex(d, hex);
}

static void an_hd_track_is_uploaded_as_its_stored_bytes(void) {
    mounted_hd();
    amiga_writes_hd(159, 0x5a);
    push_json("HTTP/1.1 200 OK", "{\"staged\":159}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK(strstr(fake_last_request(),
        "POST /api/device/write?disk=d1&mount=7&track=159&session=boot-abc&seq=1 HTTP/1.1") != NULL,
        "the protocol's query, verbatim");
    CHECK(strstr(fake_last_request(), "Content-Length: 11264") != NULL, "an HD track's 11,264 bytes");
    int n = fake_last_request_len();
    CHECK(memcmp(fake_last_request() + n - HB, hd_adf + 159 * HB, HB) == 0,
          "the stored ADF bytes, byte for byte -- no re-decode");
    CHECK_EQ_INT(psram_image_state(0, 159), TRK_PRESENT);
}

static void an_hd_close_hashes_160_tracks_of_11264_bytes(void) {
    mounted_hd();
    amiga_writes_hd(40, 0x77);
    push_json("HTTP/1.1 200 OK", "{\"staged\":40}");
    up_step(&u);
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
    char want[65]; hd_digest(want);
    char body[128]; snprintf(body, sizeof body, "{\"sha256\":\"%s\"}", want);
    push_json("HTTP/1.1 200 OK", body);
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    char line[256];
    snprintf(line, sizeof line,
        "POST /api/device/write/close?disk=d1&mount=7&session=boot-abc&seq=1&sha256=%s HTTP/1.1", want);
    CHECK(strstr(fake_last_request(), line) != NULL,
          "the digest of the HD image the server will hold: 160 x 11,264 bytes");
    CHECK(strcmp(c.mounted_sha256, want) == 0, "adopted, no re-fetch");
    CHECK(!u.open, "closed");
}

static void an_offline_hd_write_is_kept_and_sent_later(void) {
    mounted_hd();
    amiga_writes_hd(7, 0x33);
    fake_push_connect_failure();
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK_EQ_INT(psram_image_state(0, 7), TRK_DIRTY);
    CHECK_EQ_INT(up_sync(&u), UP_OFFLINE);
    fake_set_clock(fake_clock_ms() + u.backoff_ms);
    push_json("HTTP/1.1 200 OK", "{\"staged\":7}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    int n = fake_last_request_len();
    CHECK(memcmp(fake_last_request() + n - HB, hd_adf + 7 * HB, HB) == 0, "the same bytes, once back online");
    CHECK_EQ_INT(psram_image_state(0, 7), TRK_PRESENT);
}

static void nothing_to_do_without_writes(void) {
    mounted();
    CHECK(!up_has_work(&u), "a clean disk needs no uploader");
    CHECK_EQ_INT(up_step(&u), UP_NOTHING);
    CHECK_EQ_INT(fake_request_count(), 0);
    CHECK_EQ_INT(up_sync(&u), UP_SYNCED);
}

static void a_dirty_track_is_uploaded_whole(void) {
    mounted();
    amiga_writes(40, 0x5a);
    CHECK(up_has_work(&u), "work");
    CHECK_EQ_INT(up_sync(&u), UP_PENDING);
    push_json("HTTP/1.1 200 OK", "{\"staged\":40}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK(strstr(fake_last_request(),
        "POST /api/device/write?disk=d1&mount=7&track=40&session=boot-abc&seq=1 HTTP/1.1") != NULL,
        "the protocol's query, verbatim");
    CHECK(strstr(fake_last_request(), "Content-Type: application/octet-stream") != NULL, "type");
    int n = fake_last_request_len();
    CHECK(memcmp(fake_last_request() + n - TB, adf + 40 * TB, TB) == 0,
          "the body is the decoded track, byte for byte");
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_PRESENT);
    CHECK_EQ_INT(u.seq, 1);
    CHECK(u.open, "session open until the close");
}

static void tracks_go_in_order_with_rising_seq(void) {
    mounted();
    amiga_writes(80, 1); amiga_writes(2, 2);
    push_json("HTTP/1.1 200 OK", "{\"staged\":2}");
    push_json("HTTP/1.1 200 OK", "{\"staged\":80}");
    up_step(&u);
    CHECK(strstr(fake_last_request(), "track=2&session=boot-abc&seq=1") != NULL, "lowest first");
    up_step(&u);
    CHECK(strstr(fake_last_request(), "track=80&session=boot-abc&seq=2") != NULL, "then the next");
}

static void the_mount_is_fixed_for_the_session(void) {
    mounted();
    amiga_writes(3, 1); amiga_writes(4, 2);
    push_json("HTTP/1.1 200 OK", "{\"staged\":3}");
    push_json("HTTP/1.1 200 OK", "{\"staged\":4}");
    up_step(&u);
    c.mounted_version = 8;                            // a bump acknowledged mid-session
    up_step(&u);
    CHECK(strstr(fake_last_request(), "mount=7&track=4") != NULL,
          "HANDOFF 4g rule 2: keep the mount the session opened under");
}

static void offline_keeps_the_write_and_backs_off(void) {
    mounted();
    amiga_writes(40, 0x5a);
    fake_push_connect_failure();
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_DIRTY);
    CHECK_EQ_INT(up_sync(&u), UP_OFFLINE);
    CHECK(u.backoff_ms >= 1000, "backed off");
    CHECK(up_holds(&u), "D3/D7: offline, the disk is held");
    CHECK_EQ_INT(up_step(&u), UP_WAITING);            // not before retry_at
    CHECK_EQ_INT(fake_request_count(), 1);
    fake_set_clock(fake_clock_ms() + u.backoff_ms);
    push_json("HTTP/1.1 200 OK", "{\"staged\":40}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_PRESENT);
    CHECK_EQ_INT(up_sync(&u), UP_PENDING);            // online again, close still to come
}

// The Wi-Fi fallback moved the board (review M3): the wait ends, the write goes out at once.
static void a_network_change_ends_the_wait(void) {
    mounted();
    amiga_writes(40, 0x5a);
    fake_push_connect_failure();
    up_step(&u);
    CHECK_EQ_INT(up_step(&u), UP_WAITING);
    up_network_changed(&u);
    CHECK_EQ_INT(u.backoff_ms, 0);
    push_json("HTTP/1.1 200 OK", "{\"staged\":40}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_PRESENT);
}

static void a_5xx_is_retried(void) {
    mounted();
    amiga_writes(40, 0x5a);
    push_json("HTTP/1.1 503 Service Unavailable", "{\"error\":\"x\"}");
    up_step(&u);
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_DIRTY);
    CHECK_EQ_INT(up_sync(&u), UP_PENDING);            // the server answered: online
    CHECK(u.backoff_ms >= 1000, "backed off");
}

static void a_torn_read_is_never_sent(void) {
    mounted();
    amiga_writes(40, 0x5a);
    // Simulate core0 mid-rewrite: the stored MFM for track 40 is damaged.
    static uint8_t mfm[MFM_TRACK_BYTES]; uint32_t bits;
    psram_image_read(0, 40, mfm, &bits);
    mfm[2000] ^= 0xff;
    psram_image_mark_dirty(0, 40, mfm, bits);
    CHECK_EQ_INT(up_step(&u), UP_WAITING);
    CHECK_EQ_INT(fake_request_count(), 0);
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_DIRTY);
}

static void not_mounted_parks_until_the_mount_changes(void) {
    mounted();
    amiga_writes(3, 1); amiga_writes(4, 2);
    push_json("HTTP/1.1 200 OK", "{\"staged\":3}");
    push_json("HTTP/1.1 409 Conflict", "{\"error\":\"not_mounted\",\"reason\":\"behind\"}");
    up_step(&u); up_step(&u);
    CHECK(u.parked, "parked");
    CHECK_EQ_INT(psram_image_state(0, 3), TRK_DIRTY);   // re-sent in a fresh session
    CHECK_EQ_INT(psram_image_state(0, 4), TRK_DIRTY);
    CHECK(!up_has_work(&u), "parked: the poll must run, or nothing ever reconciles");
    CHECK(!up_holds(&u), "and it may deliver a new disk");
    c.mounted_version = 8;                              // the poll's no-op reconciliation
    CHECK(up_has_work(&u), "unparked by the new mount");
    push_json("HTTP/1.1 200 OK", "{\"staged\":3}");
    up_step(&u);
    CHECK(strstr(fake_last_request(), "mount=8&track=3&session=boot-abc&seq=1") != NULL,
          "a fresh session at the new mount");
}

static void write_protected_discards_and_refetches(void) {
    mounted();
    amiga_writes(40, 0x5a);
    push_json("HTTP/1.1 409 Conflict", "{\"error\":\"write_protected\"}");
    up_step(&u);
    CHECK_EQ_INT(psram_image_dirty_count(0), 0);
    CHECK(up_forces_wprot(&u), "WPROT asserted now, not at the next poll");
    CHECK_EQ_INT(c.since, 0);                           // the server's image is fetched
    CHECK_EQ_INT(up_sync(&u), UP_SYNCED);
    c.mounted_version = 8;
    CHECK(!up_forces_wprot(&u), "the next mount decides again");
}

// Review round 1, Important: retry_at_ms is only meaningful while a wait is
// actually in progress. Back off once, let that wait elapse with a success,
// then jump the clock past retry_at_ms + 2^31 ms (~24.8 days) before the
// next write -- a comparison that still trusted the stale retry_at_ms would
// see `(int32_t)(now - retry_at_ms)` flip negative and report UP_WAITING
// forever (until the 32-bit clock wraps back), even though nothing is
// backing off any more.
static void a_stale_retry_at_does_not_stall_a_later_write(void) {
    mounted();
    amiga_writes(40, 0x5a);
    fake_push_connect_failure();
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);        // fails, backs off
    uint32_t retry_at = u.retry_at_ms;
    fake_set_clock(retry_at);
    push_json("HTTP/1.1 200 OK", "{\"staged\":40}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);        // the wait is over, and it succeeds
    amiga_writes(41, 0x5b);
    fake_set_clock(retry_at + 0x80000000u + 1000u);   // > retry_at + 2^31 ms
    push_json("HTTP/1.1 200 OK", "{\"staged\":41}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK(strstr(fake_last_request(), "track=41") != NULL,
          "sent immediately, not stalled by a stale retry_at_ms");
}

static void board_digest(char hex[65]) {
    sha256_t s; uint8_t d[32];
    sha256_init(&s); sha256_update(&s, adf, sizeof adf); sha256_final(&s, d);
    sha256_hex(d, hex);
}

static void upload_one(int t, uint8_t fill) {
    amiga_writes(t, fill);
    push_json("HTTP/1.1 200 OK", "{\"staged\":1}");
    up_step(&u);
}

static void closes_three_seconds_after_the_last_write(void) {
    mounted();
    upload_one(40, 0x5a);
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS - 1);
    CHECK_EQ_INT(up_step(&u), UP_WAITING);
    CHECK_EQ_INT(fake_request_count(), 1);
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
    char want[65]; board_digest(want);
    char body[128]; snprintf(body, sizeof body, "{\"sha256\":\"%s\"}", want);
    push_json("HTTP/1.1 200 OK", body);
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    char line[256];
    snprintf(line, sizeof line,
        "POST /api/device/write/close?disk=d1&mount=7&session=boot-abc&seq=1&sha256=%s HTTP/1.1", want);
    CHECK(strstr(fake_last_request(), line) != NULL,
          "the close names the digest of the whole image the board holds");
    CHECK(strcmp(c.mounted_sha256, want) == 0, "spec 3.1: adopted, no re-fetch");
    CHECK(!u.open, "closed");
    CHECK(!up_has_work(&u), "nothing left");
    CHECK_EQ_INT(up_sync(&u), UP_SYNCED);
}

static void a_write_during_the_hash_postpones_the_close(void) {
    mounted();
    upload_one(40, 0x5a);
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
    gen_moves = true;
    CHECK_EQ_INT(up_step(&u), UP_WAITING);
    CHECK_EQ_INT(fake_request_count(), 1);              // no close sent
}

static void mismatch_lets_the_server_image_win(void) {
    mounted();
    upload_one(40, 0x5a);
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
    push_json("HTTP/1.1 409 Conflict", "{\"error\":\"mismatch\",\"sha256\":\"cc\"}");
    up_step(&u);
    CHECK(!u.open, "never re-close after a mismatch (HANDOFF 4g)");
    CHECK_EQ_INT(c.since, 0);                           // re-download what the server holds
    CHECK(strcmp(c.mounted_sha256, "aa") == 0, "nothing adopted");
}

static void conflict_keeps_the_session_and_retries(void) {
    mounted();
    upload_one(40, 0x5a);
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
    push_json("HTTP/1.1 409 Conflict", "{\"error\":\"conflict\"}");
    up_step(&u);
    CHECK(u.open, "kept");
    CHECK(u.backoff_ms >= 1000, "backed off");
    CHECK_EQ_INT(up_step(&u), UP_WAITING);
    fake_set_clock(fake_clock_ms() + u.backoff_ms);
    char want[65]; board_digest(want);
    char body[128]; snprintf(body, sizeof body, "{\"sha256\":\"%s\"}", want);
    push_json("HTTP/1.1 200 OK", body);
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK(strstr(fake_last_request(), "/api/device/write/close?") != NULL, "the same close again");
    CHECK(!u.open, "closed on the retry");
}

static void incomplete_resends_the_sessions_tracks(void) {
    mounted();
    upload_one(40, 0x5a);
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
    push_json("HTTP/1.1 409 Conflict", "{\"error\":\"incomplete\"}");
    up_step(&u);
    CHECK(u.open, "kept");
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_DIRTY);
    push_json("HTTP/1.1 200 OK", "{\"staged\":40}");
    up_step(&u);
    CHECK(strstr(fake_last_request(), "track=40&session=boot-abc&seq=2") != NULL,
          "re-sent above the seq the server may already hold");
}

static void unchanged_is_adopted_too(void) {
    mounted();
    upload_one(40, 0x5a);
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
    // A real 64-hex digest: I6 refuses to adopt anything else (this test
    // used "dd", which was only ever adopted because nothing checked).
    const char *dd = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    char body[160]; snprintf(body, sizeof body, "{\"sha256\":\"%s\",\"unchanged\":true}", dd);
    push_json("HTTP/1.1 200 OK", body);
    up_step(&u);
    CHECK(strcmp(c.mounted_sha256, dd) == 0, "adopted");
    CHECK(!u.open, "closed");
}

// Review (final), Critical C2: a seq is never reused. Before, u->seq only
// advanced on a 200, so a transport failure's seq was handed to the NEXT
// request -- possibly a different track. If the failed request had in fact
// reached the server (the answer was lost), the server holds that seq, and
// the next track under it is a "duplicate" the server drops: a 200 that
// staged nothing, and a close whose image is missing that write.
static void a_seq_is_never_reused_after_a_failed_attempt(void) {
    mounted();
    upload_one(5, 0x11);                                  // seq 1, ok
    CHECK(strstr(fake_last_request(), "track=5&session=boot-abc&seq=1 ") != NULL, "seq 1");
    amiga_writes(80, 0x22);
    fake_push_connect_failure();
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);            // seq 2: lost, maybe after the server saw it
    amiga_writes(40, 0x33);                               // the Amiga dirties a lower track meanwhile
    fake_set_clock(fake_clock_ms() + u.backoff_ms);
    push_json("HTTP/1.1 200 OK", "{\"staged\":40}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK(strstr(fake_last_request(), "track=40&session=boot-abc&seq=3 ") != NULL,
          "the next request never reuses seq 2 -- the server may already hold it");
    push_json("HTTP/1.1 200 OK", "{\"staged\":80}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK(strstr(fake_last_request(), "track=80&session=boot-abc&seq=4 ") != NULL, "then seq 4");
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
    char want[65]; board_digest(want);
    char body[128]; snprintf(body, sizeof body, "{\"sha256\":\"%s\"}", want);
    push_json("HTTP/1.1 200 OK", body);
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK(strstr(fake_last_request(), "&seq=4&sha256=") != NULL, "the close names the last seq attempted");
}

// A refused attempt (5xx) spends its seq too -- the server may have staged
// it before failing -- so the retry goes out one above.
static void a_refused_attempt_also_spends_its_seq(void) {
    mounted();
    upload_one(5, 0x11);                                  // seq 1 ok
    amiga_writes(6, 0x12);
    push_json("HTTP/1.1 503 Service Unavailable", "{}"); // seq 2: server says no
    up_step(&u);
    fake_set_clock(fake_clock_ms() + u.backoff_ms);
    push_json("HTTP/1.1 200 OK", "{\"staged\":6}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK(strstr(fake_last_request(), "track=6&session=boot-abc&seq=3 ") != NULL, "seq 3");
    CHECK_EQ_INT(u.seq, 3);
}

// This uploader still never reuses a seq, but dc_exchange's keep-alive retry
// resends a request byte for byte -- seq included -- when a kept connection
// produced nothing. A server that had received attempt 1 and was slow to
// answer answers the retry {duplicate:true}, and that is the idempotency key
// doing its job: the track is staged once. So it is logged at INFO (a normal
// outcome on a flaky link), not WARN, and the line says what it means.
static void a_duplicate_answer_is_logged_as_already_staged(void) {
    mounted();
    amiga_writes(40, 0x5a);
    push_json("HTTP/1.1 200 OK", "{\"duplicate\":true}");
    up_step(&u);
    // WF_INFO carries no level tag (wf_log.c's lvl_tag), so the absence of
    // "WARN " in front of the line is what says it was demoted.
    CHECK(strstr(logs(), "upload: trk 40 seq 1 duplicate -- already staged") != NULL,
          "a duplicate says the track was already staged");
    CHECK(strstr(logs(), "WARN upload: trk 40 seq 1 duplicate") == NULL,
          "and is no longer a warning about something that now happens by design");
    // The track is still marked sent: a duplicate means staged, not lost.
    CHECK_EQ_INT(u.seq, 1);
}

// The session's close is due: one track uploaded, the Amiga quiet since.
static void close_due(void) {
    mounted();
    upload_one(40, 0x5a);
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
}

// ---- I3: 400 and 422 are permanent -- park, never retry forever ----------

static void a_400_upload_parks(void) {
    mounted();
    amiga_writes(40, 0x5a);
    push_json("HTTP/1.1 400 Bad Request", "{\"error\":\"invalid_body\"}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK(u.parked, "parked, not retried");
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_DIRTY);    // the write is kept
    CHECK(!up_holds(&u), "the hold is released");
    CHECK(up_forces_wprot(&u), "and the Amiga stops writing (I4)");
    CHECK(strstr(logs(), "ERROR upload: trk 40 status 400") != NULL, "logged as an error");
    CHECK(strstr(logbuf, "invalid_body") != NULL, "with the response body");
    CHECK_EQ_INT(up_step(&u), UP_NOTHING);
    CHECK_EQ_INT(fake_request_count(), 1);
}

static void a_422_upload_parks(void) {
    mounted();
    amiga_writes(40, 0x5a);
    push_json("HTTP/1.1 422 Unprocessable Entity", "{\"error\":\"bad_track\"}");
    up_step(&u);
    CHECK(u.parked, "parked");
    CHECK(strstr(logs(), "ERROR upload: trk 40 status 422") != NULL, "error");
    CHECK(strstr(logbuf, "bad_track") != NULL, "body");
}

static void a_400_close_parks(void) {
    close_due();
    push_json("HTTP/1.1 400 Bad Request", "{\"error\":\"invalid_query\"}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK(u.parked, "parked");
    CHECK(!u.open, "the session is abandoned");
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_DIRTY);    // re-sent under a fresh session
    CHECK(strstr(logs(), "ERROR close: status 400") != NULL, "error");
    CHECK(strstr(logbuf, "invalid_query") != NULL, "body");
}

static void a_422_close_parks(void) {
    close_due();
    push_json("HTTP/1.1 422 Unprocessable Entity", "{\"error\":\"x\"}");
    up_step(&u);
    CHECK(u.parked, "parked");
    CHECK(strstr(logs(), "ERROR close: status 422") != NULL, "error");
}

// ---- I4: parked means write-protected, until the mount changes ------------

static void parked_forces_wprot_until_the_mount_changes(void) {
    mounted();
    amiga_writes(3, 1);
    push_json("HTTP/1.1 409 Conflict", "{\"error\":\"not_mounted\",\"reason\":\"behind\"}");
    up_step(&u);
    CHECK(u.parked, "parked");
    CHECK(up_forces_wprot(&u), "a write now would land nowhere: WPROT");
    c.mounted_version = 8;                                // same disk, bumped
    CHECK(!up_forces_wprot(&u), "the new mount decides again");
    CHECK(!u.parked, "unparked");
    CHECK(strstr(logs(), "discarded") == NULL, "same disk: nothing discarded, it is re-sent");
    CHECK_EQ_INT(psram_image_state(0, 3), TRK_DIRTY);
}

static void a_parked_disk_replaced_says_what_was_lost(void) {
    mounted();
    amiga_writes(3, 1); amiga_writes(4, 2);
    push_json("HTTP/1.1 409 Conflict", "{\"error\":\"not_mounted\"}");
    up_step(&u);
    CHECK(u.parked, "parked");
    // The poll (no longer held) delivers another disk into the other slot.
    psram_publish_slot(1);
    strcpy(c.mounted_sha256, "bb"); c.mounted_version = 8;
    CHECK(!up_forces_wprot(&u), "a new disk decides again");
    CHECK(strstr(logs(), "WARN upload: parked disk aa replaced -- 2 dirty track(s) discarded") != NULL,
          "the loss is logged with its size");
}

// ---- I5: a request that does not fit is never sent truncated --------------

static void an_overlong_close_is_not_sent_truncated(void) {
    mounted();
    // Disk id and session both at their maximum (64) and a 10-digit mount:
    // the upload's path fits in 256 (201 bytes), the close's -- which also
    // carries a 64-char digest -- does not (261).
    const char *id64 = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd0064";
    const char *ss64 = "ssssssssssssssssssssssssssssssssssssssssssssssssssssssssssss0064";
    strcpy(c.mounted_disk_id, id64);
    c.mounted_version = 4000000000u; c.since = 4000000000u;
    up_init(&u, &c, ss64, write_gen, last_write);
    upload_one(40, 0x5a);
    CHECK(strstr(fake_last_request(), id64) != NULL, "the upload fit");
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
    // Scripted so a truncated close, if sent, fails this CHECK below rather
    // than aborting the fake transport.
    push_json("HTTP/1.1 400 Bad Request", "{\"error\":\"invalid_query\"}");
    up_step(&u);
    CHECK_EQ_INT(fake_request_count(), 1);                // no truncated close
    CHECK(u.parked, "parked");
    CHECK(strstr(logs(), "ERROR close: request too long") != NULL, "error");
}

// ---- I6: a 200 close without a digest is not adopted ---------------------

static void a_close_without_a_digest_is_not_adopted(void) {
    close_due();
    push_json("HTTP/1.1 200 OK", "{\"ok\":true}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK(strcmp(c.mounted_sha256, "aa") == 0, "nothing adopted");
    CHECK(u.open, "the session is kept");
    CHECK(u.waiting && u.backoff_ms >= 1000, "backed off, the close retried later");
}

static void a_close_with_a_short_digest_is_not_adopted(void) {
    close_due();
    push_json("HTTP/1.1 200 OK", "{\"sha256\":\"abc\"}");
    up_step(&u);
    CHECK(strcmp(c.mounted_sha256, "aa") == 0, "nothing adopted");
    CHECK(u.open, "kept");
}

static void a_close_with_an_overlong_digest_is_not_adopted(void) {
    close_due();
    // 65 hex chars: must not be silently cut to 64 and adopted.
    push_json("HTTP/1.1 200 OK",
        "{\"sha256\":\"00000000000000000000000000000000000000000000000000000000000000000\"}");
    up_step(&u);
    CHECK(strcmp(c.mounted_sha256, "aa") == 0, "nothing adopted");
    CHECK(u.open, "kept");
}

// ---- M1: any HTTP answer means online ------------------------------------

static void any_answer_means_online(void) {
    mounted();
    amiga_writes(3, 1);
    fake_push_connect_failure();
    up_step(&u);
    CHECK_EQ_INT(up_sync(&u), UP_OFFLINE);
    fake_set_clock(fake_clock_ms() + u.backoff_ms);
    push_json("HTTP/1.1 409 Conflict", "{\"error\":\"not_mounted\"}");
    up_step(&u);
    CHECK(u.parked, "parked");
    CHECK(up_sync(&u) != UP_OFFLINE, "the server answered: not offline");
}

// ---- T: the remaining branches ------------------------------------------

static void a_404_upload_parks(void) {
    mounted();
    amiga_writes(40, 0x5a);
    push_json("HTTP/1.1 404 Not Found", "{\"error\":\"not_found\"}");
    up_step(&u);
    CHECK(u.parked, "parked");
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_DIRTY);
}

static void a_401_upload_keeps_the_write(void) {
    mounted();
    amiga_writes(40, 0x5a);
    push_json("HTTP/1.1 401 Unauthorized", "{\"error\":\"unauthorized\"}");
    up_step(&u);
    CHECK_EQ_INT(c.state, DC_HALTED);                     // dc_post halted the client
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_DIRTY);    // kept for re-provisioning
    CHECK(!u.parked, "not parked");
    CHECK(!up_has_work(&u), "halted: nothing more to send");
    CHECK_EQ_INT(up_sync(&u), UP_PENDING);                // it answered: online
}

static void not_mounted_at_close_parks(void) {
    close_due();
    push_json("HTTP/1.1 409 Conflict", "{\"error\":\"not_mounted\"}");
    up_step(&u);
    CHECK(u.parked, "parked");
    CHECK(!u.open, "abandoned");
    CHECK_EQ_INT(psram_image_state(0, 40), TRK_DIRTY);    // re-sent under a fresh session
    CHECK(up_forces_wprot(&u), "WPROT while parked");
}

static void a_torn_track_during_the_hash_backs_off(void) {
    close_due();
    // core0 mid-rewrite of a CLEAN track: damaged bytes, state still PRESENT.
    static uint8_t mfm[MFM_TRACK_BYTES]; uint32_t bits;
    psram_image_read(0, 100, mfm, &bits);
    mfm[3000] ^= 0xff;
    psram_image_write_at(0, 100, 0, mfm, (int)((bits + 7) / 8));
    psram_image_commit(0, 100, bits);
    CHECK_EQ_INT(up_step(&u), UP_WAITING);
    CHECK_EQ_INT(fake_request_count(), 1);                // no close sent
    CHECK(u.waiting && u.backoff_ms >= 1000, "backed off");
    CHECK(u.open, "the session is kept");
}

// ---- Final review F1: a store still in progress is never closed over ------
//
// core0's store is memcpy, barrier, DIRTY, then the generation. Before 1.5.0's
// final review the generation moved only at the end, so a store that began
// before the close read it and was still copying when the close re-checked it
// left both reads equal and no track dirty: the close hashed a half-written
// track and sent it, the server answered 409 mismatch, and up_server_wins
// threw the new track away. The generation is now odd for the whole store.

// A DD track torn at a sector boundary: the first sectors already copied are
// the new write, the rest the old -- and every sector decodes, so the torn-
// read check (up_read_whole_track) cannot see it. Returns the byte count the
// copy has reached.
static size_t dd_split_that_decodes(const uint8_t *old_mfm, const uint8_t *new_mfm,
                                    size_t nbytes, int t) {
    static uint8_t mixed[MFM_TRACK_BYTES], out[TB];
    for (size_t n = nbytes / 2; n < nbytes; n++) {
        memcpy(mixed, new_mfm, n);
        memcpy(mixed + n, old_mfm + n, nbytes - n);
        mfm_decode_result_t d;
        memset(&d, 0, sizeof d);
        mfm_decode_track(mixed, nbytes, out, &d);
        if (d.found == 0x7ffu && d.track_no_consistent && d.track_no == (uint8_t)t &&
            memcmp(out, adf + t * TB, TB) != 0) return n;
    }
    return 0;
}

static void a_dd_store_in_progress_is_never_closed_over(void) {
    close_due();
    const int t = 100;
    static uint8_t old_mfm[MFM_TRACK_BYTES], new_mfm[MFM_TRACK_BYTES], nt[TB];
    uint32_t bits = 0;
    psram_image_read(0, t, old_mfm, &bits);
    memset(nt, 0xc3, TB);
    CHECK_EQ_INT(mfm_encode_track(nt, (uint8_t)t, new_mfm), bits);
    const size_t nbytes = (bits + 7) / 8;
    const size_t n = dd_split_that_decodes(old_mfm, new_mfm, nbytes, t);
    CHECK(n > 0, "a torn copy that decodes cleanly exists (sector boundaries)");

    // core0 began the store before the close read the generation, and has
    // copied n bytes: odd generation, track still PRESENT.
    gen++;
    psram_image_write_at(0, t, 0, new_mfm, (int)n);
    CHECK_EQ_INT(psram_image_state(0, t), TRK_PRESENT);
    CHECK_EQ_INT(up_step(&u), UP_WAITING);
    CHECK_EQ_INT(fake_request_count(), 1);              // no close sent
    CHECK(u.open, "the session is kept");

    // The store finishes: DIRTY, then the generation settles.
    memcpy(adf + t * TB, nt, TB);
    store_track(t, nt, true);
    last_ms = fake_clock_ms(); gen++;
    push_json("HTTP/1.1 200 OK", "{\"staged\":100}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    CHECK(strstr(fake_last_request(), "track=100&session=boot-abc&seq=2") != NULL,
          "the finished track goes up in the same session");
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
    char want[65]; board_digest(want);
    char body[128]; snprintf(body, sizeof body, "{\"sha256\":\"%s\"}", want);
    push_json("HTTP/1.1 200 OK", body);
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    char line[256];
    snprintf(line, sizeof line, "close?disk=d1&mount=7&session=boot-abc&seq=2&sha256=%s", want);
    CHECK(strstr(fake_last_request(), line) != NULL, "then the close, over the whole new track");
    CHECK(!u.open, "closed");
}

static void hd_close_due(void) {
    mounted_hd();
    amiga_writes_hd(40, 0x77);
    push_json("HTTP/1.1 200 OK", "{\"staged\":40}");
    up_step(&u);
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
}

// core0 has begun storing HD track 90 and copied half of its 11,264 bytes.
// The close hashes an HD track in place, straight from PSRAM, with no
// checksum at all: only the generation can say the bytes are mid-copy.
static uint8_t hd_new[HB];
static void hd_store_begins(void) {
    gen++;
    memset(hd_new, 0xe1, HB);
    psram_image_write_at(0, 90, 0, hd_new, HB / 2);
}
static void hd_store_finishes(void) {
    memcpy(hd_adf + 90 * HB, hd_new, HB);
    CHECK(psram_image_store_adf(0, 90, hd_new), "stored");
    last_ms = fake_clock_ms(); gen++;
}

static void hd_close_then_over_the_whole_track(void) {
    push_json("HTTP/1.1 200 OK", "{\"staged\":90}");
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    int n = fake_last_request_len();
    CHECK(memcmp(fake_last_request() + n - HB, hd_adf + 90 * HB, HB) == 0,
          "the finished track goes up whole");
    fake_set_clock(last_ms + UP_IDLE_CLOSE_MS);
    char want[65]; hd_digest(want);
    char body[128]; snprintf(body, sizeof body, "{\"sha256\":\"%s\"}", want);
    push_json("HTTP/1.1 200 OK", body);
    CHECK_EQ_INT(up_step(&u), UP_DID_REQUEST);
    char line[256];
    snprintf(line, sizeof line, "close?disk=d1&mount=7&session=boot-abc&seq=2&sha256=%s", want);
    CHECK(strstr(fake_last_request(), line) != NULL, "then the close, over the whole new track");
    CHECK(!u.open, "closed");
}

// Began before the close read the generation; still copying at the re-check.
static void an_hd_store_begun_before_the_close_is_never_closed_over(void) {
    hd_close_due();
    hd_store_begins();
    CHECK_EQ_INT(up_step(&u), UP_WAITING);
    CHECK_EQ_INT(fake_request_count(), 1);              // no close sent
    CHECK(u.open, "the session is kept");
    hd_store_finishes();
    hd_close_then_over_the_whole_track();
}

// Began just after the close read the generation (even), before the hash
// reached track 90; still copying at the re-check.
static void an_hd_store_begun_during_the_close_is_never_closed_over(void) {
    hd_close_due();
    after_gen_read = hd_store_begins;
    CHECK_EQ_INT(up_step(&u), UP_WAITING);
    CHECK(after_gen_read == NULL, "the store began inside the close");
    CHECK_EQ_INT(fake_request_count(), 1);              // no close sent
    CHECK(u.open, "the session is kept");
    hd_store_finishes();
    hd_close_then_over_the_whole_track();
}

int main(void) {
    size_t len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS * SLOT_COUNT;
    void *mem = malloc(len);
    psram_image_set_backing(mem, len);
    RUN(nothing_to_do_without_writes);
    RUN(a_dirty_track_is_uploaded_whole);
    RUN(tracks_go_in_order_with_rising_seq);
    RUN(the_mount_is_fixed_for_the_session);
    RUN(offline_keeps_the_write_and_backs_off);
    RUN(a_network_change_ends_the_wait);
    RUN(a_5xx_is_retried);
    RUN(a_torn_read_is_never_sent);
    RUN(not_mounted_parks_until_the_mount_changes);
    RUN(write_protected_discards_and_refetches);
    RUN(a_stale_retry_at_does_not_stall_a_later_write);
    RUN(closes_three_seconds_after_the_last_write);
    RUN(a_write_during_the_hash_postpones_the_close);
    RUN(mismatch_lets_the_server_image_win);
    RUN(conflict_keeps_the_session_and_retries);
    RUN(incomplete_resends_the_sessions_tracks);
    RUN(unchanged_is_adopted_too);
    RUN(a_seq_is_never_reused_after_a_failed_attempt);
    RUN(a_refused_attempt_also_spends_its_seq);
    RUN(a_duplicate_answer_is_logged_as_already_staged);
    RUN(a_400_upload_parks);
    RUN(a_422_upload_parks);
    RUN(a_400_close_parks);
    RUN(a_422_close_parks);
    RUN(parked_forces_wprot_until_the_mount_changes);
    RUN(a_parked_disk_replaced_says_what_was_lost);
    RUN(an_overlong_close_is_not_sent_truncated);
    RUN(a_close_without_a_digest_is_not_adopted);
    RUN(a_close_with_a_short_digest_is_not_adopted);
    RUN(a_close_with_an_overlong_digest_is_not_adopted);
    RUN(any_answer_means_online);
    RUN(a_404_upload_parks);
    RUN(a_401_upload_keeps_the_write);
    RUN(not_mounted_at_close_parks);
    RUN(a_torn_track_during_the_hash_backs_off);
    RUN(an_hd_track_is_uploaded_as_its_stored_bytes);
    RUN(an_hd_close_hashes_160_tracks_of_11264_bytes);
    RUN(an_offline_hd_write_is_kept_and_sent_later);
    RUN(a_dd_store_in_progress_is_never_closed_over);
    RUN(an_hd_store_begun_before_the_close_is_never_closed_over);
    RUN(an_hd_store_begun_during_the_close_is_never_closed_over);
    free(mem);
    return REPORT();
}
