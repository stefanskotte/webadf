#include "harness.h"
#include "transport_fake.h"
#include "../src/uploader.h"
#include "../src/device_client.h"
#include "../src/psram_image.h"
#include "../src/mfm.h"
#include "../src/sha256.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#define TB MFM_TRACK_DATA_BYTES                  // 5632
static uint8_t adf[NUM_TRACKS * TB];             // what the board holds, decoded
static device_client_t c;
static uploader_t u;
static uint32_t gen, last_ms;
static bool gen_moves;                           // Task 6: a write lands mid-hash
static uint32_t write_gen(void) { return gen_moves ? gen++ : gen; }
static uint32_t last_write(void) { return last_ms; }

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
    psram_image_reset_slot(0); psram_image_reset_slot(1);
    for (int t = 0; t < NUM_TRACKS; t++) {
        for (int i = 0; i < TB; i++) adf[t * TB + i] = (uint8_t)(t * 7 + i);
        store_track(t, adf + t * TB, false);
    }
    psram_publish_slot(0);
    dc_init(&c, fake_transport(), fake_clock_ms, "h", "tok");
    strcpy(c.mounted_sha256, "aa"); strcpy(c.mounted_disk_id, "d1");
    c.mounted_version = 7; c.since = 7;
    gen = 0; last_ms = 10000; gen_moves = false;
    up_init(&u, &c, "boot-abc", write_gen, last_write);
}

static void amiga_writes(int t, uint8_t fill) {
    memset(adf + t * TB, fill, TB);
    store_track(t, adf + t * TB, true);
    gen++; last_ms = fake_clock_ms();
}

static void push_json(const char *status, const char *body) {
    static char r[512];
    snprintf(r, sizeof r, "%s\r\nContent-Length: %zu\r\n\r\n%s", status, strlen(body), body);
    fake_push_response(r);
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
    push_json("HTTP/1.1 200 OK", "{\"sha256\":\"dd\",\"unchanged\":true}");
    up_step(&u);
    CHECK(strcmp(c.mounted_sha256, "dd") == 0, "adopted");
    CHECK(!u.open, "closed");
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
    free(mem);
    return REPORT();
}
