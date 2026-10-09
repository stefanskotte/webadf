#include "harness.h"
#include "transport_fake.h"
#include "../src/device_client.h"
#include "../src/psram_image.h"
#include "../src/image_loader.h"
#include "../src/token_store.h"
#include "../src/display_layout.h"
#include "../src/wf_log.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Builds "<status_line>\r\nContent-Length: <N>\r\n\r\n<body>" with N computed
// from strlen(body) rather than hand-counted -- task 6 lost a round to six
// wrong hand-counted lengths. Review round 1, Nit: the same class of bug
// can come back through a silently-discarded snprintf result just as
// easily as a hand-typed number, so a body that would overflow `resp` (or
// any other snprintf failure) aborts the test binary loudly instead of
// quietly building a truncated fixture.
static void push_status_json(const char *status_line, const char *body) {
    char resp[512];
    int n = snprintf(resp, sizeof resp, "%s\r\nContent-Length: %zu\r\n\r\n%s",
                      status_line, strlen(body), body);
    if (n < 0 || (size_t)n >= sizeof resp) {
        fprintf(stderr, "push_status_json: body too large for the fixture buffer "
                        "(needed %d bytes, have %zu)\n", n, sizeof resp);
        abort();
    }
    fake_push_response(resp);
}

static void push_ok_json(const char *body) {
    push_status_json("HTTP/1.1 200 OK", body);
}

static char buf[128];
static device_client_t c;
static void boot(void) {
    fake_reset(); fake_set_clock(0);
    dc_init(&c, fake_transport(), fake_clock_ms, "webadf.vercel.app", "tok");
    // psram_publish_slot() writes a process-wide static (psram_image.c),
    // so a test earlier in this binary that mounts a disk (directly, or by
    // driving dc_step through a real successful fetch) would otherwise
    // leak "mounted" into every test that runs after it -- in particular,
    // token_store_save()'s mounted-disk guard would then refuse for
    // reasons that have nothing to do with the test running. Tests that
    // want a mounted precondition call psram_publish_slot() themselves,
    // after boot().
    psram_publish_slot(SLOT_NONE);
    // DF1 (Task 15): that publish ejects a DF1 an earlier test left inserted,
    // under a fresh token core0 has not acknowledged -- and an unacknowledged
    // DF1 word defers every slot write. There is no core0 here: stand in for
    // it and say it let go, so each test starts quiescent.
    psram_df1_reader_ack(psram_df1_token());
}

static void test_cold_boot_polls_since_zero(void) {
    boot();
    c.mounted_version = 0;
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "since=0") != NULL,
          "cold boot MUST poll since=0 or the device boots diskless forever");
}

// Task 5's binding ruling: transport_t.write() may accept fewer bytes than
// offered, exactly as a real socket can under backpressure. A client that
// assumes one write() call sends a whole request would pass every other
// test in this file and fail only on hardware. fake_set_max_write(1) forces
// the request out one byte at a time; dc_step must still loop until it is
// all sent.
static void test_request_survives_single_byte_writes(void) {
    boot();
    fake_set_max_write(1);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "GET /api/device/poll?since=0") != NULL,
          "a request built from single-byte writes must still arrive whole");
    CHECK(strstr(fake_last_request(), "Authorization: Bearer tok") != NULL,
          "including the part written last, not just the part written first");
}

static void test_since_does_not_advance_on_a_failed_fetch(void) {
    boot();
    // Poll names version 7...
    fake_push_response("HTTP/1.1 200 OK\r\nContent-Length: 125\r\n\r\n"
        "{\"version\":7,\"desired\":{\"sha256\":\"aa\",\"diskId\":\"d1\",\"gameId\":\"g\","
        "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
    // ...but the image fetch dies partway through.
    fake_push_truncated("HTTP/1.1 200 OK\r\nContent-Length: 2027536\r\n\r\nWFMF", 40);
    dc_step(&c);
    CHECK_EQ_INT(c.since, 0);
    CHECK_EQ_INT(c.mounted_version, 0);
    CHECK(c.mounted_sha256[0] == 0, "nothing may be reported as mounted");
}

// Task 8's rule, exercised directly: a fetch that dies mid-body must leave
// the active PSRAM slot -- and therefore what the Amiga is holding --
// completely untouched. Not "eject then fail to refill": untouched.
static void test_current_disk_survives_a_failed_replacement_fetch(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "old");
    push_ok_json(
        "{\"version\":8,\"desired\":{\"sha256\":\"new\",\"diskId\":\"d2\",\"gameId\":\"g\","
        "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
    fake_push_truncated("HTTP/1.1 200 OK\r\nContent-Length: 2027536\r\n\r\nWFMF", 40);
    dc_step(&c);
    CHECK_EQ_INT(psram_active_slot(), 0);
    CHECK(strcmp(c.mounted_sha256, "old") == 0,
          "a failed fetch must leave the Amiga holding the disk it had");
}

// Review Focus 1: a disk and an update in one body. Both carry version/sha256.
static void test_update_object_does_not_leak_into_disk_fields(void) {
    boot();
    push_ok_json("{\"version\":7,\"desired\":null,\"instructionVersion\":2,"
                 "\"update\":{\"version\":\"1.1.0+gx\",\"sequence\":5,\"sha256\":\""
                 "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\","
                 "\"sizeBytes\":1000,\"signature\":\"AA==\",\"keyId\":\"wf-x\"}}");
    dc_step(&c);
    CHECK_EQ_INT(c.since, 7);                  // the top-level version, not the update's
    CHECK(c.mounted_sha256[0] == '\0', "desired:null stays an eject; the update's sha256 is not a disk");
    CHECK(c.fw_instruction_new, "a moved instruction is flagged");
    CHECK_EQ_INT(c.fw_instruction_version, 2);
    CHECK(c.fw_offer_present, "the update came with it");
    CHECK(strstr(c.fw_update_json, "\"sequence\":5") != NULL, "and is kept whole for the parser");
}
static void test_unchanged_instruction_is_not_new(void) {
    boot();
    c.fw_instruction_version = 2;
    push_ok_json("{\"version\":1,\"desired\":null,\"instructionVersion\":2}");
    dc_step(&c);
    CHECK(!c.fw_instruction_new, "the same cursor again is not a new instruction");
}
static void test_a_cancel_is_new_with_no_offer(void) {
    boot();
    c.fw_instruction_version = 2;
    push_ok_json("{\"version\":1,\"desired\":null,\"instructionVersion\":3}");
    dc_step(&c);
    CHECK(c.fw_instruction_new && !c.fw_offer_present, "moved, no update: a cancellation");
}

// Fix round 1 (Task 11 review, Important): after dc_init the cursor is 0, and
// the server echoes its instructionVersion on every poll -- sending `update`
// only while un-acked. So the FIRST cursor seen after boot with no update is
// a cursor sync, not a cancel: acting on it as a cancel wiped a boot-time
// "failed: reverted" before it was ever reported (spec D8).
static void test_first_cursor_after_boot_without_update_is_a_sync(void) {
    boot();
    push_ok_json("{\"version\":1,\"desired\":null,\"instructionVersion\":5}");
    dc_step(&c);
    CHECK(c.fw_instruction_new, "the first cursor is still new (it must be acked)");
    CHECK(c.fw_instruction_is_sync, "but with no update it is a sync, not a cancel");
    CHECK(!c.fw_offer_present, "and carries no offer");
    CHECK_EQ_INT(c.fw_instruction_version, 5);
}
static void test_a_later_cursor_move_without_update_is_a_real_cancel(void) {
    boot();
    push_ok_json("{\"version\":1,\"desired\":null,\"instructionVersion\":5}");
    dc_step(&c);
    c.fw_instruction_new = false;              // main.c acted on the sync
    push_ok_json("{\"version\":2,\"desired\":null,\"instructionVersion\":6}");
    dc_step(&c);
    CHECK(c.fw_instruction_new, "a moved cursor is new");
    CHECK(!c.fw_instruction_is_sync, "a later move with no update is a real cancel");
    CHECK(!c.fw_offer_present, "no offer");
}
static void test_first_cursor_after_boot_with_update_is_a_real_instruction(void) {
    boot();
    push_ok_json("{\"version\":7,\"desired\":null,\"instructionVersion\":2,"
                 "\"update\":{\"version\":\"1.1.0+gx\",\"sequence\":5,\"sha256\":\""
                 "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\","
                 "\"sizeBytes\":1000,\"signature\":\"AA==\",\"keyId\":\"wf-x\"}}");
    dc_step(&c);
    CHECK(c.fw_instruction_new, "new");
    CHECK(!c.fw_instruction_is_sync, "an update on the first cursor is a real instruction");
    CHECK(c.fw_offer_present, "with its offer");
}

// Final review m2: an `update` key whose object cannot be lifted (too large
// for fw_update_json here) is a MALFORMED instruction -- not a cancel, and on
// the first cursor not a sync. The cursor still moved and must be acked; the
// flag lets main.c refuse it ("refused: malformed update instruction").
// Pushes a 200 poll whose `update` object is larger than fw_update_json
// (DC_FW_UPDATE_JSON_BYTES) but whose body still fits DC_POLL_BODY_BYTES --
// too big for push_ok_json's 512-byte fixture buffer, so built here.
static void push_big_update(uint32_t iv) {
    static char body[1024], resp[1200];
    char sig[DC_FW_UPDATE_JSON_BYTES + 32];
    memset(sig, 'A', sizeof sig - 1); sig[sizeof sig - 1] = '\0';
    snprintf(body, sizeof body,
             "{\"version\":1,\"desired\":null,\"instructionVersion\":%lu,"
             "\"update\":{\"version\":\"1.1.0+gx\",\"sequence\":5,\"signature\":\"%s\"}}",
             (unsigned long)iv, sig);
    CHECK(strlen(body) < DC_POLL_BODY_BYTES, "fixture: the body itself fits the poll buffer");
    snprintf(resp, sizeof resp, "HTTP/1.1 200 OK\r\nContent-Length: %zu\r\n\r\n%s", strlen(body), body);
    fake_push_response(resp);
}
static void test_oversized_update_on_first_cursor_is_malformed_not_sync(void) {
    boot();
    push_big_update(4);
    dc_step(&c);
    CHECK(c.fw_instruction_new, "the moved cursor is new (it must be acked)");
    CHECK_EQ_INT(c.fw_instruction_version, 4);
    CHECK(!c.fw_instruction_is_sync, "an update key is never a sync");
    CHECK(!c.fw_offer_present, "no offer could be lifted");
    CHECK(c.fw_offer_malformed, "flagged malformed");
}
static void test_oversized_update_on_a_later_cursor_is_malformed_not_cancel(void) {
    boot();
    c.fw_instruction_version = 2;
    push_big_update(3);
    dc_step(&c);
    CHECK(c.fw_instruction_new, "new");
    CHECK(!c.fw_offer_present, "no offer");
    CHECK(c.fw_offer_malformed, "malformed, so main.c refuses rather than cancels");
}
static void test_update_null_is_a_cancel_not_malformed(void) {
    boot();
    c.fw_instruction_version = 2;
    push_ok_json("{\"version\":1,\"desired\":null,\"instructionVersion\":3,\"update\":null}");
    dc_step(&c);
    CHECK(c.fw_instruction_new && !c.fw_offer_present, "a cancel");
    CHECK(!c.fw_offer_malformed, "null is not malformed");
}
static void test_a_good_update_clears_malformed(void) {
    boot();
    c.fw_instruction_version = 2;
    push_big_update(3);
    dc_step(&c);
    c.fw_instruction_new = false;
    push_ok_json("{\"version\":2,\"desired\":null,\"instructionVersion\":4,"
                 "\"update\":{\"version\":\"1.1.0+gx\",\"sequence\":5}}");
    dc_step(&c);
    CHECK(c.fw_offer_present, "offer");
    CHECK(!c.fw_offer_malformed, "the flag does not stick");
}

static void test_poll_404_keeps_the_disk_mounted(void) {
    boot();
    c.mounted_version = 5; strcpy(c.mounted_sha256, "deadbeef");
    fake_push_response("HTTP/1.1 404 Not Found\r\nContent-Length: 28\r\n\r\n"
                       "{\"error\":\"device_not_found\"}");
    dc_state_t s = dc_step(&c);
    CHECK_EQ_INT(s, DC_HALTED);
    CHECK(strcmp(c.mounted_sha256, "deadbeef") == 0,
          "a deleted device row is an absence of signal, never an eject");
}

// Review round 3, NEW Important: a bare 404 status is not proof the device
// row is gone -- only the server's own explicit
// {"error":"device_not_found"} body (src/app/api/device/poll/route.ts)
// means that. Before task 7's DC_HALTED fix, treating every poll 404 as
// device_not_found was harmless-ish (the token survived DC_HALTED, and
// boards resumed on their own once a transient infra fault -- a bad
// deploy, a renamed route, a proxy misroute -- cleared). Now that
// main.c's DC_HALTED handling erases the token, misreading an ordinary
// infrastructure 404 as "device deleted" would erase every deployed
// board's token from one bad deploy, turning a transient server-side
// mistake into a fleet-wide outage that needs a human to re-pair each
// board. Uses push_status_json (not fake_push_response) so Content-Length
// is computed, not typed.
static void test_poll_404_without_device_not_found_marker_is_retryable(void) {
    boot();
    c.mounted_version = 5; strcpy(c.mounted_sha256, "deadbeef");
    push_status_json("HTTP/1.1 404 Not Found", "{\"error\":\"route_not_found\"}");
    dc_state_t s = dc_step(&c);
    CHECK(s != DC_HALTED,
          "a 404 that doesn't name device_not_found must stay retryable, not halt");
    CHECK(strcmp(c.mounted_sha256, "deadbeef") == 0,
          "still never an eject, regardless of how the 404 is classified");
}

static void test_401_halts(void) {
    boot();
    fake_push_response("HTTP/1.1 401 Unauthorized\r\nContent-Length: 24\r\n\r\n"
                       "{\"error\":\"unauthorized\"}");
    CHECK_EQ_INT(dc_step(&c), DC_HALTED);
}

static void test_204_repolls_with_same_since(void) {
    boot();
    c.since = 4;
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK_EQ_INT(c.since, 4);
    CHECK(strstr(fake_last_request(), "since=4") != NULL, "same since re-polled");
}

// --- image endpoint status codes (spec §4.2, second table) ---------------
// A digest that can never succeed must not be retried forever, but must also
// not stop the device polling -- the desired state may change to something
// it CAN fetch. Retrying a 422 in a tight loop is the obvious wrong answer.

static void push_poll_desired_aa(void) {
    fake_push_response("HTTP/1.1 200 OK\r\nContent-Length: 125\r\n\r\n"
        "{\"version\":7,\"desired\":{\"sha256\":\"aa\",\"diskId\":\"d1\",\"gameId\":\"g\","
        "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
}

static void poll_then_image(const char *image_response) {
    push_poll_desired_aa();
    fake_push_response(image_response);
}

static void test_image_422_does_not_retry_the_digest_but_keeps_polling(void) {
    boot();
    poll_then_image("HTTP/1.1 422 Unprocessable Entity\r\nContent-Length: 23\r\n\r\n"
                    "{\"error\":\"unencodable\"}");
    dc_state_t s = dc_step(&c);
    CHECK(s != DC_HALTED, "a bad digest must not stop the poll loop");
    CHECK_EQ_INT(c.since, 0);
    CHECK(dc_digest_is_blocked(&c, "aa"), "this digest must not be retried");
}

static void test_image_404_behaves_the_same_as_422(void) {
    boot();
    poll_then_image("HTTP/1.1 404 Not Found\r\nContent-Length: 21\r\n\r\n"
                    "{\"error\":\"not_found\"}");
    CHECK(dc_step(&c) != DC_HALTED, "keep polling");
    CHECK(dc_digest_is_blocked(&c, "aa"), "do not retry this digest");
}

static void test_image_400_is_a_firmware_bug_and_never_retried(void) {
    boot();
    poll_then_image("HTTP/1.1 400 Bad Request\r\nContent-Length: 24\r\n\r\n"
                    "{\"error\":\"invalid_body\"}");
    dc_step(&c);
    CHECK(dc_digest_is_blocked(&c, "aa"), "a malformed digest will not become valid");
}

static void test_image_503_is_retried(void) {
    boot();
    poll_then_image("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 19\r\n\r\n"
                    "{\"error\":\"no_blob\"}");
    dc_step(&c);
    CHECK(!dc_digest_is_blocked(&c, "aa"),
          "503 is transient -- blocking the digest would strand a fetchable disk");
    CHECK(c.backoff_ms > 0, "503 should back off");
}

// --- Task 7: backoff, read timeout, status reporting ---------------------

static void test_read_timeout_exceeds_the_hold(void) {
    // The poll holds 25s. A timeout at or under that tears down every poll
    // mid-hold and looks exactly like a network fault.
    CHECK(DC_POLL_TIMEOUT_MS > 25000, "read timeout must exceed the 25s hold");
}

static void test_backoff_grows_and_is_capped(void) {
    boot();
    uint32_t prev = 0;
    for (int i = 0; i < 8; i++) {
        fake_push_connect_failure();
        dc_step(&c);
        CHECK(c.backoff_ms >= prev, "backoff must not shrink on repeated failure");
        CHECK(c.backoff_ms <= DC_BACKOFF_CAP_MS, "backoff must be capped");
        prev = c.backoff_ms;
    }
    CHECK(prev > 1000, "backoff should have grown beyond the 1s floor");
}

static void test_backoff_resets_after_success(void) {
    boot();
    fake_push_connect_failure(); dc_step(&c);
    CHECK(c.backoff_ms > 0, "failure sets backoff");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n"); dc_step(&c);
    CHECK_EQ_INT(c.backoff_ms, 0);
}

// Review round 1, Important finding: with the fake clock pinned at 0 (as
// every other backoff test leaves it, via boot()'s fake_set_clock(0)),
// c->now() % 250 is 0 for the whole test, so jitter was never exercised --
// a hardcoded 0, or a missing post-jitter recap, left the suite green.
// These three assertions pin the clock away from 0 and demand an EXACT
// value, so a silently-zeroed jitter term cannot hide.

static void test_jitter_is_added_from_the_clock_not_silently_zero(void) {
    boot();
    fake_set_clock(123);
    fake_push_connect_failure(); dc_step(&c);
    // now() % 250 == 123, and this is the very first backoff (from 0), so
    // the composition is exactly floor + jitter -- no doubling, no cap.
    CHECK_EQ_INT(c.backoff_ms, DC_BACKOFF_FLOOR_MS + 123);
}

static void test_jitter_never_pushes_backoff_past_the_cap(void) {
    boot();
    fake_set_clock(249); // the maximum possible jitter term (249 % 250)
    for (int i = 0; i < 8; i++) { // fake transport's queue caps at 8 pushes
        fake_push_connect_failure();
        dc_step(&c);
    }
    // Doubling alone reaches/exceeds the cap well before 10 iterations;
    // the +249 jitter added on top must still be re-capped, not left to
    // sit above DC_BACKOFF_CAP_MS.
    CHECK_EQ_INT(c.backoff_ms, DC_BACKOFF_CAP_MS);
}

static void test_status_success_does_not_reset_poll_backoff(void) {
    // Only a genuine poll success (dc_step's 204/200) resets backoff_ms.
    // A successful status heartbeat is a different, best-effort channel --
    // an over-eager dc_backoff_reset() call inside dc_report_status (a
    // plausible copy/paste error) would silently mask real poll trouble.
    boot();
    fake_push_connect_failure(); dc_step(&c);
    uint32_t after_fail = c.backoff_ms;
    CHECK(after_fail > 0, "failure sets backoff");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 4096, -55, NULL, "1.0.0+gtest");
    CHECK_EQ_INT(c.backoff_ms, after_fail);
}

static void test_status_sends_all_seven_fields(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 4096, -55, NULL, "1.0.0+gd16a1da");
    const char *r = fake_last_request();
    CHECK(strstr(r, "mountedSha256") != NULL, "mountedSha256");
    CHECK(strstr(r, "mountedDiskId") != NULL, "mountedDiskId");
    CHECK(strstr(r, "\"version\"")   != NULL, "version");
    CHECK(strstr(r, "\"error\"")     != NULL, "error");
    CHECK(strstr(r, "psramFree")     != NULL, "psramFree");
    CHECK(strstr(r, "\"rssi\"")      != NULL, "rssi");
    CHECK(strstr(r, "\"firmwareVersion\":\"1.0.0+gd16a1da\"") != NULL, "firmwareVersion");
    CHECK(strstr(r, "\"trackMaxBytes\":14336") != NULL, "trackMaxBytes reports this build's TRACK_MAX_BYTES");
}

// A NULL version reports null rather than omitting the key, the same honesty
// rule mountedSha256 follows: an absent key means "no opinion" to the server
// and leaves its column alone, which is not what a board with no version
// would be saying.
static void test_status_reports_a_null_version_explicitly(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 4096, -55, NULL, NULL);
    CHECK(strstr(fake_last_request(), "\"firmwareVersion\":null") != NULL,
          "a version-less report must say null, not omit the key");
}

// The body buffer was already within ~16 bytes of full before this field
// existed, and dc_report_status fails SILENTLY on overflow (`return false`),
// so an over-long body does not error -- the heartbeat simply stops, and only
// when an error string happens to be long. That is a state-dependent failure
// of the exact mechanism this field adds, so the budget gets a test rather
// than a comment.
static void test_status_body_fits_at_maximum(void) {
    boot();
    static char long_err[DC_STATUS_ERR_BYTES];
    memset(long_err, 'E', sizeof long_err - 1);
    long_err[sizeof long_err - 1] = '\0';

    // Longest of everything the body can carry at once: 64-hex sha, a 64-char
    // disk id, the largest mounted_version, and a 64-char firmware version
    // (FIRMWARE_VERSION_MAX, the server's own bound).
    memset(c.mounted_sha256, 'a', 64); c.mounted_sha256[64] = '\0';
    memset(c.mounted_disk_id, 'b', 64); c.mounted_disk_id[64] = '\0';
    c.mounted_version = 4294967295u;
    static char long_ver[65];
    memset(long_ver, 'v', 64); long_ver[64] = '\0';

    static char long_fw_err[201]; memset(long_fw_err, 'F', 200); long_fw_err[200] = '\0';
    dc_fw_report_t fr = { DC_UPDATE_PROTOCOL, "downloading", long_fw_err, 4294967295u };
    dc_set_fw_report(&c, &fr);
    dc_set_nfc_reader(&c, "present");   // the longer of the two words
    dc_set_plays_hd(&c, true);
    dc_set_sel1(&c, false, false);   // the longer spelling
    // Multi-disk: the longer of the two preload forms. Both carry a 64-hex
    // digest, and "loading" is 2 bytes longer than "ready" -- so a preload in
    // progress, which names next's digest.
    c.preload.slot = SLOT_NONE;
    c.preload.loading = true;
    memset(c.preload.next_sha256, 'd', 64); c.preload.next_sha256[64] = '\0';
    // OLED layouts: the largest ack, and a reason made entirely of quotes --
    // every byte escapes to two, the longest displayError can get.
    c.display_ack = 4294967295u;
    memset(c.display_error, '"', sizeof c.display_error - 1);
    c.display_error[sizeof c.display_error - 1] = '\0';
    // DF1 (Task 15): a 64-hex record published to DF1 -- the longer df1Sha256
    // form. The record also carries `loading` above; the two never coexist on
    // the board (status is never sent mid-preload), but the bound must cover
    // the longest of each tail at once.
    psram_publish_slot(0);
    c.preload.slot = 1;
    memset(c.preload.sha256, 'e', 64); c.preload.sha256[64] = '\0';
    CHECK(psram_publish_df1(1), "precondition: DF1 holds the record's slot");
    dc_set_df1(&c, DF1_MODE_NEXT, true);
    c.drive_ack = 4294967295u;

    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(dc_report_status(&c, 2147483647, -200, long_err, long_ver),
          "a maximal body must still be sent, not silently dropped");
    const char *r = fake_last_request();
    CHECK(strstr(r, "\"firmwareVersion\"") != NULL,
          "the version survives a maximal body");
    CHECK(strstr(r, "\"rssi\":-200") != NULL,
          "the last field is not truncated away");
    CHECK(strstr(r, "\"firmwareInstructionAck\":4294967295") != NULL,
          "the last firmware field survives");
    CHECK(strstr(r, "\"nfcReader\":\"present\"") != NULL,
          "and so does the reader");
    CHECK(strstr(r, "\"state\":\"loading\"}") != NULL,
          "the preload record survives a maximal body");
    CHECK(strstr(r, "\"playsHd\":true,") != NULL,
          "playsHd survives a maximal body");
    CHECK(strstr(r, "\"df1Seen\":false") != NULL, "the SEL1 readings survive a maximal body");
    CHECK(strstr(r, "\"displayVersion\":4294967295") != NULL, "the display ack survives");
    CHECK(strstr(r, "\"secondDrive\":\"df1\",\"driveVersion\":4294967295") != NULL, "the drive ack survives");
    {
        // The whole reason, escaped, closing quote included: 47 x \" then ".
        static char want[16 + 2 * sizeof c.display_error + 2];
        int k = snprintf(want, sizeof want, "\"displayError\":\"");
        for (size_t i = 0; i + 1 < sizeof c.display_error; i++) { want[k++] = '\\'; want[k++] = '"'; }
        want[k++] = '"'; want[k] = '\0';
        CHECK(strstr(r, want) != NULL, "and the whole escaped reason");
    }
    {
        static char want[96];
        snprintf(want, sizeof want, "\"df1Sha256\":\"%s\"", c.preload.sha256);
        CHECK(strstr(r, want) != NULL, "the DF1 digest survives, closing quote included");
        const char *b = strstr(r, "\r\n\r\n");
        printf("  status body at maximum: %zu bytes (budget %d), request %zu (budget %d)\n",
               b ? strlen(b + 4) : 0, DC_STATUS_BODY_BYTES, strlen(r), DC_STATUS_REQ_BYTES);
    }
    c.preload.slot = SLOT_NONE; c.preload.sha256[0] = '\0'; c.preload.loading = false;
}

static void test_status_carries_the_firmware_fields(void) {
    boot();
    dc_fw_report_t r = { DC_UPDATE_PROTOCOL, "downloading", NULL, 4 };
    dc_set_fw_report(&c, &r);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(dc_report_status(&c, 0, -50, NULL, "1.0.0+gt"), "sent");
    const char *q = fake_last_request();
    CHECK(strstr(q, "\"updateProtocol\":1") != NULL, "protocol");
    CHECK(strstr(q, "\"firmwareUpdateState\":\"downloading\"") != NULL, "state");
    CHECK(strstr(q, "\"firmwareUpdateError\":null") != NULL, "an absent error is an explicit null");
    CHECK(strstr(q, "\"firmwareInstructionAck\":4") != NULL, "ack");
}
static void test_status_without_a_fw_report_omits_the_fields(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.0.0+gt");
    CHECK(strstr(fake_last_request(), "updateProtocol") == NULL,
          "a board that has not opted in must not claim the capability");
}

static void test_unmounted_reports_null_not_omitted(void) {
    // null means "I hold no disk" -- an honest report. Omitting the key means
    // "no opinion" and leaves the server's column stale.
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 4096, -55, NULL, "1.0.0+gtest");
    CHECK(strstr(fake_last_request(), "\"mountedSha256\":null") != NULL,
          "an unmounted device must report null explicitly");
}

// Fix round 1 (write-back piece 2b task 8): dc_report_status's return value
// is what main.c now relies on to decide whether it may advance its own
// "last reported to the server" bookkeeping. A failed report that was
// silently treated as sent let the server's mountedVersion fall behind the
// board's, which a later upload attempt then read as not_mounted and got
// parked, with no path back except a further mount change -- see the
// finding this fixes. These three pin the boundary a `bool` return has to
// get right: a genuinely delivered report (204), a transport failure that
// never reached the server at all, and a reply that reached the server but
// says it did NOT act on the report (500).
static void test_status_returns_true_on_204(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(dc_report_status(&c, 4096, -55, NULL, "1.0.0+gtest"),
          "a 204 is a report the server actually received");
}

static void test_status_returns_false_on_connect_failure(void) {
    boot();
    fake_push_connect_failure();
    CHECK(!dc_report_status(&c, 4096, -55, NULL, "1.0.0+gtest"),
          "a transport failure never reached the server -- not delivered");
}

static void test_status_returns_false_on_500(void) {
    boot();
    fake_push_response("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    CHECK(!dc_report_status(&c, 4096, -55, NULL, "1.0.0+gtest"),
          "a 5xx means the server did not act on the report -- not delivered");
}

// --- Task 10: a genuinely successful image fetch really publishes --------
// Every other test above that reaches dc_fetch_image's 200 branch uses a
// truncated or non-200 response, so none of them ever call
// image_parse_end()/psram_publish_slot() for real. Task 8's fill-then-
// publish memory-barrier ordering is only load-bearing once that actually
// happens; this pushes a real, complete, minimal WFMF image and checks it
// lands -- and that writeProtected from the poll body reaches
// device_client_t (device_client.h's mounted_write_protected).

static void put_u32_le(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}

// One payload byte (8 bits) per track: valid per the WFMF container, and
// small enough that the whole image plus HTTP framing fits comfortably
// inside transport_fake's FAKE_MAX_RESPONSE_BYTES (8192).
static int build_minimal_full_image(uint8_t *out) {
    put_u32_le(out + 0, IMAGE_MAGIC);
    put_u32_le(out + 4, IMAGE_VERSION);
    put_u32_le(out + 8, NUM_TRACKS);
    put_u32_le(out + 12, 0);
    int at = 16;
    for (int t = 0; t < NUM_TRACKS; t++) {
        put_u32_le(out + at, 8); at += 4;    // 8 bits = 1 payload byte
        out[at++] = (uint8_t)t;              // payload
        out[at++] = 0; out[at++] = 0; out[at++] = 0;  // pad to 4-byte boundary
    }
    return at;
}

// A real WFMF image embeds NUL bytes from byte 4 onward (IMAGE_VERSION=1
// as little-endian u32 is 01 00 00 00), so it cannot travel through
// fake_push_response's strlen()-based C-string API -- fake_push_response_bytes
// takes an exact length instead.
static void push_image_response(void) {
    static uint8_t body[4096];
    int body_len = build_minimal_full_image(body);
    char header[128];
    int hn = snprintf(header, sizeof header,
        "HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n", body_len);
    if (hn < 0 || (size_t)hn >= sizeof header) abort();
    static uint8_t full[sizeof header + sizeof body];
    memcpy(full, header, (size_t)hn);
    memcpy(full + hn, body, (size_t)body_len);
    fake_push_response_bytes(full, hn + body_len);
}

// A short, definitely-not-WFMF body with a Content-Length that matches it
// exactly -- the body arrives whole (r.body_complete == true), but
// image_parse_end() must still refuse it. Distinguishes "the bytes arrived"
// from "the bytes are a disk" -- dc_fetch_image's old dc_discard_sink-based
// code could never fail this way, since it never looked at the bytes at all.
static void push_corrupt_image_response(void) {
    static uint8_t body[32];
    memset(body, 0xAB, sizeof body);   // not the WFMF magic under any interpretation
    char header[128];
    int hn = snprintf(header, sizeof header,
        "HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n", (int)sizeof body);
    if (hn < 0 || (size_t)hn >= sizeof header) abort();
    static uint8_t full[sizeof header + sizeof body];
    memcpy(full, header, (size_t)hn);
    memcpy(full + hn, body, sizeof body);
    fake_push_response_bytes(full, hn + (int)sizeof body);
}

static void test_corrupt_image_body_blocks_the_digest_but_does_not_publish(void) {
    boot();
    int before = psram_active_slot();
    push_poll_desired_aa();
    push_corrupt_image_response();

    dc_state_t s = dc_step(&c);

    CHECK(s != DC_HALTED, "a corrupt image must not stop the poll loop");
    CHECK_EQ_INT(psram_active_slot(), before);
    CHECK(c.mounted_sha256[0] == '\0', "must not be reported as mounted");
    CHECK(dc_digest_is_blocked(&c, "aa"), "this digest must not be retried");
}

static void test_successful_image_fetch_publishes_and_reflects_write_protected(void) {
    boot();
    int target = psram_inactive_slot();
    push_poll_desired_aa();
    push_image_response();

    dc_state_t s = dc_step(&c);

    CHECK_EQ_INT(s, DC_IDLE_POLL);
    CHECK_EQ_INT(psram_active_slot(), target);
    CHECK(strcmp(c.mounted_sha256, "aa") == 0, "the fetched disk must actually be mounted");
    CHECK_EQ_INT((int)c.since, 7);
    CHECK(!c.mounted_write_protected,
          "writeProtected:false in the poll body must reach device_client_t");
}


// --- observations: what the OLED is told -----------------------------
// The server has always sent the disk's title, number and label in the poll
// body; this device discarded them until the display needed them. These
// tests exist because the alternative place to find out whether a title is
// right is a 0.91" panel, and that is exactly the verification loop the
// display work was meant to get out of.
#define MAX_OBS 64
static dc_obs_t seen[MAX_OBS];
static int n_seen;
static void record(void *ctx, const dc_obs_t *o) {
    (void)ctx;
    if (n_seen < MAX_OBS) seen[n_seen] = *o;
    n_seen++;
}
static void watch(void) { n_seen = 0; dc_set_observer(&c, record, NULL); }
static const dc_obs_t *last_of(dc_obs_kind_t k) {
    for (int i = (n_seen < MAX_OBS ? n_seen : MAX_OBS) - 1; i >= 0; i--)
        if (seen[i].kind == k) return &seen[i];
    return NULL;
}

static void test_the_disk_title_is_read_from_the_poll_body(void) {
    boot(); watch();
    push_ok_json("{\"version\":7,\"desired\":{\"sha256\":\"aa\",\"diskId\":\"d1\","
                 "\"gameId\":\"g\",\"game\":\"Sensible Soccer\",\"label\":\"Boot\","
                 "\"diskNo\":1,\"diskCount\":2,\"writeProtected\":true}}");
    push_image_response();
    dc_step(&c);

    const dc_obs_t *m = last_of(DC_OBS_MOUNTED);
    CHECK(m != NULL, "a successful mount must be observable");
    if (m) {
        CHECK(strcmp(m->title, "Sensible Soccer") == 0, "the title must survive the wire");
        CHECK(strcmp(m->label, "Boot") == 0, "and so must the label");
        CHECK_EQ_INT((int)m->disk_no, 1);
        CHECK_EQ_INT((int)m->disk_count, 2);
    }
}

static void test_an_eject_clears_the_title(void) {
    // Otherwise the panel goes on naming a disk the drive no longer holds,
    // which is worse than a blank line: it is a confident wrong answer.
    boot(); watch();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "aa");
    strcpy(c._fetch_title, "Sensible Soccer");
    push_ok_json("{\"version\":9,\"desired\":null}");
    dc_step(&c);

    const dc_obs_t *e = last_of(DC_OBS_EJECTED);
    CHECK(e != NULL, "an eject must be observable");
    if (e) CHECK(e->title[0] == '\0', "an ejected drive must not still name a disk");
}

static void test_an_already_mounted_disk_is_still_named(void) {
    // The reboot case. A board that comes up with its disk already in PSRAM
    // never runs the fetch path again, so if only the fetch announced the
    // title the panel would read LOADED with no name until the next swap.
    boot(); watch();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "aa");
    push_ok_json("{\"version\":7,\"desired\":{\"sha256\":\"aa\",\"diskId\":\"d1\","
                 "\"gameId\":\"g\",\"game\":\"Lemmings\",\"diskNo\":1,"
                 "\"diskCount\":1,\"writeProtected\":true}}");
    dc_step(&c);

    const dc_obs_t *m = last_of(DC_OBS_MOUNTED);
    CHECK(m != NULL, "a reconciliation poll must still name the disk");
    if (m) CHECK(strcmp(m->title, "Lemmings") == 0, "and name it correctly");
}

static void test_a_missing_title_never_stops_a_mount(void) {
    // The drive's job is to hold the disk. A blank line on a display is not
    // a reason to refuse one, so an absent title must cost nothing but the
    // title itself.
    boot(); watch();
    push_poll_desired_aa();          // fixture carries no "label"
    push_image_response();
    dc_state_t st = dc_step(&c);
    CHECK_EQ_INT(st, DC_IDLE_POLL);
    CHECK(strcmp(c.mounted_sha256, "aa") == 0, "the disk must mount regardless");
}

static void test_a_stale_title_cannot_survive_into_a_different_disk(void) {
    boot(); watch();
    strcpy(c._fetch_title, "Previous Disk");
    strcpy(c._fetch_label, "Old Label");
    // This body names a disk but carries NO title fields at all.
    push_ok_json("{\"version\":7,\"desired\":{\"sha256\":\"aa\",\"diskId\":\"d1\","
                 "\"gameId\":\"g\",\"writeProtected\":true}}");
    push_image_response();
    dc_step(&c);
    const dc_obs_t *m = last_of(DC_OBS_MOUNTED);
    CHECK(m != NULL, "still mounts");
    if (m) CHECK(m->title[0] == '\0',
                 "a title from the PREVIOUS disk must not be shown for this one");
}

static void test_progress_is_reported_once_per_percent(void) {
    // The body sink runs once per 4 KB read -- ~500 times for a 2 MB image.
    // An observation per call would be ~400 publishes that render the exact
    // same frame, on a core that is also running the TLS read loop.
    boot(); watch();
    push_poll_desired_aa();
    push_image_response();
    dc_step(&c);
    int n = 0;
    for (int i = 0; i < n_seen && i < MAX_OBS; i++)
        if (seen[i].kind == DC_OBS_FETCH_PROGRESS) n++;
    CHECK(n <= 101, "progress must be throttled to whole percent changes");
}

static void test_an_absent_observer_changes_nothing(void) {
    // The display must not be able to break a mount. Same fixtures, no
    // observer, same outcome.
    boot();
    dc_set_observer(&c, NULL, NULL);
    push_poll_desired_aa();
    push_image_response();
    dc_state_t st = dc_step(&c);
    CHECK_EQ_INT(st, DC_IDLE_POLL);
    CHECK(strcmp(c.mounted_sha256, "aa") == 0, "mount is unaffected by observation");
}

// --- Task 10: registration -------------------------------------------
// dc_register is the one request in the protocol with no bearer -- the
// pairing code IS the credential (device_client.h) -- and is called while
// `c` is otherwise fully provisioned (boot() gives it token "tok") to
// prove it never sends that token regardless.

static void test_register_body_has_the_three_required_fields(void) {
    boot(); token_store_erase();
    push_ok_json("{\"token\":\"t-1\",\"deviceId\":\"d-1\",\"name\":\"Device x\"}");
    CHECK_EQ_INT(dc_register(&c, "ABC123", "4a.0", "aa:bb:cc:dd:ee:ff"), DC_REG_OK);
    const char *r = fake_last_request();
    CHECK(strstr(r, "pairingCode")     != NULL, "pairingCode");
    CHECK(strstr(r, "firmwareVersion") != NULL, "firmwareVersion");
    CHECK(strstr(r, "macAddress")      != NULL, "macAddress");
    CHECK(strstr(r, "Authorization")   == NULL,
          "register is deliberately unauthenticated -- the code IS the credential");
}

static void test_register_stores_the_returned_token(void) {
    boot(); token_store_erase();
    push_ok_json("{\"token\":\"t-1\",\"deviceId\":\"d-1\",\"name\":\"Device x\"}");
    CHECK_EQ_INT(dc_register(&c, "ABC123", "4a.0", "aa:bb:cc:dd:ee:ff"), DC_REG_OK);
    CHECK(token_store_load(buf, sizeof buf), "token persisted");
    CHECK(strcmp(buf, "t-1") == 0, "the returned token");
}

static void test_register_sends_the_protocol_only_when_set(void) {
    boot();
    dc_fw_report_t r = { DC_UPDATE_PROTOCOL, NULL, NULL, 0 };
    dc_set_fw_report(&c, &r);
    push_ok_json("{\"token\":\"t\"}");
    dc_register(&c, "ABC123", "1.0.0+gt", "aa:bb:cc:dd:ee:ff");
    CHECK(strstr(fake_last_request(), "\"updateProtocol\":1") != NULL, "register declares it");
}

static void test_bad_code_does_not_store_anything(void) {
    boot(); token_store_erase();
    // The body carries a `token` field on purpose, alongside the error --
    // a fixture with no `token` key at all would let this test pass even
    // if dc_register() stopped checking the status code entirely (a 200
    // check dropped in favour of "did the body have a token" would still
    // reject this response, just for the wrong reason, and never be
    // caught). Only actually honouring the 400 keeps this out of the
    // store.
    push_status_json("HTTP/1.1 400 Bad Request",
        "{\"error\":\"invalid_or_used_code\",\"token\":\"should-not-be-used\"}");
    CHECK_EQ_INT(dc_register(&c, "WRONG", "4a.0", "aa:bb:cc:dd:ee:ff"), DC_REG_BAD_CODE);
    CHECK(!token_store_load(buf, sizeof buf), "nothing may be stored on failure");
}

// Task 7, spec D-4b-4: invalid_or_used_code is terminal, not retryable --
// main.c routes it straight to provisioning.h's
// prov_on_pairing_code_rejected() instead of looping dc_register() under
// backoff forever. DC_REG_BAD_CODE is what lets the caller tell this
// apart from every other failure shape, which stays DC_REG_RETRY.
static void test_invalid_code_is_reported_as_bad_code_not_retry(void) {
    boot(); token_store_erase();
    push_status_json("HTTP/1.1 400 Bad Request",
        "{\"error\":\"invalid_or_used_code\"}");
    CHECK_EQ_INT(dc_register(&c, "WRONG", "4b.0", "aa:bb:cc:dd:ee:ff"), DC_REG_BAD_CODE);
}

// A 400 for any other reason (a malformed body, say) is NOT the terminal
// case above -- it must stay retryable, or a transient server-side bug
// would strand a device in the portal for no recoverable reason.
static void test_other_400_is_still_retryable(void) {
    boot(); token_store_erase();
    push_status_json("HTTP/1.1 400 Bad Request",
        "{\"error\":\"invalid_body\"}");
    CHECK_EQ_INT(dc_register(&c, "ABC123", "4b.0", "aa:bb:cc:dd:ee:ff"), DC_REG_RETRY);
}

// Review round 1, Important I-2: main.c's registration loop reads
// c->backoff_ms and sleeps on it between attempts (exactly like the poll
// loop does for dc_step()) -- but dc_register() itself has to be the thing
// that grows it, or a fresh device_client_t's backoff_ms stays 0 forever
// and that sleep is always DC_BACKOFF_FLOOR_MS flat, hammering the
// deliberately unauthenticated /api/device/register endpoint at 1 req/s
// on a bad or already-used pairing code. Mirrors
// test_backoff_grows_and_is_capped's shape, against dc_register instead of
// dc_step.
static void test_register_backs_off_on_repeated_failure(void) {
    boot(); token_store_erase();
    uint32_t prev = 0;
    for (int i = 0; i < 5; i++) {
        push_status_json("HTTP/1.1 400 Bad Request",
            "{\"error\":\"invalid_or_used_code\"}");
        CHECK_EQ_INT(dc_register(&c, "WRONG", "4a.0", "aa:bb:cc:dd:ee:ff"), DC_REG_BAD_CODE);
        CHECK(c.backoff_ms >= prev, "backoff must not shrink on repeated failure");
        prev = c.backoff_ms;
    }
    CHECK(prev > 0,
          "a failed dc_register must grow backoff_ms, or main.c's register "
          "loop hammers the endpoint at a flat 1 req/s forever");
}


// --- Final review, Important 2: a blocked digest must not become a
// request storm -------------------------------------------------------
//
// `since` advances ONLY in dc_complete_transition, i.e. only after a real
// swap or a real eject. Every blocked-digest exit leaves it where it was.
// The server (src/app/api/device/poll/route.ts) answers a poll the instant
// `version > since`, so once a permanently-unfetchable disk is desired,
// every poll returns 200 immediately, forever. main.c sleeps only on the
// delay device_client.c hands it, so if these exits return DC_IDLE_POLL
// with backoff_ms untouched, core1 re-polls at full TLS-handshake rate
// with no pause at all -- against Vercel, indefinitely.
//
// These tests pin the floor. They assert on the DELAY, not on a particular
// state name, because the delay is the thing main.c actually sleeps on.

static void test_a_blocked_digest_never_repolls_without_a_delay(void) {
    boot();
    // Cycle 1: the poll names "aa" and the image endpoint permanently
    // rejects it, so "aa" joins the blocked set and no transition happens.
    poll_then_image("HTTP/1.1 422 Unprocessable Entity\r\nContent-Length: 23\r\n\r\n"
                    "{\"error\":\"unencodable\"}");
    dc_step(&c);
    CHECK(dc_digest_is_blocked(&c, "aa"), "precondition: the digest is blocked");
    CHECK_EQ_INT((int)c.since, 0);

    // Cycles 2..6: the server keeps answering the same 200 immediately,
    // because `since` never moved. Each one must come back with a real,
    // non-shrinking delay for main.c to sleep on.
    uint32_t prev = 0;
    for (int i = 0; i < 5; i++) {
        push_poll_desired_aa();
        dc_state_t s = dc_step(&c);
        CHECK_EQ_INT(s, DC_BACKOFF);
        CHECK(c.backoff_ms >= DC_BACKOFF_FLOOR_MS,
              "a 200 the device could not act on must leave main.c a delay "
              "to sleep on, or this is an unthrottled request storm");
        CHECK(c.backoff_ms >= prev, "the delay must not shrink");
        prev = c.backoff_ms;
    }
    CHECK(prev > DC_BACKOFF_FLOOR_MS,
          "the delay must GROW across repeats, not sit pinned at the floor -- "
          "an unconditional dc_backoff_reset() on any 200 would pin it there");
    CHECK_EQ_INT((int)c.since, 0);
    CHECK(c.mounted_sha256[0] == '\0', "still nothing mounted, still not ejected");
}

// The same floor, one cycle earlier: the very poll whose image fetch fails
// permanently (not just the later short-circuited ones) must already come
// back with a delay.
static void test_the_fetch_that_blocks_the_digest_also_backs_off(void) {
    boot();
    poll_then_image("HTTP/1.1 404 Not Found\r\nContent-Length: 21\r\n\r\n"
                    "{\"error\":\"not_found\"}");
    dc_state_t s = dc_step(&c);
    CHECK_EQ_INT(s, DC_BACKOFF);
    CHECK(c.backoff_ms >= DC_BACKOFF_FLOOR_MS, "must not re-poll instantly");
    CHECK(s != DC_HALTED, "and must still not stop the poll loop");
}

// A 200 whose body is a well-formed WFMF-less mess blocks the digest too
// (image_parse_end() fails), and takes the same floor.
static void test_a_corrupt_image_body_also_backs_off(void) {
    boot();
    push_poll_desired_aa();
    push_corrupt_image_response();
    CHECK_EQ_INT(dc_step(&c), DC_BACKOFF);
    CHECK(c.backoff_ms >= DC_BACKOFF_FLOOR_MS, "must not re-fetch instantly");
    CHECK(dc_digest_is_blocked(&c, "aa"), "and must not retry the digest");
}

// The other half of the same change: dc_step no longer resets backoff_ms
// on ANY 200, only on a productive one. These two pin that a real
// transition still clears it, so the throttle above cannot creep into the
// happy path and slow down a healthy device.
static void test_a_successful_swap_still_clears_the_backoff(void) {
    boot();
    fake_push_connect_failure(); dc_step(&c);
    CHECK(c.backoff_ms > 0, "precondition: a failure has set a backoff");

    push_poll_desired_aa();
    push_image_response();
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK_EQ_INT(c.backoff_ms, 0);
    CHECK_EQ_INT((int)c.since, 7);
}

static void test_an_eject_still_clears_the_backoff(void) {
    boot();
    fake_push_connect_failure(); dc_step(&c);
    CHECK(c.backoff_ms > 0, "precondition: a failure has set a backoff");

    push_ok_json("{\"version\":9,\"desired\":null}");
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK_EQ_INT(c.backoff_ms, 0);
    CHECK_EQ_INT((int)c.since, 9);
}

// --- Final review, Minor 6: a truncated poll body is never acted on ----
// readDesired() emits `sha256` first and `writeProtected` LAST, after the
// free-text `game` title, so an over-long title drops exactly the field
// whose absence fails open once write-back exists. Acting on the prefix is
// the wrong answer; so is silently defaulting. Refuse the body.
static void test_an_over_long_poll_body_is_refused_not_truncated(void) {
    boot();
    static char body[6000];
    static char title[3000];
    memset(title, 'A', sizeof title - 1);
    title[sizeof title - 1] = '\0';
    int bn = snprintf(body, sizeof body,
        "{\"version\":11,\"desired\":{\"sha256\":\"bb\",\"diskId\":\"d1\","
        "\"gameId\":\"g\",\"game\":\"%s\",\"diskNo\":1,\"diskCount\":1,"
        "\"label\":\"L\",\"writeProtected\":false}}", title);
    if (bn < 0 || (size_t)bn >= sizeof body) abort();

    // Content-Length computed from the body, never hand-counted.
    static char resp[6200];
    int rn = snprintf(resp, sizeof resp, "HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n%s",
                      bn, body);
    if (rn < 0 || (size_t)rn >= sizeof resp) abort();
    fake_push_response(resp);

    dc_state_t s = dc_step(&c);
    CHECK_EQ_INT(s, DC_BACKOFF);
    CHECK_EQ_INT((int)c.since, 0);
    CHECK(c.mounted_sha256[0] == '\0',
          "a body whose tail was cut off must not be acted on at all");
    CHECK(!dc_digest_is_blocked(&c, "bb"),
          "and must not poison the digest -- the digest itself is fine");
    CHECK_EQ_INT(fake_request_count(), 1);
}

// --- Task 3 (write-back 2b): hold, force refetch, adopt, post ------------

static bool hold_true(void *ctx)  { (void)ctx; return true; }
static bool hold_false(void *ctx) { (void)ctx; return false; }

static void hold_keeps_the_disk_through_a_swap(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "old"); strcpy(c.mounted_disk_id, "d1");
    c.since = 3; c.mounted_version = 3;
    dc_set_hold(&c, hold_true, NULL);
    push_ok_json("{\"version\":8,\"desired\":{\"sha256\":\"new\",\"diskId\":\"d2\",\"gameId\":\"g\","
                 "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
    dc_state_t s = dc_step(&c);
    CHECK_EQ_INT(s, DC_IDLE_POLL);
    CHECK_EQ_INT(fake_request_count(), 1);            // the poll, and no image fetch
    CHECK(strcmp(c.mounted_sha256, "old") == 0, "D7: never swap away from unsent writes");
    CHECK_EQ_INT(c.since, 3);                         // asked again once the hold lifts
    CHECK_EQ_INT(psram_active_slot(), 0);
}

static void hold_keeps_the_disk_through_an_eject(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "old"); c.since = 3; c.mounted_version = 3;
    dc_set_hold(&c, hold_true, NULL);
    push_ok_json("{\"version\":9,\"desired\":null}");
    dc_step(&c);
    CHECK(strcmp(c.mounted_sha256, "old") == 0, "D7: never eject with unsent writes");
    CHECK_EQ_INT(psram_active_slot(), 0);
    CHECK_EQ_INT(c.since, 3);
}

static void a_lifted_hold_lets_the_eject_through(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "old"); c.since = 3;
    dc_set_hold(&c, hold_false, NULL);
    push_ok_json("{\"version\":9,\"desired\":null}");
    dc_step(&c);
    CHECK(c.mounted_sha256[0] == '\0', "no pending writes: the eject happens");
    CHECK_EQ_INT(psram_active_slot(), SLOT_NONE);
}

static void force_refetch_fetches_the_digest_already_mounted(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "aa"); c.since = 7; c.mounted_version = 7;
    dc_force_refetch(&c);
    CHECK_EQ_INT(c.since, 0);
    push_ok_json("{\"version\":8,\"desired\":{\"sha256\":\"aa\",\"diskId\":\"d1\",\"gameId\":\"g\","
                 "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
    push_image_response();
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "GET /api/device/image/aa") != NULL,
          "the server's image won: the board's copy must be replaced even though the digest matches");
    CHECK_EQ_INT(c.mounted_version, 8);
}

static void adopt_makes_the_next_poll_a_no_op(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "aa"); c.since = 7;
    dc_adopt_image(&c, "bb");
    CHECK(strcmp(c.mounted_sha256, "bb") == 0, "adopted");
    push_ok_json("{\"version\":8,\"desired\":{\"sha256\":\"bb\",\"diskId\":\"d1\",\"gameId\":\"g\","
                 "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
    dc_step(&c);
    CHECK_EQ_INT(fake_request_count(), 1);            // no image fetch: already held
    CHECK_EQ_INT(c.mounted_version, 8);
}

// --- keep-alive: a reused connection can be dead without anyone knowing ---
//
// The real transport hands a clean socket back instead of closing it, so the
// next request skips the ~1.25 s handshake. The cost of that is a connection
// the server may have closed since: the failure surfaces only when we try to
// use it. Retrying THAT once, on a fresh connection, is safe -- nothing was
// answered, so nothing was acted on twice.

static void a_dead_reused_connection_is_retried_once(void) {
    boot();
    fake_set_reused(true);
    fake_push_truncated("HTTP/1.1 204 No Content\r\n\r\n", 0);  // closed, said nothing
    push_ok_json("{\"version\":4,\"desired\":null}");            // the retry is answered
    dc_state_t st = dc_step(&c);
    CHECK_EQ_INT(fake_request_count(), 2);
    CHECK_EQ_INT(st, DC_IDLE_POLL);
    CHECK_EQ_INT(c.since, 4);
}

static void a_fresh_connection_that_says_nothing_is_not_retried(void) {
    boot();
    fake_set_reused(false);
    fake_push_truncated("HTTP/1.1 204 No Content\r\n\r\n", 0);
    dc_state_t st = dc_step(&c);
    CHECK_EQ_INT(fake_request_count(), 1);   // that is the network being down
    CHECK_EQ_INT(st, DC_BACKOFF);
}

static void a_request_the_server_began_answering_is_never_resent(void) {
    boot();
    c.mounted_version = 5;
    fake_set_reused(true);
    // Status line arrives, then the connection dies: the server HAS acted on
    // this request. Sending it again could repeat whatever it did.
    fake_push_truncated("HTTP/1.1 200 OK\r\nContent-Length: 400\r\n\r\n{\"version\":9", 45);
    dc_state_t st = dc_step(&c);
    CHECK_EQ_INT(fake_request_count(), 1);
    CHECK_EQ_INT(st, DC_BACKOFF);
    CHECK_EQ_INT(c.mounted_version, 5);      // nothing acted on
}

// --- keep-alive, round 2: what close() may and may not keep -----------
//
// The fake now models the real transport: close() HOLDS the connection open,
// abandon() ends it, and `reused` is reported per connect(). That is what
// makes the rules below testable at all -- with a sticky "pretend reused"
// flag, none of these could tell a kept socket from an abandoned one.

// C1. The retry is once. A dead kept connection that fails, then a fresh
// connection that also says nothing, is the network being unreachable --
// not a third attempt. (Before abandon() existed, the failed attempt's
// close() handed the dead socket back, so the retry reused it too and the
// "reused and silent" condition stayed true for as long as anyone looked.)
static void two_dead_connections_in_a_row_stop_at_two_requests(void) {
    boot();
    fake_set_reused(true);                                     // a socket is held
    fake_push_truncated("HTTP/1.1 204 No Content\r\n\r\n", 0); // it says nothing
    fake_push_truncated("HTTP/1.1 204 No Content\r\n\r\n", 0); // nor does the retry
    dc_state_t st = dc_step(&c);
    CHECK_EQ_INT(fake_request_count(), 2);
    CHECK_EQ_INT(st, DC_BACKOFF);
    CHECK(!fake_connection_is_kept(),
          "a connection that answered nothing must not be held for the next request");
}

// C1. The retry must land on a NEW connection -- the whole point of it.
static void the_retry_lands_on_a_fresh_connection(void) {
    boot();
    fake_set_reused(true);
    fake_push_truncated("HTTP/1.1 204 No Content\r\n\r\n", 0);
    push_ok_json("{\"version\":4,\"desired\":null}");
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK_EQ_INT(fake_request_count(), 2);
    CHECK(!fake_last_reused(),
          "the retry must be a fresh connection, not the same dead socket again");
}

// C2 regression. `r` is static in every caller, so it still holds the last
// exchange's 200 when the next one fails before a byte goes out. With
// http_resp_init() after the write loop, dc_exchange read that stale 200,
// concluded the server had answered, and skipped the retry -- so a kept
// connection that died between requests cost the whole exchange, every time,
// with nothing in the log to say why. A WRITE failure is the case that
// reaches it: the socket is gone, the request never left.
static void a_write_failure_on_a_kept_connection_is_retried_once(void) {
    boot();
    push_ok_json("{\"version\":3,\"desired\":null}");   // leaves r.status == 200
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK(fake_connection_is_kept(), "a clean exchange keeps its connection");

    fake_kill_kept_connection();                       // it died while idle
    push_ok_json("{\"version\":4,\"desired\":null}");   // the retry is answered
    dc_state_t st = dc_step(&c);
    CHECK_EQ_INT(fake_request_count(), 3);             // 1 + (dead + retry)
    CHECK_EQ_INT(st, DC_IDLE_POLL);
    CHECK_EQ_INT(c.since, 4);
}

// I3. `status == 0` is not "the server never saw it". Bytes that arrived
// without amounting to a status line still mean the request was delivered
// and the server is answering -- the same shape a read timeout on a POST
// the server is still working on has. Only NOTHING arriving is safe to
// repeat, so the count of bytes read is the condition, not the status.
static void bytes_that_arrived_without_a_status_line_block_the_retry(void) {
    boot();
    fake_set_reused(true);
    // Part of a status line, then the connection dies: status stays 0, but
    // this request unquestionably reached the server.
    fake_push_truncated("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi", 7);
    // A trap, never consumed: without it a wrong retry aborts the binary on
    // the empty queue instead of failing the count below readably.
    push_ok_json("{\"version\":99,\"desired\":null}");
    dc_state_t st = dc_step(&c);
    CHECK_EQ_INT(fake_request_count(), 1);
    CHECK_EQ_INT(st, DC_BACKOFF);
}

// I3. /api/device/register has no idempotency: the pairing code is
// single-use, so a resend of a registration the server may already have
// processed turns a lost response into a terminal invalid_or_used_code and
// sends the board back to the portal for a code a human must re-issue. It is
// the one request that is never repeated, whatever the socket did.
static void a_register_post_is_never_retried(void) {
    boot();
    fake_set_reused(true);
    fake_push_truncated("HTTP/1.1 200 OK\r\n\r\n", 0);  // kept socket, silent
    // A trap, never consumed: a registration that got resent would take
    // this and succeed, which is exactly the outcome being forbidden.
    push_ok_json("{\"token\":\"t0k3n\"}");
    CHECK_EQ_INT(dc_register(&c, "ABC123", "4a.0", "aa:bb:cc:dd:ee:ff"), DC_REG_RETRY);
    CHECK_EQ_INT(fake_request_count(), 1);
}

// C1. The load-bearing one. A response we gave up on leaves the rest of
// itself on the socket; keeping it means the NEXT request reads the tail of
// THIS one as its answer -- a permanent off-by-one that never self-heals.
// close() cannot see the difference, which is why abandon() exists.
static void an_abandoned_exchange_never_reuses_the_socket(void) {
    boot();
    // Malformed: a chunk body not followed by CRLF. http_resp_feed rejects
    // it mid-response, with bytes still unread on the wire.
    fake_push_response("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
                       "5\r\nhelloXX");
    CHECK_EQ_INT(dc_step(&c), DC_BACKOFF);
    CHECK(!fake_connection_is_kept(),
          "a malformed response must not leave its connection open");

    push_ok_json("{\"version\":7,\"desired\":null}");
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK(!fake_last_reused(),
          "the next request must be on a new connection, not the abandoned one");
}

// I7. A response that says it is the last one on this connection must not be
// kept, however cleanly it finished.
static void a_connection_close_response_is_not_kept(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK(!fake_connection_is_kept(),
          "Connection: close means the peer is going away -- do not hold the socket");
}

// A clean exchange DOES keep its connection, and the next request rides it.
// Without this the tests above would all pass on a transport that never
// reused anything at all.
static void a_clean_exchange_hands_its_connection_to_the_next_one(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    push_ok_json("{\"version\":2,\"desired\":null}");
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK(fake_connection_is_kept(), "a drained response leaves a reusable socket");
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK(fake_last_reused(), "the second request must ride the kept connection");
    CHECK_EQ_INT(fake_request_count(), 2);
}

// --- keep-alive, round 3: body_complete is not a keep signal -----------

// A close-delimited response -- no Content-Length, no chunked encoding, not
// a bodyless status -- is "complete" only in the sense that http.c cannot
// delimit anything further. The body is still arriving. Keeping that socket
// hands the rest of it to the next request, which is C1's desync arriving
// through the one door abandon() does not cover, because nothing about this
// path looks like a failure.
static void a_close_delimited_response_is_not_kept(void) {
    boot();
    fake_push_response("HTTP/1.1 200 OK\r\n\r\n{\"version\":4,\"desired\":null}");
    dc_step(&c);
    CHECK(!fake_connection_is_kept(),
          "a response with no framing header at all must not leave its socket open");
}

// The same rule, from the other side: a response that DID say how long it is
// still gets kept. Without this the fix could be "never keep anything".
static void an_explicitly_framed_response_is_still_kept(void) {
    boot();
    push_ok_json("{\"version\":4,\"desired\":null}");   // carries Content-Length
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK(fake_connection_is_kept(), "Content-Length is explicit framing -- keep it");
}

// Minor: bytes past the end of a complete response. The parser discards them
// (they belong to nothing anyone asked for), so by the time tls_close() looks
// at the socket they are already out of rx_head and "drained to the last
// byte" cannot see them. Recorded now, and abandoned on.
static void bytes_after_a_complete_response_are_not_kept(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\nHTTP/1.1 200 OK\r\n"
                       "Content-Length: 2\r\n\r\nhi");
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK(!fake_connection_is_kept(),
          "a stream with bytes left over after the response is already out of step");
}

// Item 7. A request that went out in part and then hit a socket that was
// already gone. The half-sent bytes are sitting in whatever the far end has
// left; that connection can never carry another request, and the retry must
// not land on it. Nothing was answered, so the retry itself is legitimate.
static void a_partial_write_that_then_fails_is_abandoned_and_retried(void) {
    boot();
    push_ok_json("{\"version\":2,\"desired\":null}");
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK(fake_connection_is_kept(), "a clean exchange keeps its connection");

    fake_kill_kept_connection();
    fake_set_max_write(16);                            // 16 bytes out, then gone
    push_ok_json("{\"version\":5,\"desired\":null}");   // the retry is answered
    dc_state_t st = dc_step(&c);

    CHECK_EQ_INT(fake_request_count(), 3);             // 1 + (half-sent + retry)
    CHECK(!fake_last_reused(),
          "the retry must not land on the socket holding half a request");
    CHECK_EQ_INT(st, DC_IDLE_POLL);
    CHECK_EQ_INT(c.since, 5);
    CHECK(strncmp(fake_last_request(), "GET /api/device/poll?since=", 27) == 0 &&
          strstr(fake_last_request(), "\r\n\r\n") != NULL,
          "the server saw one whole request, not the tail of a truncated one");
}

// Item 7. A connect that failed reached nothing -- so nothing in the fake
// releases the connection still being held. Only dc_attempt's abandon() on
// the connect-failure path does, and without it the board would carry that
// pcb (and its ~32 KB of mbedTLS buffers) through every later failure.
static void a_connect_failure_releases_a_held_connection(void) {
    boot();
    push_ok_json("{\"version\":2,\"desired\":null}");
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK(fake_connection_is_kept(), "a clean exchange keeps its connection");

    fake_push_connect_failure();
    CHECK_EQ_INT(dc_step(&c), DC_BACKOFF);
    CHECK_EQ_INT(fake_request_count(), 2);
    CHECK(!fake_connection_is_kept(),
          "a connect that failed must still release the connection being held");
}

static void post_sends_a_binary_body_whole(void) {
    boot();
    static uint8_t body[DC_POST_BODY_MAX];
    for (int i = 0; i < DC_POST_BODY_MAX; i++) body[i] = (uint8_t)(i * 13);
    push_ok_json("{\"staged\":3}");
    char resp[64];
    int st = dc_post(&c, "/api/device/write?track=3", "application/octet-stream",
                     body, DC_POST_BODY_MAX, resp, sizeof resp);
    CHECK_EQ_INT(st, 200);
    CHECK(strcmp(resp, "{\"staged\":3}") == 0, "response body returned");
    CHECK(strstr(fake_last_request(), "POST /api/device/write?track=3 HTTP/1.1") != NULL, "line");
    char clen[40];
    snprintf(clen, sizeof clen, "Content-Length: %d\r\n", DC_POST_BODY_MAX);
    CHECK(strstr(fake_last_request(), clen) != NULL, "length: DC_POST_BODY_MAX, an HD track");
    int n = fake_last_request_len();
    CHECK(n > DC_POST_BODY_MAX, "head + body");
    CHECK(memcmp(fake_last_request() + n - DC_POST_BODY_MAX, body, DC_POST_BODY_MAX) == 0,
          "the body arrives byte for byte, NULs and all");
}

static void post_reports_a_dead_link_and_a_dead_token(void) {
    boot();
    char resp[64];
    fake_push_connect_failure();
    CHECK_EQ_INT(dc_post(&c, "/c", NULL, NULL, 0, resp, sizeof resp), -1);
    push_status_json("HTTP/1.1 401 Unauthorized", "{\"error\":\"unauthorized\"}");
    CHECK_EQ_INT(dc_post(&c, "/c", NULL, NULL, 0, resp, sizeof resp), 401);
    CHECK_EQ_INT(c.state, DC_HALTED);
}

static uint8_t fw_got[64]; static int fw_got_n;
static void fw_sink(void *ctx, const uint8_t *b, int n) { (void)ctx; memcpy(fw_got + fw_got_n, b, (size_t)n); fw_got_n += n; }

static void test_fetch_firmware_streams_the_body(void) {
    boot(); fw_got_n = 0;
    fake_push_response("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nHELLO");
    CHECK_EQ_INT(dc_fetch_firmware(&c, "1.1.0+gx", fw_sink, NULL), 200);
    CHECK(strstr(fake_last_request(), "GET /api/device/firmware/1.1.0+gx ") != NULL, "path");
    CHECK(fw_got_n == 5 && memcmp(fw_got, "HELLO", 5) == 0, "body streamed to the sink");
}
static void test_fetch_firmware_incomplete_is_minus_one(void) {
    boot(); fw_got_n = 0;
    fake_push_truncated("HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\nHELLO", 44);
    CHECK_EQ_INT(dc_fetch_firmware(&c, "1.1.0+gx", fw_sink, NULL), -1);
}
static void test_fetch_firmware_401_halts(void) {
    boot();
    fake_push_response("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    CHECK_EQ_INT(dc_fetch_firmware(&c, "1.1.0+gx", fw_sink, NULL), 401);
    CHECK_EQ_INT(c.state, DC_HALTED);
}

// --- why a firmware download failed (2026-10-09) ---------------------------
// OTA downloads on long-running boards retried for minutes and every failure
// reached fw_update.c as a bare -1. These pin down that the failure is now
// recorded (last_xfer) and said (two "fw:" lines), per stage.
static char fw_log[4096];
static void fw_log_sink(const char *line) {
    size_t n = strlen(fw_log);
    snprintf(fw_log + n, sizeof fw_log - n, "%s\n", line);
}
static const char *fw_logs(void) { wf_log_drain(1000); return fw_log; }
static void fw_log_reset(void) {
    wf_log_test_reset(); wf_log_test_set_sink(fw_log_sink); fw_log[0] = '\0';
}

static void test_fetch_firmware_read_failure_mid_body_is_named(void) {
    boot(); fw_got_n = 0; fw_log_reset();
    // The server sends the head and five body bytes of fifty, then nothing:
    // the read waits out its timeout, which is a read FAILURE, not a close.
    fake_push_held("HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\nHELLO");
    CHECK_EQ_INT(dc_fetch_firmware(&c, "1.1.0+gx", fw_sink, NULL), -1);
    CHECK_EQ_INT(c.last_xfer.stage, DC_XFER_READ);
    CHECK(c.last_xfer.rc < 0, "the transport's code is kept");
    CHECK_EQ_INT(c.last_xfer.status, 200);
    CHECK_EQ_INT(c.last_xfer.body_got, 5);
    CHECK_EQ_INT(c.last_xfer.content_length, 50);
    CHECK(!c.last_xfer.body_complete, "incomplete");
    CHECK(!c.last_xfer.reused && !c.last_xfer.retried, "fresh connection, no retry");
    const char *l = fw_logs();
    CHECK(strstr(l, "fw: dl -1: at read rc=-1 (error), new conn") != NULL, "where it ended is logged");
    CHECK(strstr(l, "fw: status=200 body 5/50 complete=no read=") != NULL, "how far it got is logged");
}

static void test_fetch_firmware_peer_close_mid_body_is_named(void) {
    boot(); fw_got_n = 0; fw_log_reset();
    fake_push_truncated("HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\nHELLO", 44);
    CHECK_EQ_INT(dc_fetch_firmware(&c, "1.1.0+gx", fw_sink, NULL), -1);
    CHECK_EQ_INT(c.last_xfer.stage, DC_XFER_DONE);
    CHECK_EQ_INT(c.last_xfer.body_got, 5);
    CHECK(strstr(fw_logs(), "at end (peer closed), new conn") != NULL, "a clean close mid-body says so");
}

static void test_fetch_firmware_connect_failure_is_named(void) {
    boot(); fw_log_reset();
    fake_push_connect_failure();
    CHECK_EQ_INT(dc_fetch_firmware(&c, "1.1.0+gx", fw_sink, NULL), -1);
    CHECK_EQ_INT(c.last_xfer.stage, DC_XFER_CONNECT);
    CHECK(c.last_xfer.rc < 0, "connect's code is kept");
    CHECK_EQ_INT(c.last_xfer.status, 0);
    CHECK(strstr(fw_logs(), "fw: dl -1: at connect rc=") != NULL, "connect failure logged");
}

static void test_fetch_firmware_dead_kept_connection_retry_is_named(void) {
    boot(); fw_got_n = 0; fw_log_reset();
    // A kept connection the far end has dropped: the first attempt reads
    // nothing, the retry runs on a fresh connection and is cut short too.
    fake_set_reused(true);
    fake_kill_kept_connection();
    fake_push_truncated("HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\nHELLO", 44);
    CHECK_EQ_INT(dc_fetch_firmware(&c, "1.1.0+gx", fw_sink, NULL), -1);
    CHECK(c.last_xfer.retried, "the record says this was the retry");
    CHECK(!c.last_xfer.reused, "and that the retry ran on a fresh connection");
    CHECK(strstr(fw_logs(), "new conn, retried") != NULL, "retry visible in the log");
}

static void test_fetch_firmware_5xx_is_logged_but_200_is_not(void) {
    boot(); fw_got_n = 0; fw_log_reset();
    fake_push_response("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
    CHECK_EQ_INT(dc_fetch_firmware(&c, "1.1.0+gx", fw_sink, NULL), 503);
    CHECK(strstr(fw_logs(), "fw: dl 503: at end (complete)") != NULL, "a 5xx is retried, so it is logged");
    fw_log_reset();
    fake_push_response("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nHELLO");
    CHECK_EQ_INT(dc_fetch_firmware(&c, "1.1.0+gx", fw_sink, NULL), 200);
    CHECK(strstr(fw_logs(), "fw: dl") == NULL, "a good download logs nothing extra");
}

static void test_xfer_describe_names_tls_codes(void) {
    dc_xfer_t x = {0};
    x.stage = DC_XFER_READ; x.rc = TLS_ERR_READ_TIMEOUT; x.reused = true;
    x.status = 200; x.body_got = 123456; x.content_length = 700000; x.bytes_read = 124000; x.ms = 30012;
    char how[72], got[72];
    dc_xfer_describe(&x, how, sizeof how, got, sizeof got);
    CHECK(strcmp(how, "at read rc=-108 (read timeout), kept conn") == 0, how);
    CHECK(strcmp(got, "status=200 body 123456/700000 complete=no read=124000 in 30012 ms") == 0, got);
    CHECK(strcmp(dc_transport_rc_text(TLS_ERR_TLS_CONFIG), "TLS setup failed") == 0, "config");
    CHECK(strcmp(dc_transport_rc_text(-1), "error") == 0, "unknown codes are just errors");
    // Truncated, never overrun, and always terminated.
    char tiny[8];
    dc_xfer_describe(&x, tiny, sizeof tiny, NULL, 0);
    CHECK(strlen(tiny) == sizeof tiny - 1, "truncated to the cap");
}

// --- NFC tap-to-mount (spec 2026-09-25 §4.2, §5.2-5.4) -------------------

#define NFC_ID "0123abcd-4567-5890-a123-456789abcdef"

static bool intr_yes(void *ctx) { (void)ctx; return true; }
static bool intr_no(void *ctx)  { (void)ctx; return false; }

static void poll_carries_nfc_ack(void) {
    boot();
    c.nfc_ack = 5;
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "GET /api/device/poll?since=0&nfcAck=5&displayAck=0 ") != NULL,
          "the board's write cursor rides every poll, or the server can never stop re-sending");
}

// nfcWrite is placed BEFORE `desired` on purpose: the flat scans find the
// first "diskId" in the body, so an nfcWrite that was not lifted out would
// hand its id to the disk logic as the mounted disk's.
static void poll_body_nfc_write_arms(void) {
    boot();
    psram_publish_slot(0);
    strcpy(c.mounted_sha256, "aa"); c.since = 3; c.mounted_version = 3;
    push_ok_json("{\"version\":4,\"nfcWrite\":{\"seq\":6,\"diskId\":\"" NFC_ID "\",\"title\":\"T\"},"
                 "\"desired\":{\"sha256\":\"aa\",\"diskId\":\"d1\",\"gameId\":\"g\","
                 "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK(c.nfc_write_new, "a write request with seq > nfc_ack is new");
    CHECK_EQ_INT(c.nfc_write_seq, 6);
    CHECK(strcmp(c.nfc_write_disk_id, NFC_ID) == 0, "armed with the request's disk");
    CHECK(strcmp(c.nfc_write_title, "T") == 0, "and its title");
    CHECK(strcmp(c.mounted_disk_id, "d1") == 0,
          "the desired disk's id is desired.diskId, never nfcWrite's");
    CHECK_EQ_INT(c.mounted_version, 4);
    CHECK_EQ_INT(c.nfc_ack, 0);   // the caller acks, after acting -- never dc_step
}

static void nfc_write_cancel_disarms(void) {
    boot();
    c.nfc_ack = 6;
    strcpy(c.nfc_write_disk_id, NFC_ID);
    push_ok_json("{\"version\":0,\"desired\":null,\"nfcWrite\":{\"seq\":7,\"diskId\":null,\"title\":null}}");
    dc_step(&c);
    CHECK(c.nfc_write_new, "a disarm is news too -- nfcAck must catch up to it");
    CHECK_EQ_INT(c.nfc_write_seq, 7);
    CHECK(c.nfc_write_disk_id[0] == '\0', "null diskId disarms");
    CHECK(c.nfc_write_title[0] == '\0', "and carries no title");
}

static void nfc_write_stale_seq_ignored(void) {
    boot();
    c.nfc_ack = 7;
    push_ok_json("{\"version\":0,\"desired\":null,\"nfcWrite\":{\"seq\":7,\"diskId\":\"" NFC_ID "\",\"title\":\"T\"}}");
    dc_step(&c);
    CHECK(!c.nfc_write_new, "seq == nfc_ack: already acted on");
    CHECK(c.nfc_write_disk_id[0] == '\0', "and nothing armed from it");
    push_ok_json("{\"version\":0,\"desired\":null,\"nfcWrite\":{\"seq\":2,\"diskId\":\"" NFC_ID "\",\"title\":\"T\"}}");
    dc_step(&c);
    CHECK(!c.nfc_write_new, "seq < nfc_ack: older still");
}

static void nfc_write_bad_id_disarms(void) {
    boot();
    push_ok_json("{\"version\":0,\"desired\":null,\"nfcWrite\":{\"seq\":3,\"diskId\":\"not-a-disk\",\"title\":\"T\"}}");
    dc_step(&c);
    CHECK(c.nfc_write_new, "still new, so the cursor can move past it");
    CHECK(c.nfc_write_disk_id[0] == '\0', "a malformed id is never armed");
    // A valid id with a tail: a fixed-size copy would clip it back to a
    // perfectly valid-looking id. It must be refused whole instead.
    push_ok_json("{\"version\":0,\"desired\":null,\"nfcWrite\":{\"seq\":4,\"diskId\":\"" NFC_ID "ff\",\"title\":\"T\"}}");
    dc_step(&c);
    CHECK_EQ_INT(c.nfc_write_seq, 4);
    CHECK(c.nfc_write_disk_id[0] == '\0', "an over-long id is not clipped into a valid one");
}

static void nfc_write_title_is_clipped(void) {
    boot();
    char body[400], title[DC_TITLE_MAX + 20];
    memset(title, 'x', sizeof title - 1); title[sizeof title - 1] = '\0';
    snprintf(body, sizeof body, "{\"version\":0,\"desired\":null,\"nfcWrite\":"
             "{\"seq\":1,\"diskId\":\"" NFC_ID "\",\"title\":\"%s\"}}", title);
    push_ok_json(body);
    dc_step(&c);
    CHECK_EQ_INT(strlen(c.nfc_write_title), DC_TITLE_MAX);
}

static void poll_interrupted_returns_without_backoff(void) {
    boot();
    c.since = 3; c.backoff_ms = 2000;
    dc_set_poll_interrupt(&c, intr_yes, NULL);
    // A REUSED connection, so the narrow retry's own conditions all hold
    // (reused, not one byte read): only the interrupt keeps it from firing.
    fake_set_reused(true);
    fake_push_held("");
    push_ok_json("{\"version\":9,\"desired\":null}");   // a trap: a retry would take it
    dc_state_t st = dc_step(&c);
    CHECK(c.poll_interrupted, "the step says why it ended");
    CHECK_EQ_INT(st, DC_IDLE_POLL);
    CHECK_EQ_INT(c.state, DC_IDLE_POLL);
    CHECK_EQ_INT(c.backoff_ms, 2000);          // nothing failed: no backoff
    CHECK_EQ_INT(c.since, 3);
    CHECK_EQ_INT(fake_request_count(), 1);     // an interrupt is not a dead socket
    CHECK(fake_abandon_count() >= 1, "the connection is abandoned");
    CHECK(!fake_connection_is_kept(), "the response is still owed on it: never reuse it");
    CHECK(fake_transport()->interrupted == NULL, "the predicate is removed after the poll");

    // The next poll clears the flag and runs normally on a NEW connection.
    dc_state_t st2 = dc_step(&c);
    CHECK(!c.poll_interrupted, "a normal step clears the flag");
    CHECK(!fake_last_reused(), "the abandoned socket is not handed back");
    CHECK_EQ_INT(st2, DC_IDLE_POLL);
    CHECK_EQ_INT(c.since, 9);
}

// Fix round 1 (controller ruling): "state unchanged" includes DC_BACKOFF.
// Here a failed poll has put the client in backoff; main.c sleeps it and
// polls again, and THAT poll is interrupted by a tap. dc_step then returns
// DC_BACKOFF with backoff_ms intact -- which is NOT a result. main.c must
// check c.poll_interrupted FIRST and, when set, skip its
// `else if (polled && s == DC_BACKOFF)` sleep (up to 60 s) and all state
// handling: send the pending tap (dc_tap), then call dc_step again.
static void a_poll_interrupted_after_a_backoff_keeps_the_backoff_but_is_flagged(void) {
    boot();
    fake_push_connect_failure();
    CHECK_EQ_INT(dc_step(&c), DC_BACKOFF);           // the prior failed poll
    uint32_t backoff = c.backoff_ms;
    CHECK(backoff > 0, "precondition: the client is backing off");

    dc_set_poll_interrupt(&c, intr_yes, NULL);
    fake_push_held("");
    push_ok_json("{\"version\":9,\"desired\":null}");  // a trap: a retry would take it
    int abandons_before = fake_abandon_count();
    dc_state_t st = dc_step(&c);
    CHECK(c.poll_interrupted, "flagged -- the one thing main.c must read first");
    CHECK_EQ_INT(st, DC_BACKOFF);                    // unchanged, and NOT a result
    CHECK_EQ_INT(c.backoff_ms, backoff);             // no second backoff step either
    CHECK_EQ_INT(fake_request_count(), 2);           // failed poll + interrupted poll, no retry
    CHECK(fake_abandon_count() > abandons_before, "the interrupted connection is abandoned");
    CHECK(!fake_connection_is_kept(), "and never kept");
}

// tls_read only consults the predicate while nothing is buffered -- so it can
// fire with half a response already read. That socket is out of step too.
static void a_poll_interrupted_mid_response_is_abandoned(void) {
    boot();
    dc_set_poll_interrupt(&c, intr_yes, NULL);
    fake_push_held("HTTP/1.1 200 OK\r\nContent-Length: 40\r\n\r\n{\"ver");
    dc_step(&c);
    CHECK(c.poll_interrupted, "interrupted");
    CHECK(!fake_connection_is_kept(), "never keep a socket mid-response");
    CHECK_EQ_INT(c.backoff_ms, 0);
}

// The predicate is asked, not assumed: one that says no leaves the held poll
// to time out exactly as it always did.
static void a_poll_interrupt_that_says_no_changes_nothing(void) {
    boot();
    dc_set_poll_interrupt(&c, intr_no, NULL);
    fake_push_held("");
    CHECK_EQ_INT(dc_step(&c), DC_BACKOFF);   // a read timeout, as before
    CHECK(!c.poll_interrupted, "a timeout is not an interrupt");
}

// Only the poll: the tap itself must run to completion even while the
// predicate still says "interrupt" (it will, until the tap is sent).
static void the_interrupt_is_installed_for_the_poll_only(void) {
    boot();
    dc_set_poll_interrupt(&c, intr_yes, NULL);
    CHECK(fake_transport()->interrupted == NULL, "not installed outside dc_step");
    fake_push_held("");
    CHECK_EQ_INT(dc_tap(&c, NFC_ID, NULL, 0), DC_TAP_FAILED);   // timed out, not interrupted
    CHECK(!c.poll_interrupted, "a tap is never 'interrupted'");
    push_status_json("HTTP/1.1 200 OK", "{\"outcome\":\"mounting\",\"title\":\"G\"}");
    CHECK_EQ_INT(dc_tap(&c, NFC_ID, NULL, 0), DC_TAP_MOUNTING);
}

static void tap_maps_outcomes(void) {
    static const struct { const char *wire; dc_tap_outcome_t want; } cases[] = {
        { "mounting",  DC_TAP_MOUNTING },  { "already", DC_TAP_ALREADY },
        { "not_found", DC_TAP_NOT_FOUND }, { "too_long", DC_TAP_TOO_LONG },
        { "ignored",   DC_TAP_IGNORED },   { "exploded", DC_TAP_FAILED },
    };
    char title[16], body[96];
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        boot();
        snprintf(body, sizeof body, "{\"outcome\":\"%s\"}", cases[i].wire);
        push_ok_json(body);
        strcpy(title, "stale");
        CHECK_EQ_INT(dc_tap(&c, NFC_ID, title, sizeof title), cases[i].want);
        CHECK(title[0] == '\0', "no title in the answer: none reported, not a stale one");
    }

    boot();
    push_ok_json("{\"outcome\":\"mounting\",\"title\":\"Turrican II - The Final Fight\"}");
    CHECK_EQ_INT(dc_tap(&c, NFC_ID, title, sizeof title), DC_TAP_MOUNTING);
    CHECK(strcmp(title, "Turrican II - T") == 0, "the title is clipped to the caller's buffer");
    const char *q = fake_last_request();
    CHECK(strstr(q, "POST /api/device/tap HTTP/1.1") != NULL, "path");
    CHECK(strstr(q, "Content-Type: application/json") != NULL, "a JSON body");
    CHECK(strstr(q, "\r\n\r\n{\"diskId\":\"" NFC_ID "\"}") != NULL, "exact body");

    boot();
    push_ok_json("<html>garbage</html>");
    CHECK_EQ_INT(dc_tap(&c, NFC_ID, title, sizeof title), DC_TAP_FAILED);

    boot();
    push_status_json("HTTP/1.1 400 Bad Request", "{\"error\":\"invalid_body\"}");
    CHECK_EQ_INT(dc_tap(&c, NFC_ID, title, sizeof title), DC_TAP_FAILED);

    boot();
    push_status_json("HTTP/1.1 500 Internal Server Error", "{\"outcome\":\"mounting\"}");
    CHECK_EQ_INT(dc_tap(&c, NFC_ID, title, sizeof title), DC_TAP_FAILED);

    boot();
    fake_push_connect_failure();
    CHECK_EQ_INT(dc_tap(&c, NFC_ID, title, sizeof title), DC_TAP_FAILED);
    CHECK_EQ_INT(c.backoff_ms, 0);   // a tap never moves the poll's backoff

    boot();
    push_status_json("HTTP/1.1 401 Unauthorized", "{\"error\":\"unauthorized\"}");
    CHECK_EQ_INT(dc_tap(&c, NFC_ID, title, sizeof title), DC_TAP_FAILED);
    CHECK_EQ_INT(c.state, DC_HALTED);
}

static const char *body_of_last_request(void) {
    const char *b = strstr(fake_last_request(), "\r\n\r\n");
    return b ? b + 4 : "";
}

static void tap_write_report_body(void) {
    boot();
    push_ok_json("{\"stored\":true}");
    CHECK(dc_tap_write_report(&c, 7, true, "04a1b2c3d4", "ignored when ok"), "a 200 is heard");
    CHECK(strstr(fake_last_request(), "POST /api/device/tap-write HTTP/1.1") != NULL, "path");
    CHECK(strstr(fake_last_request(), "Content-Type: application/json") != NULL, "JSON");
    CHECK(strcmp(body_of_last_request(), "{\"seq\":7,\"ok\":true,\"uid\":\"04a1b2c3d4\"}") == 0,
          "ok: no reason at all");

    boot();
    push_ok_json("{\"stored\":false}");
    CHECK(dc_tap_write_report(&c, 8, false, "04a1b2c3d4", "read-back \"mismatch\""),
          "stored:false is still heard");
    CHECK(strcmp(body_of_last_request(),
                 "{\"seq\":8,\"ok\":false,\"uid\":\"04a1b2c3d4\",\"reason\":\"read-back \\\"mismatch\\\"\"}") == 0,
          "a failure carries its reason, escaped");

    // The server's own bounds: uid <= 32, reason <= 64. Past them it answers
    // 400 and the report is lost, so they are clipped here instead.
    boot();
    push_ok_json("{\"stored\":true}");
    char uid[50], why[100];
    memset(uid, 'u', sizeof uid - 1); uid[sizeof uid - 1] = '\0';
    memset(why, 'w', sizeof why - 1); why[sizeof why - 1] = '\0';
    CHECK(dc_tap_write_report(&c, 9, false, uid, why), "sent");
    char want[200];
    snprintf(want, sizeof want, "{\"seq\":9,\"ok\":false,\"uid\":\"%.32s\",\"reason\":\"%.64s\"}", uid, why);
    CHECK(strcmp(body_of_last_request(), want) == 0, "clipped to the server's bounds");

    boot();
    fake_push_connect_failure();
    CHECK(!dc_tap_write_report(&c, 9, false, "04", NULL), "offline: not heard");
    boot();
    push_ok_json("{\"stored\":false}");
    CHECK(dc_tap_write_report(&c, 9, false, "04", NULL), "a NULL reason is sent as none");
    CHECK(strcmp(body_of_last_request(), "{\"seq\":9,\"ok\":false,\"uid\":\"04\"}") == 0, "no reason key");
}

static void status_includes_nfc_reader(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.3.0+gt");
    CHECK(strstr(fake_last_request(), "nfcReader") == NULL,
          "never set: the key is omitted, and the server leaves its column alone");

    dc_set_nfc_reader(&c, "present");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.3.0+gt");
    CHECK(strstr(fake_last_request(), ",\"nfcReader\":\"present\"") != NULL, "present");

    dc_set_nfc_reader(&c, "absent");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.3.0+gt");
    CHECK(strstr(fake_last_request(), ",\"nfcReader\":\"absent\"") != NULL,
          "absent is said out loud -- show both values of a state");

    dc_set_nfc_reader(&c, "maybe");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.3.0+gt");
    CHECK(strstr(fake_last_request(), "nfcReader") == NULL, "a word the server would reject is omitted");

    dc_set_nfc_reader(&c, NULL);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.3.0+gt");
    CHECK(strstr(fake_last_request(), "nfcReader") == NULL, "NULL omits");
}

// HD spec §5.5: "playsHd":true only from a build with the drive-ID responder
// (main.c sets it from WF_DRIVE_ID); otherwise no key at all, which the
// server reads as "cannot play HD".
static void test_status_reports_plays_hd_only_when_set(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 4096, -55, NULL, "1.4.0+gabc1234");
    CHECK(strstr(fake_last_request(), "playsHd") == NULL, "not set: no key");

    dc_set_plays_hd(&c, true);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 4096, -55, NULL, "1.4.0+gabc1234");
    CHECK(strstr(fake_last_request(), "\"playsHd\":true") != NULL, "set: says so");
}

static void test_sel1_change_owes_a_report_once(void) {
    boot();
    CHECK(!dc_sel1_owed(&c), "nothing known: nothing owed");
    dc_set_sel1(&c, false, false);
    CHECK(dc_sel1_owed(&c), "the first reading is owed");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(dc_report_status(&c, 0, -50, NULL, "1.7.6"), "sent");
    CHECK(!dc_sel1_owed(&c), "reported: not owed");
    dc_set_sel1(&c, false, false);
    CHECK(!dc_sel1_owed(&c), "same values again: no hot loop of reports");
    dc_set_sel1(&c, true, false);
    CHECK(dc_sel1_owed(&c), "wired false->true owes a report");
    fake_push_response("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    CHECK(!dc_report_status(&c, 0, -50, NULL, "1.7.6"), "failed");
    CHECK(dc_sel1_owed(&c), "a failed report leaves it owed");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(dc_report_status(&c, 0, -50, NULL, "1.7.6"), "sent");
    CHECK(!dc_sel1_owed(&c), "accepted: cleared");
    dc_set_sel1(&c, true, true);
    CHECK(dc_sel1_owed(&c), "df1Seen flipping owes one too");
}

static void test_status_reports_both_sel1_readings_once_known(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(dc_report_status(&c, 0, -50, NULL, "1.7.6"), "sent");
    CHECK(strstr(fake_last_request(), "sel1Wired") == NULL, "not known yet: no key");

    dc_set_sel1(&c, false, false);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(dc_report_status(&c, 0, -50, NULL, "1.7.6"), "sent");
    CHECK(strstr(fake_last_request(), "\"sel1Wired\":false,\"df1Seen\":false") != NULL,
          "both values, false too -- an absent key is not a reading");

    dc_set_sel1(&c, true, true);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(dc_report_status(&c, 0, -50, NULL, "1.7.6"), "sent");
    CHECK(strstr(fake_last_request(), "\"sel1Wired\":true,\"df1Seen\":true") != NULL, "true values");
}

// --- Multi-disk "Next disk" (spec 2026-09-28 §4): next, preload, swap ------
//
// Real 64-hex digests throughout: dc_take_next refuses anything else, and a
// short fixture digest would test the refusal instead of the preload.
static char SHA_A[65], SHA_B[65], SHA_C[65];
#define NEXT_ID2 "22222222-2222-4222-8222-222222222222"
static void init_shas(void) {
    memset(SHA_A, 'a', 64); SHA_A[64] = '\0';
    memset(SHA_B, 'b', 64); SHA_B[64] = '\0';
    memset(SHA_C, 'c', 64); SHA_C[64] = '\0';
}

// A 200 poll naming `desired_sha` as desired. `next_sha`: NULL => "next":null,
// "" => no next key at all, else a next object. `next_first` puts the next
// object BEFORE desired, which is the order the flat scans are most exposed to.
static void push_poll_next(uint32_t version, const char *desired_sha, const char *next_sha,
                           bool next_first) {
    char next[200] = "";
    if (next_sha == NULL) snprintf(next, sizeof next, "\"next\":null,");
    else if (next_sha[0]) snprintf(next, sizeof next,
             "\"next\":{\"diskId\":\"" NEXT_ID2 "\",\"sha256\":\"%s\",\"diskNo\":2},", next_sha);
    char desired[300];
    snprintf(desired, sizeof desired,
             "\"desired\":{\"sha256\":\"%s\",\"diskId\":\"d1\",\"gameId\":\"g\",\"game\":\"G\","
             "\"diskNo\":1,\"diskCount\":3,\"writeProtected\":false}", desired_sha);
    char body[1024];   // next[200] + desired[300] + framing: truncation impossible
    if (next_first) snprintf(body, sizeof body, "{\"version\":%lu,%s%s}", (unsigned long)version, next, desired);
    else {
        // Server order: desired, then next. Drop the trailing comma of `next`.
        size_t n = strlen(next);
        if (n) next[n - 1] = '\0';
        snprintf(body, sizeof body, "{\"version\":%lu,%s%s%s}", (unsigned long)version, desired,
                 n ? "," : "", next);
    }
    push_ok_json(body);
}

static bool gate_yes(void *ctx) { (void)ctx; return true; }
static bool gate_no(void *ctx)  { (void)ctx; return false; }

// A: mounted by a real fetch, with `next` = B named by the same poll.
static void mount_a_with_next_b(void) {
    boot(); init_shas();
    push_poll_next(5, SHA_A, SHA_B, false);
    push_image_response();
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK(strcmp(c.mounted_sha256, SHA_A) == 0, "precondition: A mounted");
}

// ... and then B preloaded into the inactive slot.
static void mount_a_preload_b(void) {
    mount_a_with_next_b();
    dc_set_preload_gate(&c, gate_yes, NULL);
    push_image_response();
    CHECK(dc_preload_step(&c), "precondition: B preloaded");
    CHECK(strcmp(c.preload.sha256, SHA_B) == 0, "precondition: the record says B");
}

// 1. Review Focus 1: next's sha256/diskId must never be read as desired's.
static void next_is_lifted_before_desired_is_read(void) {
    boot(); init_shas();
    push_poll_next(2, SHA_A, SHA_B, /*next_first=*/true);
    push_image_response();
    dc_step(&c);
    char want[128];
    snprintf(want, sizeof want, "GET /api/device/image/%s ", SHA_A);
    CHECK(strstr(fake_last_request(), want) != NULL, "the image fetched is desired's, A");
    CHECK(strstr(fake_last_request(), SHA_B) == NULL, "never next's, B");
    CHECK(strcmp(c.mounted_sha256, SHA_A) == 0, "A is what got mounted");
    CHECK(strcmp(c.mounted_disk_id, "d1") == 0, "and desired's diskId, not next's");
    CHECK(c.preload.known, "a next came with the poll");
    CHECK(strcmp(c.preload.next_sha256, SHA_B) == 0, "and is recorded as next");
    CHECK(strcmp(c.preload.next_disk_id, NEXT_ID2) == 0, "with its disk id");
    CHECK_EQ_INT(c.preload.next_disk_no, 2);
}

// 2.
static void preload_fetches_next_into_inactive_without_publishing(void) {
    mount_a_with_next_b();
    int active = psram_active_slot();
    int inactive = psram_inactive_slot();
    int before = fake_request_count();
    dc_set_preload_gate(&c, gate_yes, NULL);
    push_image_response();
    CHECK(dc_preload_step(&c), "a preload did work");
    CHECK_EQ_INT(fake_request_count(), before + 1);
    char want[128];
    snprintf(want, sizeof want, "GET /api/device/image/%s ", SHA_B);
    CHECK(strstr(fake_last_request(), want) != NULL, "it fetched next, B");
    CHECK_EQ_INT(psram_active_slot(), active);
    CHECK_EQ_INT(c.preload.slot, inactive);
    CHECK(strcmp(c.preload.sha256, SHA_B) == 0, "the record holds B");
    CHECK(!c.preload.loading, "and is no longer loading");
    CHECK(strcmp(c.mounted_sha256, SHA_A) == 0, "A is still the mounted disk");
    CHECK_EQ_INT(c.state, DC_IDLE_POLL);
}

// 3. Review Focus 2.
static void no_preload_while_gate_false(void) {
    mount_a_with_next_b();
    int before = fake_request_count();
    dc_set_preload_gate(&c, gate_no, NULL);
    CHECK(!dc_preload_step(&c), "the gate said no");
    CHECK_EQ_INT(fake_request_count(), before);
    CHECK_EQ_INT(c.preload.slot, SLOT_NONE);
    // No gate at all is a no, too.
    dc_set_preload_gate(&c, NULL, NULL);
    CHECK(!dc_preload_step(&c), "no gate installed: never preload");
    CHECK_EQ_INT(fake_request_count(), before);
}

// 4.
static void no_refetch_when_already_preloaded(void) {
    mount_a_preload_b();
    int before = fake_request_count();
    CHECK(!dc_preload_step(&c), "B is already there");
    CHECK_EQ_INT(fake_request_count(), before);
}

// 5.
static void swap_publishes_preloaded_slot_without_fetching(void) {
    mount_a_preload_b();
    int pre_slot = c.preload.slot;
    int before = fake_request_count();
    push_poll_next(6, SHA_B, SHA_C, false);
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK_EQ_INT(fake_request_count(), before + 1);   // the poll, and nothing else
    CHECK_EQ_INT(psram_active_slot(), pre_slot);
    CHECK(strcmp(c.mounted_sha256, SHA_B) == 0, "B is mounted");
    CHECK_EQ_INT(c.since, 6);
    CHECK_EQ_INT(c.preload.slot, SLOT_NONE);
    CHECK(c.preload.sha256[0] == '\0', "the record is consumed");
    CHECK(strcmp(c.preload.next_sha256, SHA_C) == 0, "and the new next is C");
}

// 6. R2: a preload that is not the desired disk is never published.
static void swap_with_mismatched_preload_fetches(void) {
    mount_a_preload_b();
    int target = psram_inactive_slot();
    push_poll_next(6, SHA_C, SHA_A, false);
    push_image_response();
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    char want[128];
    snprintf(want, sizeof want, "GET /api/device/image/%s ", SHA_C);
    CHECK(strstr(fake_last_request(), want) != NULL, "C is fetched");
    CHECK_EQ_INT(psram_active_slot(), target);
    CHECK(strcmp(c.mounted_sha256, SHA_C) == 0, "C is mounted");
    CHECK_EQ_INT(c.preload.slot, SLOT_NONE);
    CHECK(c.preload.sha256[0] == '\0', "the stale B record is gone");
}

// 7. Review Focus 2: the fetch overwrote the idle slot, so the record lies
// unless it is dropped -- even when the fetch fails part-way.
static void regular_fetch_invalidates_preload(void) {
    mount_a_preload_b();
    push_poll_next(6, SHA_C, "", false);
    fake_push_truncated("HTTP/1.1 200 OK\r\nContent-Length: 2027536\r\n\r\nWFMF", 40);
    dc_step(&c);
    CHECK(strcmp(c.mounted_sha256, SHA_A) == 0, "a failed fetch leaves A mounted");
    CHECK_EQ_INT(c.preload.slot, SLOT_NONE);
    CHECK(c.preload.sha256[0] == '\0', "the slot was overwritten: no B record");
    // And a poll back to B now fetches rather than publishing half-written C.
    push_poll_next(7, SHA_B, "", false);
    push_image_response();
    dc_step(&c);
    char want[128];
    snprintf(want, sizeof want, "GET /api/device/image/%s ", SHA_B);
    CHECK(strstr(fake_last_request(), want) != NULL, "B is fetched again, not swapped in");
}

// 8.
static void next_null_drops_preload(void) {
    mount_a_preload_b();
    push_poll_next(6, SHA_A, NULL, false);
    dc_step(&c);
    CHECK(c.preload.next_sha256[0] == '\0', "no next");
    CHECK_EQ_INT(c.preload.slot, SLOT_NONE);
    CHECK(c.preload.sha256[0] == '\0', "the record is dropped");
    CHECK(!dc_preload_step(&c), "and there is nothing to preload");
}

// 9. Spec §4.2/§4.4: the swap waits behind unsent writes like any swap.
static void held_swap_waits(void) {
    mount_a_preload_b();
    int active = psram_active_slot();
    int pre_slot = c.preload.slot;
    dc_set_hold(&c, hold_true, NULL);
    int before = fake_request_count();
    push_poll_next(6, SHA_B, SHA_C, false);
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK_EQ_INT(fake_request_count(), before + 1);
    CHECK_EQ_INT(psram_active_slot(), active);
    CHECK(strcmp(c.mounted_sha256, SHA_A) == 0, "held: A stays");
    CHECK_EQ_INT(c.preload.slot, pre_slot);
    CHECK(strcmp(c.preload.sha256, SHA_B) == 0, "and the B record is kept for later");
    CHECK(c.held, "the step says it was held, so main.c paces the next poll");

    dc_set_hold(&c, hold_false, NULL);
    push_poll_next(6, SHA_B, SHA_C, false);
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK(!c.held, "released: not held");
    CHECK_EQ_INT(fake_request_count(), before + 2);   // still no image fetch
    CHECK_EQ_INT(psram_active_slot(), pre_slot);
    CHECK(strcmp(c.mounted_sha256, SHA_B) == 0, "hold lifted: B swapped in from the preload");
    CHECK_EQ_INT(c.preload.slot, SLOT_NONE);
}

// 10.
static void tap_next_parses_outcome(void) {
    uint32_t no = 99, count = 99;
    char title[32];

    boot();
    push_ok_json("{\"outcome\":\"mounting\",\"diskNo\":2,\"diskCount\":3,\"title\":\"Monkey Island\"}");
    CHECK_EQ_INT(dc_tap_next(&c, &no, &count, title, sizeof title), DC_TAP_MOUNTING);
    CHECK_EQ_INT(no, 2);
    CHECK_EQ_INT(count, 3);
    CHECK(strcmp(title, "Monkey Island") == 0, "title");
    const char *q = fake_last_request();
    CHECK(strstr(q, "POST /api/device/tap HTTP/1.1") != NULL, "path");
    CHECK(strcmp(body_of_last_request(), "{\"action\":\"next\"}") == 0, "exact body");

    boot();
    push_ok_json("{\"outcome\":\"single\"}");
    no = count = 99; strcpy(title, "stale");
    CHECK_EQ_INT(dc_tap_next(&c, &no, &count, title, sizeof title), DC_TAP_SINGLE);
    CHECK_EQ_INT(no, 0);
    CHECK(title[0] == '\0', "no stale title");

    boot();
    push_ok_json("{\"outcome\":\"nothing_mounted\"}");
    CHECK_EQ_INT(dc_tap_next(&c, &no, &count, title, sizeof title), DC_TAP_NO_DISK);

    boot();
    push_ok_json("{\"outcome\":\"ignored\"}");
    CHECK_EQ_INT(dc_tap_next(&c, NULL, NULL, NULL, 0), DC_TAP_IGNORED);

    boot();
    fake_push_connect_failure();
    CHECK_EQ_INT(dc_tap_next(&c, &no, &count, title, sizeof title), DC_TAP_FAILED);
    CHECK_EQ_INT(c.backoff_ms, 0);
}

// 11.
static void nfc_write_kind_next_arms_next(void) {
    boot();
    push_ok_json("{\"version\":0,\"desired\":null,\"nfcWrite\":{\"seq\":3,\"diskId\":null,"
                 "\"title\":null,\"kind\":\"next\"}}");
    dc_step(&c);
    CHECK(c.nfc_write_new, "new");
    CHECK_EQ_INT(c.nfc_write_seq, 3);
    CHECK(c.nfc_write_next, "kind next arms the Next-disk card");
    CHECK(c.nfc_write_disk_id[0] == '\0', "with no disk id");

    push_ok_json("{\"version\":0,\"desired\":null,\"nfcWrite\":{\"seq\":4,\"diskId\":null,\"title\":null}}");
    dc_step(&c);
    CHECK_EQ_INT(c.nfc_write_seq, 4);
    CHECK(!c.nfc_write_next, "no kind: a disarm, not a Next card");

    push_ok_json("{\"version\":0,\"desired\":null,\"nfcWrite\":{\"seq\":5,\"diskId\":\"" NFC_ID "\",\"title\":\"T\"}}");
    dc_step(&c);
    CHECK(!c.nfc_write_next, "a disk write is not a Next card");
    CHECK(strcmp(c.nfc_write_disk_id, NFC_ID) == 0, "armed with the disk");
}

// 12.
static void status_reports_preload(void) {
    boot(); init_shas();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.6.0+gt");
    CHECK(strstr(fake_last_request(), ",\"preload\":null") != NULL, "none: an explicit null");

    c.preload.slot = 1; strcpy(c.preload.sha256, SHA_B);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.6.0+gt");
    char want[160];
    snprintf(want, sizeof want, ",\"preload\":{\"sha256\":\"%s\",\"state\":\"ready\"}", SHA_B);
    CHECK(strstr(fake_last_request(), want) != NULL, "ready");

    c.preload.slot = SLOT_NONE; c.preload.sha256[0] = '\0';
    c.preload.loading = true; strcpy(c.preload.next_sha256, SHA_C);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.6.0+gt");
    snprintf(want, sizeof want, ",\"preload\":{\"sha256\":\"%s\",\"state\":\"loading\"}", SHA_C);
    CHECK(strstr(fake_last_request(), want) != NULL, "loading");
}

// 13. Final review I1: a tap waiting during a preload cuts the transfer short.
// No record (the slot holds half an image), NO backoff (that would hold the
// tap's own poll), the state as on entry, and the socket never reused.
static void preload_interrupted_by_a_tap_leaves_no_record_and_no_backoff(void) {
    mount_a_with_next_b();
    int active = psram_active_slot();
    dc_set_preload_gate(&c, gate_yes, NULL);
    dc_set_poll_interrupt(&c, intr_yes, NULL);
    CHECK_EQ_INT(c.backoff_ms, 0);
    // Headers and the first bytes of B, then the server goes quiet mid-body:
    // the one place the predicate is asked.
    fake_push_held("HTTP/1.1 200 OK\r\nContent-Length: 2027536\r\n\r\nWFMF");
    int before = fake_request_count();
    CHECK(!dc_preload_step(&c), "interrupted: nothing for the caller to act on");
    CHECK(c.preload.interrupted, "and it says why");
    CHECK_EQ_INT(fake_request_count(), before + 1);   // no retry of an interrupt
    CHECK_EQ_INT(c.preload.slot, SLOT_NONE);
    CHECK(c.preload.sha256[0] == '\0', "no record for a half-written slot");
    CHECK(!c.preload.loading, "no longer loading");
    CHECK(!c.preload.changed, "there was no record to drop: nothing reported moved");
    CHECK_EQ_INT(c.state, DC_IDLE_POLL);
    CHECK_EQ_INT(c.backoff_ms, 0);
    CHECK_EQ_INT(psram_active_slot(), active);
    CHECK(strcmp(c.mounted_sha256, SHA_A) == 0, "A still mounted");
    CHECK(!fake_connection_is_kept(), "the rest of the body is owed on it: never reuse it");
    CHECK(fake_transport()->interrupted == NULL, "the predicate is removed after the preload");

    // The next step describes itself only: the flag clears, and with the tap
    // sent (the predicate now says no) the preload runs to completion.
    dc_set_poll_interrupt(&c, intr_no, NULL);
    push_image_response();
    CHECK(dc_preload_step(&c), "preloaded on a later pass");
    CHECK(!c.preload.interrupted, "cleared on entry");
    CHECK(strcmp(c.preload.sha256, SHA_B) == 0, "B verified");
    CHECK(c.preload.changed, "a new record: a report is owed");
}

// 14. An interrupted preload that replaced a "ready" record: the server was
// told "ready" and must now hear otherwise.
static void preload_interrupted_after_dropping_a_record_marks_it_changed(void) {
    mount_a_preload_b();
    c.preload.changed = false;                         // the caller took it
    snprintf(c.preload.next_sha256, sizeof c.preload.next_sha256, "%s", SHA_C);
    dc_set_poll_interrupt(&c, intr_yes, NULL);
    fake_push_held("");
    CHECK(!dc_preload_step(&c), "interrupted");
    CHECK_EQ_INT(c.preload.slot, SLOT_NONE);
    CHECK(c.preload.sha256[0] == '\0', "the B record is gone with the slot");
    CHECK(c.preload.changed, "and the report owes that");
    CHECK_EQ_INT(c.backoff_ms, 0);
}

// 15. The swap fetch is NOT interruptible: the poll's interrupt is installed
// for the poll (and the preload) only, never the disk someone asked for.
static void the_swap_fetch_is_never_interrupted(void) {
    boot(); init_shas();
    dc_set_poll_interrupt(&c, intr_yes, NULL);
    push_poll_next(5, SHA_A, "", false);
    fake_push_held("HTTP/1.1 200 OK\r\nContent-Length: 2027536\r\n\r\nWFMF");
    CHECK_EQ_INT(dc_step(&c), DC_BACKOFF);            // a read timeout, as before
    CHECK(!c.poll_interrupted, "the fetch ran to its own timeout");
    CHECK(fake_transport()->interrupted == NULL, "never left installed");
}

// 16. Final review I3(a): a body that stops short -- no record, and backoff.
static void preload_incomplete_body_leaves_no_record_and_backs_off(void) {
    mount_a_with_next_b();
    int active = psram_active_slot();
    dc_set_preload_gate(&c, gate_yes, NULL);
    fake_push_truncated("HTTP/1.1 200 OK\r\nContent-Length: 2027536\r\n\r\nWFMF", 40);
    CHECK(dc_preload_step(&c), "a request went out");
    CHECK_EQ_INT(c.state, DC_BACKOFF);
    CHECK(c.backoff_ms > 0, "paced, never a retry storm");
    CHECK_EQ_INT(c.preload.slot, SLOT_NONE);
    CHECK(c.preload.sha256[0] == '\0', "no record");
    CHECK(!c.preload.loading, "no longer loading");
    CHECK(!c.preload.interrupted, "a failure, not an interrupt");
    CHECK(!dc_digest_is_blocked(&c, SHA_B), "a drop says nothing about the digest");
    CHECK_EQ_INT(psram_active_slot(), active);
    CHECK(strcmp(c.mounted_sha256, SHA_A) == 0, "A still mounted");
}

// 17. Final review I3(b) + m4: a forced refetch after a preload -- nothing is
// preloaded meanwhile, and the next poll FETCHES the disk rather than
// publishing the preloaded copy.
static void preload_then_force_refetch_fetches_never_swaps(void) {
    mount_a_preload_b();
    int pre_slot = c.preload.slot;
    dc_force_refetch(&c);
    int before = fake_request_count();
    snprintf(c.preload.next_sha256, sizeof c.preload.next_sha256, "%s", SHA_C);
    CHECK(!dc_preload_step(&c), "m4: no preload while a refetch is pending");
    CHECK_EQ_INT(fake_request_count(), before);
    snprintf(c.preload.next_sha256, sizeof c.preload.next_sha256, "%s", SHA_B);
    CHECK_EQ_INT(c.since, 0);                          // the refetch polls from zero

    push_poll_next(6, SHA_B, SHA_C, false);
    push_image_response();
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK_EQ_INT(fake_request_count(), before + 2);   // the poll AND an image fetch
    char want[128];
    snprintf(want, sizeof want, "GET /api/device/image/%s ", SHA_B);
    CHECK(strstr(fake_last_request(), want) != NULL, "B is fetched afresh");
    CHECK(strcmp(c.mounted_sha256, SHA_B) == 0, "B mounted");
    CHECK_EQ_INT(psram_active_slot(), pre_slot);      // the fetch's target: the same idle slot
    CHECK_EQ_INT(c.preload.slot, SLOT_NONE);
    CHECK(c.preload.sha256[0] == '\0', "the record went with the overwrite");
}

// 18. Final review I3(c): 404 -- the digest is blocked, no record, backoff.
static void preload_404_blocks_the_digest_and_leaves_no_record(void) {
    mount_a_with_next_b();
    dc_set_preload_gate(&c, gate_yes, NULL);
    push_status_json("HTTP/1.1 404 Not Found", "{\"error\":\"not_found\"}");
    CHECK(dc_preload_step(&c), "a request went out");
    CHECK(dc_digest_is_blocked(&c, SHA_B), "404: never retried");
    CHECK_EQ_INT(c.preload.slot, SLOT_NONE);
    CHECK(c.preload.sha256[0] == '\0', "no record");
    CHECK_EQ_INT(c.state, DC_BACKOFF);
    CHECK_EQ_INT(psram_active_slot() != SLOT_NONE, 1);
    CHECK(strcmp(c.mounted_sha256, SHA_A) == 0, "A still mounted");
    // Idle again: a blocked next is not fetched a second time.
    c.state = DC_IDLE_POLL;
    int before = fake_request_count();
    CHECK(!dc_preload_step(&c), "blocked");
    CHECK_EQ_INT(fake_request_count(), before);
}

// 19. Final review m5: the server's digests are lowercase; an uppercase `next`
// is not the server's shape and is never preloaded.
static void an_uppercase_next_is_refused(void) {
    boot(); init_shas();
    char upper[65];
    memset(upper, 'B', 64); upper[64] = '\0';
    push_poll_next(5, SHA_A, upper, false);
    push_image_response();
    dc_step(&c);
    CHECK(c.preload.known, "a next came with the poll");
    CHECK(c.preload.next_sha256[0] == '\0', "but not a digest this board will fetch");
}

// 20. Final review m6: an eject clears next, so nothing of a title no longer
// mounted is preloaded -- held or not.
static void an_eject_clears_next(void) {
    mount_a_with_next_b();
    dc_set_preload_gate(&c, gate_yes, NULL);
    push_ok_json("{\"version\":6,\"desired\":null}");
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK(c.mounted_sha256[0] == '\0', "ejected");
    CHECK(c.preload.next_sha256[0] == '\0', "no next without a mounted title");
    CHECK(c.preload.next_disk_id[0] == '\0', "no next disk id");
    CHECK_EQ_INT(c.preload.next_disk_no, 0);
    int before = fake_request_count();
    CHECK(!dc_preload_step(&c), "nothing to preload");
    CHECK_EQ_INT(fake_request_count(), before);

    // Held: the disk stays, but the server's word is still that nothing is
    // mounted -- next is cleared all the same.
    mount_a_with_next_b();
    dc_set_preload_gate(&c, gate_yes, NULL);
    dc_set_hold(&c, hold_true, NULL);
    push_ok_json("{\"version\":6,\"desired\":null}");
    dc_step(&c);
    CHECK(strcmp(c.mounted_sha256, SHA_A) == 0, "held: A stays");
    CHECK(c.preload.next_sha256[0] == '\0', "but next is gone");
    before = fake_request_count();
    CHECK(!dc_preload_step(&c), "and nothing is preloaded");
    CHECK_EQ_INT(fake_request_count(), before);
    dc_set_hold(&c, NULL, NULL);
}

// --- OLED layouts (spec 2026-10-04 §6): the display cursor and fetch -------

static void test_display_body_parses(void) {
    const uint8_t body[] = { 0, 0, 0, 9,  1,  1,   1, 1, 0, 0 };   // v9, 128x64, has layout, a 4-byte blob
    uint32_t v; uint8_t p; const uint8_t *b; int bl;
    CHECK(dc_display_parse(body, sizeof body, &v, &p, &b, &bl), "parses");
    CHECK(v == 9 && p == 1 && bl == 4 && b == body + 6, "fields");
    const uint8_t dflt[] = { 0, 0, 0, 3, 0, 0 };                     // v3, 128x32, default
    CHECK(dc_display_parse(dflt, sizeof dflt, &v, &p, &b, &bl) && bl == 0, "default has no blob");
    CHECK(!dc_display_parse(body, 5, &v, &p, &b, &bl), "short is refused");
    const uint8_t bad[] = { 0, 0, 0, 9, 1, 1 };                        // claims a layout, carries none
    CHECK(!dc_display_parse(bad, sizeof bad, &v, &p, &b, &bl), "missing blob is refused");
    // Big-endian, all four bytes.
    const uint8_t big[] = { 0x01, 0x02, 0x03, 0x04, 0, 0 };
    CHECK(dc_display_parse(big, sizeof big, &v, &p, &b, &bl) && v == 0x01020304u, "version is big-endian");
    const uint8_t panel2[] = { 0, 0, 0, 9, 2, 0 };
    CHECK(!dc_display_parse(panel2, sizeof panel2, &v, &p, &b, &bl), "an unknown panel is refused");
    const uint8_t flag2[] = { 0, 0, 0, 9, 0, 2, 1 };
    CHECK(!dc_display_parse(flag2, sizeof flag2, &v, &p, &b, &bl), "has_layout other than 0/1 is refused");
    const uint8_t tail[] = { 0, 0, 0, 9, 0, 0, 7 };
    CHECK(!dc_display_parse(tail, sizeof tail, &v, &p, &b, &bl), "a default with trailing bytes is refused");
    static uint8_t huge[6 + LAYOUT_BLOB_MAX + 1];
    memset(huge, 0, sizeof huge); huge[3] = 9; huge[5] = 1;
    CHECK(!dc_display_parse(huge, sizeof huge, &v, &p, &b, &bl), "a blob over LAYOUT_BLOB_MAX is refused");
    CHECK(dc_display_parse(huge, sizeof huge - 1, &v, &p, &b, &bl) && bl == LAYOUT_BLOB_MAX,
          "a blob of exactly LAYOUT_BLOB_MAX is taken");
}

static void test_rejected_layout_still_acks(void) {
    // The cursor rule: a layout the board refuses is still HANDLED, so it never re-wakes the poll.
    device_client_t c; memset(&c, 0, sizeof c);
    c.display_ack = 4; c.display_want = 5;
    CHECK(dc_display_owed(&c), "v5 owed");
    dc_display_handled(&c, 5, "outside the panel");
    CHECK(!dc_display_owed(&c) && c.display_ack == 5, "acked despite the rejection");
    CHECK(strcmp(c.display_error, "outside the panel") == 0, "reason kept for the status");
    dc_display_handled(&c, 6, NULL);
    CHECK(c.display_error[0] == '\0', "an applied layout clears the error");
    // A reason longer than the field is clipped, never overrun.
    static char longwhy[200]; memset(longwhy, 'w', sizeof longwhy - 1); longwhy[sizeof longwhy - 1] = '\0';
    dc_display_handled(&c, 7, longwhy);
    CHECK(strlen(c.display_error) == sizeof c.display_error - 1, "clipped to the field");
}

static void test_poll_url_carries_display_ack(void) {
    boot();
    c.nfc_ack = 5;
    c.display_ack = 12;
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "GET /api/device/poll?since=0&nfcAck=5&displayAck=12 ") != NULL,
          "the display cursor rides every poll, or the server re-wakes it forever");
    // Worst case: every cursor at its maximum still fits the path buffer.
    boot();
    c.since = 4294967295u; c.nfc_ack = 4294967295u; c.display_ack = 4294967295u;
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK(strstr(fake_last_request(),
                 "GET /api/device/poll?since=4294967295&nfcAck=4294967295&displayAck=4294967295 ") != NULL,
          "a maximal poll path is sent whole, not truncated");
}

static void test_poll_url_carries_drive_ack(void) {
    boot(); dc_set_df1(&c, DF1_MODE_OFF, false);
    c.drive_ack = 4294967295u; c.display_ack = 4294967295u; c.nfc_ack = 4294967295u; c.since = 4294967295u;
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "&driveAck=4294967295 ") != NULL, "worst-case path fits");
    // An older build (no dc_set_df1) sends nothing.
    boot(); c.drive_ack = 3;
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_step(&c);
    CHECK(strstr(fake_last_request(), "driveAck") == NULL, "not DF1-capable: no driveAck");
}

// Review Focus 4
static void a_second_drive_object_never_shadows_the_poll_version(void) {
    boot(); dc_set_df1(&c, DF1_MODE_OFF, false);
    push_ok_json("{\"secondDrive\":{\"seq\":9,\"mode\":\"df1\"},\"version\":3,\"desired\":null}");
    dc_step(&c);
    uint32_t seq; df1_mode_t mode;
    CHECK(dc_drive_take(&c, &seq, &mode), "owed");
    CHECK_EQ_INT(seq, 9); CHECK_EQ_INT(mode, DF1_MODE_NEXT);
    CHECK_EQ_INT(c.since, 3);
    CHECK(!dc_drive_take(&c, &seq, &mode), "taken once");
}

static void a_re_paired_board_with_a_higher_ack_takes_the_lower_seq(void) {
    boot(); dc_set_df1(&c, DF1_MODE_NEXT, false); c.drive_ack = 12;
    push_ok_json("{\"secondDrive\":{\"seq\":0,\"mode\":\"off\"},\"version\":1,\"desired\":null}");
    dc_step(&c);
    uint32_t seq; df1_mode_t mode;
    CHECK(dc_drive_take(&c, &seq, &mode), "a mismatch either way is owed");
    CHECK_EQ_INT(seq, 0); CHECK_EQ_INT(mode, DF1_MODE_OFF);
}

static void a_bad_mode_is_handled_as_off_and_still_acked(void) {
    boot(); dc_set_df1(&c, DF1_MODE_NEXT, false);
    push_ok_json("{\"secondDrive\":{\"seq\":4,\"mode\":\"df9\"},\"version\":1,\"desired\":null}");
    dc_step(&c);
    uint32_t seq; df1_mode_t mode;
    CHECK(dc_drive_take(&c, &seq, &mode) && mode == DF1_MODE_OFF, "unknown -> off, never on");
    CHECK_EQ_INT(seq, 4);
}

static void a_matching_second_drive_is_not_owed(void) {
    boot(); dc_set_df1(&c, DF1_MODE_NEXT, false); c.drive_ack = 5;
    push_ok_json("{\"secondDrive\":{\"seq\":5,\"mode\":\"df1\"},\"version\":1,\"desired\":null}");
    dc_step(&c);
    uint32_t seq; df1_mode_t mode;
    CHECK(!dc_drive_take(&c, &seq, &mode), "already acked: nothing owed");
}

static void test_status_reports_second_drive_and_its_ack(void) {
    boot(); dc_set_df1(&c, DF1_MODE_NEXT, false); dc_drive_handled(&c, 7);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.9.0");
    CHECK(strstr(fake_last_request(), "\"secondDrive\":\"df1\",\"driveVersion\":7") != NULL, "both");
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.9.0");
    CHECK(strstr(fake_last_request(), "secondDrive") == NULL, "older build: absent");
}

static void test_a_drive_change_owes_a_status_report(void) {
    boot();
    CHECK(!dc_drive_report_owed(&c), "not capable: nothing owed");
    dc_set_df1(&c, DF1_MODE_OFF, false);
    CHECK(dc_drive_report_owed(&c), "first report owed");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(dc_report_status(&c, 0, -50, NULL, "1.9.0"), "sent");
    CHECK(!dc_drive_report_owed(&c), "reported: not owed");
    dc_set_df1(&c, DF1_MODE_NEXT, false);
    CHECK(dc_drive_report_owed(&c), "mode change owes a report");
    fake_push_response("HTTP/1.1 500 Internal Server Error\r\n\r\n");
    CHECK(!dc_report_status(&c, 0, -50, NULL, "1.9.0"), "failed");
    CHECK(dc_drive_report_owed(&c), "failed report leaves it owed");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(dc_report_status(&c, 0, -50, NULL, "1.9.0"), "sent");
    CHECK(!dc_drive_report_owed(&c), "accepted: cleared");
    dc_drive_handled(&c, 3);
    CHECK(dc_drive_report_owed(&c), "ack change owes a report");
}

static void test_poll_body_reads_display_version(void) {
    boot();
    c.display_ack = 2;
    push_ok_json("{\"version\":1,\"displayVersion\":3,\"desired\":null}");
    dc_step(&c);
    CHECK_EQ_INT((int)c.display_want, 3);
    CHECK(dc_display_owed(&c), "a newer display version is owed");
    // A body without the key leaves the cursor alone.
    push_ok_json("{\"version\":2,\"desired\":null}");
    c.since = 1;
    dc_step(&c);
    CHECK_EQ_INT((int)c.display_want, 3);
    // A non-integer is not read.
    push_ok_json("{\"version\":3,\"displayVersion\":\"9\",\"desired\":null}");
    c.since = 2;
    dc_step(&c);
    CHECK_EQ_INT((int)c.display_want, 3);
}

static void test_status_carries_display_fields(void) {
    boot();
    CHECK(c.display_layouts, "dc_init declares the capability");
    c.display_ack = 7;
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(dc_report_status(&c, 0, -50, NULL, "1.7.0+gt"), "sent");
    const char *q = fake_last_request();
    CHECK(strstr(q, "\"displayLayouts\":true") != NULL, "capability, a JSON boolean");
    CHECK(strstr(q, "\"displayVersion\":7") != NULL, "the ack");
    CHECK(strstr(q, "\"displayError\":null") != NULL, "no error is an explicit null");

    dc_display_handled(&c, 8, "panel: \"x\" \\ bad");
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(dc_report_status(&c, 0, -50, NULL, "1.7.0+gt"), "sent");
    q = fake_last_request();
    CHECK(strstr(q, "\"displayVersion\":8") != NULL, "the ack moved");
    CHECK(strstr(q, "\"displayError\":\"panel: \\\"x\\\" \\\\ bad\"") != NULL, "the reason, JSON-escaped");
}

static uint8_t display_bytes[] = { 0, 0, 0, 9, 1, 1, 1, 1, 0, 0 };

static void test_fetch_display_returns_the_body(void) {
    boot();
    static uint8_t resp[128];
    int h = snprintf((char *)resp, sizeof resp,
                     "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n"
                     "Content-Length: %d\r\n\r\n", (int)sizeof display_bytes);
    memcpy(resp + h, display_bytes, sizeof display_bytes);
    fake_push_response_bytes(resp, h + (int)sizeof display_bytes);
    uint8_t got[16];
    CHECK_EQ_INT(dc_fetch_display(&c, got, sizeof got), (int)sizeof display_bytes);
    CHECK(strstr(fake_last_request(), "GET /api/device/display ") != NULL, "path");
    CHECK(strstr(fake_last_request(), "Authorization: Bearer tok") != NULL, "device-authenticated");
    CHECK(memcmp(got, display_bytes, sizeof display_bytes) == 0, "bytes, NULs and all");

    // A body larger than the buffer keeps only what fits (the parse refuses it).
    fake_push_response_bytes(resp, h + (int)sizeof display_bytes);
    CHECK_EQ_INT(dc_fetch_display(&c, got, 4), 4);
}

static void test_fetch_display_failures(void) {
    boot();
    uint8_t got[16];
    fake_push_truncated("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc", 41);
    CHECK_EQ_INT(dc_fetch_display(&c, got, sizeof got), -1);
    push_status_json("HTTP/1.1 500 Internal Server Error", "{\"error\":\"x\"}");
    CHECK_EQ_INT(dc_fetch_display(&c, got, sizeof got), -1);
    CHECK(c.state != DC_HALTED, "a 5xx does not halt");
    fake_push_response("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
    CHECK_EQ_INT(dc_fetch_display(&c, got, sizeof got), -1);
    CHECK_EQ_INT(c.state, DC_HALTED);
}

// Review fix (Ruling J b): a poll's displayVersion BELOW the ack is a
// server-side reset (a re-paired board's new device row): the cursor starts
// over, and a positive version is fetched once.
static void test_display_version_below_the_ack_resets_the_cursor(void) {
    boot();
    c.display_ack = 9;
    dc_display_handled(&c, 9, "old row's refusal");
    push_ok_json("{\"version\":1,\"displayVersion\":3,\"desired\":null}");
    dc_step(&c);
    CHECK_EQ_INT((int)c.display_ack, 0);
    CHECK(c.display_error[0] == '\0', "the old row's reason goes with its cursor");
    CHECK_EQ_INT((int)c.display_want, 3);
    CHECK(dc_display_owed(&c), "the new row's version 3 is fetched");
    // A reset to 0 (nothing published on the new row) owes nothing.
    boot();
    c.display_ack = 9;
    push_ok_json("{\"version\":1,\"displayVersion\":0,\"desired\":null}");
    dc_step(&c);
    CHECK_EQ_INT((int)c.display_ack, 0);
    CHECK(!dc_display_owed(&c), "version 0: nothing to fetch");
    // Equal to the ack is not a reset.
    boot();
    c.display_ack = 9;
    push_ok_json("{\"version\":1,\"displayVersion\":9,\"desired\":null}");
    dc_step(&c);
    CHECK_EQ_INT((int)c.display_ack, 9);
    CHECK(!dc_display_owed(&c), "already handled");
    CHECK(!dc_display_take_reset_to_default(&c), "not a reset: the glass is left alone");
}

// Final review I1: a reset must take the OLD row's layout off the glass. A
// reset to 0 fetches nothing, so it asks main.c (once) for the default under
// version 0; a reset to a positive version leaves that to the fetch it owes.
static void test_display_reset_to_zero_asks_for_the_default_once(void) {
    boot();
    CHECK(!dc_display_take_reset_to_default(&c), "a fresh client owes no reset");
    c.display_ack = 5;                       // seeded from the old row's record
    push_ok_json("{\"version\":1,\"displayVersion\":0,\"desired\":null}");
    dc_step(&c);
    CHECK(dc_display_take_reset_to_default(&c), "reset to 0: put the default on");
    CHECK(!dc_display_take_reset_to_default(&c), "taken once");
    CHECK_EQ_INT((int)c.display_ack, 0);
    CHECK(!dc_display_owed(&c), "and nothing to fetch");
    // The next body, now matching, raises nothing.
    push_ok_json("{\"version\":1,\"displayVersion\":0,\"desired\":null}");
    dc_step(&c);
    CHECK(!dc_display_take_reset_to_default(&c), "a matching ack is not a reset");

    // A reset to a positive version: the fetch replaces the layout.
    boot();
    c.display_ack = 5;
    push_ok_json("{\"version\":1,\"displayVersion\":2,\"desired\":null}");
    dc_step(&c);
    CHECK(!dc_display_take_reset_to_default(&c), "positive: the fetch replaces it");
    CHECK(dc_display_owed(&c), "version 2 is fetched");

    // A version of 0 with an ack of 0 is not a reset (a fresh board).
    boot();
    push_ok_json("{\"version\":1,\"displayVersion\":0,\"desired\":null}");
    dc_step(&c);
    CHECK(!dc_display_take_reset_to_default(&c), "0 == 0: nothing to reset");
}

// Review fix (Minor 5): every decision display_core1_fetch acts on, pure.
// A valid 128x32 layout blob: format 1, panel 0, one element (status, visible).
static const uint8_t good_blob_32[] = { 1, 0, 1, 0,   1, 1, 0, 0, 0, 0, 0, 0 };

static int disp_body(uint8_t *out, uint32_t v, uint8_t panel, const uint8_t *blob, int bl) {
    out[0] = (uint8_t)(v >> 24); out[1] = (uint8_t)(v >> 16); out[2] = (uint8_t)(v >> 8); out[3] = (uint8_t)v;
    out[4] = panel; out[5] = bl ? 1 : 0;
    if (bl) memcpy(out + 6, blob, (size_t)bl);
    return 6 + bl;
}

static void test_display_decide_branches(void) {
    device_client_t d; memset(&d, 0, sizeof d);
    d.display_ack = 4; d.display_want = 5;
    static dc_display_verdict_t vd;
    uint8_t body[8 + LAYOUT_BLOB_MAX] = {0};   // read-only for n < 0, but GCC cannot know that

    CHECK_EQ_INT(dc_display_decide(&d, body, -1, &vd), DC_DISP_RETRY);      // transport failure

    int n = disp_body(body, 5, 0, NULL, 0);
    CHECK_EQ_INT(dc_display_decide(&d, body, n, &vd), DC_DISP_APPLY);       // the default
    CHECK(vd.version == 5 && vd.panel == 0 && vd.blob_len == 0 && vd.blob == NULL, "default fields");

    n = disp_body(body, 5, 0, good_blob_32, (int)sizeof good_blob_32);
    CHECK_EQ_INT(dc_display_decide(&d, body, n, &vd), DC_DISP_APPLY);       // a custom layout
    CHECK(vd.blob == body + 6 && vd.blob_len == (int)sizeof good_blob_32, "blob points into the body");
    CHECK(vd.layout.panel == PANEL_128x32 && vd.layout.n == 1, "decoded");

    n = disp_body(body, 6, 1, good_blob_32, (int)sizeof good_blob_32);
    CHECK_EQ_INT(dc_display_decide(&d, body, n, &vd), DC_DISP_REJECT);      // blob says 128x32, body 128x64
    CHECK(vd.version == 6 && strcmp(vd.why, "panel mismatch") == 0, "mismatch is refused under its version");

    static const uint8_t bad_blob[] = { 9, 0, 0, 0 };                        // unknown format
    n = disp_body(body, 7, 0, bad_blob, (int)sizeof bad_blob);
    CHECK_EQ_INT(dc_display_decide(&d, body, n, &vd), DC_DISP_REJECT);
    CHECK(vd.version == 7 && strcmp(vd.why, "format: unknown") == 0, "the validator's reason");

    const uint8_t junk[] = { 0, 0, 0, 5, 7 };                                // unparseable
    CHECK_EQ_INT(dc_display_decide(&d, junk, (int)sizeof junk, &vd), DC_DISP_MALFORMED);
    CHECK(vd.version == 5, "a malformed body acks the version the POLL named");
    CHECK(strcmp(vd.why, "malformed display body") == 0, "with a reason");

    n = disp_body(body, 4, 0, NULL, 0);                                     // older than the poll said
    CHECK_EQ_INT(dc_display_decide(&d, body, n, &vd), DC_DISP_RETRY);       // stale: neither applied nor acked

    n = disp_body(body, 8, 0, NULL, 0);                                     // newer than the poll said
    CHECK_EQ_INT(dc_display_decide(&d, body, n, &vd), DC_DISP_APPLY);
    CHECK_EQ_INT((int)vd.version, 8);
}

// --- DF1 second drive (Task 15): DF1 follows the verified preload ----------

static bool quiesce_true(void *ctx) { (void)ctx; psram_df1_reader_ack(psram_df1_token()); return true; }
static bool quiesce_false(void *ctx) { (void)ctx; return false; }

static int df1_req_mark;
static int fake_request_count_since_mark(void) { return fake_request_count() - df1_req_mark; }

// A mounted in slot 0 by a real fetch, B preloaded and verified in slot 1,
// with the request counter marked after.
static void boot_mounted_with_preload_ready(void) {
    mount_a_preload_b();
    CHECK_EQ_INT(psram_active_slot(), 0);
    CHECK_EQ_INT(c.preload.slot, 1);
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NONE);
    df1_req_mark = fake_request_count();
}

// What dc_take_next stores when a poll names `sha` as next.
static void set_next_sha(device_client_t *dc, const char *sha) {
    dc->preload.known = true;
    snprintf(dc->preload.next_sha256, sizeof dc->preload.next_sha256, "%s", sha);
}

// A 200 poll naming `desired` and `next`, delivered through dc_step.
static uint32_t df1_poll_version = 100;
static void deliver_poll_desiring(const char *desired, const char *next) {
    push_poll_next(++df1_poll_version, desired, next, false);
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
}

// The file's image-response helper; the digest names what the test means.
static void fake_push_image_response(const char *sha) { (void)sha; push_image_response(); }

static void df1_serves_the_verified_preload_while_on(void) {
    boot_mounted_with_preload_ready();        // A in slot 0, preload B verified in slot 1
    dc_set_df1(&c, DF1_MODE_NEXT, true);
    dc_df1_reconcile(&c);
    CHECK_EQ_INT(psram_df1_slot(), 1);
    dc_set_df1(&c, DF1_MODE_OFF, true);
    dc_df1_reconcile(&c);
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NONE);   // off: ejected
}

// Review Focus 5
static void an_hd_next_disk_stays_off_a_dd_only_df1(void) {
    boot_mounted_with_preload_ready();
    psram_image_set_slot_kind(1, SLOT_KIND_ADF_HD);
    dc_set_df1(&c, DF1_MODE_NEXT, /*hd_ok=*/false);
    dc_df1_reconcile(&c);
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NONE);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.8.0");
    CHECK(strstr(fake_last_request(), "\"df1Sha256\":null") != NULL, "reported empty");
    // An HD-capable DF1 takes the same disk.
    dc_set_df1(&c, DF1_MODE_NEXT, /*hd_ok=*/true);
    dc_df1_reconcile(&c);
    CHECK_EQ_INT(psram_df1_slot(), 1);
    psram_image_set_slot_kind(1, SLOT_KIND_MFM);
}

// Review Focus 1
static void a_fetch_that_finds_df1_unacknowledged_writes_nothing(void) {
    boot_mounted_with_preload_ready();
    dc_set_df1(&c, DF1_MODE_NEXT, true);
    dc_df1_reconcile(&c);
    dc_set_df1_quiesce(&c, quiesce_false, NULL);
    // the server now names a different next: the preload step would overwrite slot 1
    set_next_sha(&c, SHA_C);                 // what dc_take_next would store
    CHECK(!dc_preload_step(&c), "no work while core0 may still read slot 1");
    CHECK(c.df1_deferred, "a deferred preload says so");
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NONE);  // DF1 was ejected first
    CHECK_EQ_INT(fake_request_count_since_mark(), 0);  // no image request went out
    dc_set_df1_quiesce(&c, quiesce_true, NULL);
    fake_push_image_response(SHA_C);
    CHECK(dc_preload_step(&c), "acknowledged: the preload proceeds");
    CHECK(!c.df1_deferred, "...and is not deferred");
    CHECK(strcmp(c.preload.sha256, SHA_C) == 0, "C verified in the idle slot");
    CHECK_EQ_INT(psram_df1_slot(), 1);       // reconciled: DF1 = C
}

static void next_disk_ejects_df1_and_refills_it_with_the_following_disk(void) {
    boot_mounted_with_preload_ready();      // A in 0, B ready in 1
    dc_set_df1(&c, DF1_MODE_NEXT, true);
    dc_set_df1_quiesce(&c, quiesce_true, NULL);
    dc_df1_reconcile(&c);
    deliver_poll_desiring(SHA_B, /*next=*/SHA_C);
    CHECK_EQ_INT(psram_active_slot(), 1);           // instant swap
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NONE);      // DF1 empty during the fetch (~5 s)
    fake_push_image_response(SHA_C);
    CHECK(dc_preload_step(&c), "C into slot 0");
    dc_df1_reconcile(&c);
    CHECK_EQ_INT(psram_df1_slot(), 0);              // DF1 = C
}

// The regular fetch (desired is a disk that is neither mounted nor preloaded)
// also writes the idle slot: same rule, and the deferred poll is redelivered.
static void a_regular_fetch_waits_for_df1_to_let_go(void) {
    boot_mounted_with_preload_ready();
    dc_set_df1(&c, DF1_MODE_NEXT, true);
    dc_df1_reconcile(&c);
    CHECK_EQ_INT(psram_df1_slot(), 1);
    dc_set_df1_quiesce(&c, quiesce_false, NULL);
    uint32_t since0 = c.since;
    push_poll_next(++df1_poll_version, SHA_C, SHA_B, false);
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK_EQ_INT(fake_request_count_since_mark(), 1);  // the poll, and no image request
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NONE);         // ejected, and not re-inserted
    CHECK_EQ_INT(c.since, since0);                     // redelivered at once
    CHECK(c.df1_deferred, "the deferral is visible, so main.c can pace the redelivery");
    CHECK(strcmp(c.mounted_sha256, SHA_A) == 0, "A still mounted");
    // core0 lets go: the redelivered poll fetches C into slot 1 and swaps.
    dc_set_df1_quiesce(&c, quiesce_true, NULL);
    push_poll_next(df1_poll_version, SHA_C, SHA_B, false);
    fake_push_image_response(SHA_C);
    CHECK_EQ_INT(dc_step(&c), DC_IDLE_POLL);
    CHECK(!c.df1_deferred, "a step that wrote is not deferred");
    CHECK(strcmp(c.mounted_sha256, SHA_C) == 0, "C mounted");
    CHECK_EQ_INT(psram_active_slot(), 1);
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NONE);         // no verified preload yet
}

// A failed write after DF1 was ejected: DF1 stays empty until a preload
// verifies again, then reconcile puts it back.
static void df1_returns_after_a_failed_preload_once_one_verifies(void) {
    boot_mounted_with_preload_ready();
    dc_set_df1(&c, DF1_MODE_NEXT, true);
    dc_set_df1_quiesce(&c, quiesce_true, NULL);
    dc_df1_reconcile(&c);
    set_next_sha(&c, SHA_C);
    fake_push_truncated("HTTP/1.1 200 OK\r\nContent-Length: 2027536\r\n\r\nWFMF", 40);
    CHECK(dc_preload_step(&c), "a request went out and failed");
    CHECK_EQ_INT(psram_df1_slot(), SLOT_NONE);
    CHECK_EQ_INT(c.preload.slot, SLOT_NONE);
    c.state = DC_IDLE_POLL;   // the backoff has elapsed
    fake_push_image_response(SHA_C);
    CHECK(dc_preload_step(&c), "the retry verifies");
    CHECK_EQ_INT(psram_df1_slot(), 1);
}

static void status_names_df1_only_when_capable(void) {
    boot_mounted_with_preload_ready();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.8.0");
    CHECK(strstr(fake_last_request(), "df1Sha256") == NULL, "not DF1-capable: no key");
    dc_set_df1(&c, DF1_MODE_NEXT, true);
    dc_df1_reconcile(&c);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.8.0");
    char want[96];
    snprintf(want, sizeof want, ",\"df1Sha256\":\"%s\"", SHA_B);
    CHECK(strstr(fake_last_request(), want) != NULL, "DF1 holds B");
    dc_set_df1(&c, DF1_MODE_OFF, true);
    dc_df1_reconcile(&c);
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 0, -50, NULL, "1.8.0");
    CHECK(strstr(fake_last_request(), ",\"df1Sha256\":null") != NULL, "off: both values, null");
}

int main(void) {
    // Only test_successful_image_fetch_publishes_and_reflects_write_protected
    // needs real PSRAM backing (everything else in this file either never
    // reaches image_parse_feed, or only pokes psram_publish_slot()'s
    // bookkeeping directly) -- set up once, matching test_psram_image.c's
    // own main().
    size_t psram_len = (size_t)TRACK_MAX_BYTES * NUM_TRACKS * SLOT_COUNT;
    void *psram_mem = malloc(psram_len);
    psram_image_set_backing(psram_mem, psram_len);

    RUN(test_cold_boot_polls_since_zero);
    RUN(test_request_survives_single_byte_writes);
    RUN(test_since_does_not_advance_on_a_failed_fetch);
    RUN(test_current_disk_survives_a_failed_replacement_fetch);
    RUN(test_update_object_does_not_leak_into_disk_fields);
    RUN(test_unchanged_instruction_is_not_new);
    RUN(test_a_cancel_is_new_with_no_offer);
    RUN(test_first_cursor_after_boot_without_update_is_a_sync);
    RUN(test_a_later_cursor_move_without_update_is_a_real_cancel);
    RUN(test_first_cursor_after_boot_with_update_is_a_real_instruction);
    RUN(test_oversized_update_on_first_cursor_is_malformed_not_sync);
    RUN(test_oversized_update_on_a_later_cursor_is_malformed_not_cancel);
    RUN(test_update_null_is_a_cancel_not_malformed);
    RUN(test_a_good_update_clears_malformed);
    RUN(test_poll_404_keeps_the_disk_mounted);
    RUN(test_poll_404_without_device_not_found_marker_is_retryable);
    RUN(test_401_halts);
    RUN(test_204_repolls_with_same_since);
    RUN(test_image_422_does_not_retry_the_digest_but_keeps_polling);
    RUN(test_image_404_behaves_the_same_as_422);
    RUN(test_image_400_is_a_firmware_bug_and_never_retried);
    RUN(test_image_503_is_retried);
    RUN(test_read_timeout_exceeds_the_hold);
    RUN(test_backoff_grows_and_is_capped);
    RUN(test_backoff_resets_after_success);
    RUN(test_jitter_is_added_from_the_clock_not_silently_zero);
    RUN(test_jitter_never_pushes_backoff_past_the_cap);
    RUN(test_status_success_does_not_reset_poll_backoff);
    RUN(test_status_sends_all_seven_fields);
    RUN(test_status_reports_a_null_version_explicitly);
    RUN(test_status_body_fits_at_maximum);
    RUN(test_status_reports_plays_hd_only_when_set);
    RUN(test_status_reports_both_sel1_readings_once_known);
    RUN(test_sel1_change_owes_a_report_once);
    RUN(test_status_carries_the_firmware_fields);
    RUN(test_status_without_a_fw_report_omits_the_fields);
    RUN(test_unmounted_reports_null_not_omitted);
    RUN(test_status_returns_true_on_204);
    RUN(test_status_returns_false_on_connect_failure);
    RUN(test_status_returns_false_on_500);
    RUN(test_corrupt_image_body_blocks_the_digest_but_does_not_publish);
    RUN(test_successful_image_fetch_publishes_and_reflects_write_protected);
    RUN(test_register_body_has_the_three_required_fields);
    RUN(test_register_stores_the_returned_token);
    RUN(test_register_sends_the_protocol_only_when_set);
    RUN(test_bad_code_does_not_store_anything);
    RUN(test_invalid_code_is_reported_as_bad_code_not_retry);
    RUN(test_other_400_is_still_retryable);
    RUN(test_register_backs_off_on_repeated_failure);
    RUN(test_a_blocked_digest_never_repolls_without_a_delay);
    RUN(test_the_fetch_that_blocks_the_digest_also_backs_off);
    RUN(test_a_corrupt_image_body_also_backs_off);
    RUN(test_a_successful_swap_still_clears_the_backoff);
    RUN(test_an_eject_still_clears_the_backoff);
    RUN(test_an_over_long_poll_body_is_refused_not_truncated);

    RUN(hold_keeps_the_disk_through_a_swap);
    RUN(hold_keeps_the_disk_through_an_eject);
    RUN(a_lifted_hold_lets_the_eject_through);
    RUN(force_refetch_fetches_the_digest_already_mounted);
    RUN(adopt_makes_the_next_poll_a_no_op);
    RUN(a_dead_reused_connection_is_retried_once);
    RUN(a_fresh_connection_that_says_nothing_is_not_retried);
    RUN(a_request_the_server_began_answering_is_never_resent);
    RUN(two_dead_connections_in_a_row_stop_at_two_requests);
    RUN(the_retry_lands_on_a_fresh_connection);
    RUN(a_write_failure_on_a_kept_connection_is_retried_once);
    RUN(bytes_that_arrived_without_a_status_line_block_the_retry);
    RUN(a_register_post_is_never_retried);
    RUN(an_abandoned_exchange_never_reuses_the_socket);
    RUN(a_connection_close_response_is_not_kept);
    RUN(a_clean_exchange_hands_its_connection_to_the_next_one);
    RUN(a_close_delimited_response_is_not_kept);
    RUN(an_explicitly_framed_response_is_still_kept);
    RUN(bytes_after_a_complete_response_are_not_kept);
    RUN(a_partial_write_that_then_fails_is_abandoned_and_retried);
    RUN(a_connect_failure_releases_a_held_connection);
    RUN(post_sends_a_binary_body_whole);
    RUN(post_reports_a_dead_link_and_a_dead_token);
    RUN(test_fetch_firmware_streams_the_body);
    RUN(test_fetch_firmware_incomplete_is_minus_one);
    RUN(test_fetch_firmware_401_halts);
    RUN(test_fetch_firmware_read_failure_mid_body_is_named);
    RUN(test_fetch_firmware_peer_close_mid_body_is_named);
    RUN(test_fetch_firmware_connect_failure_is_named);
    RUN(test_fetch_firmware_dead_kept_connection_retry_is_named);
    RUN(test_fetch_firmware_5xx_is_logged_but_200_is_not);
    RUN(test_xfer_describe_names_tls_codes);
    RUN(poll_carries_nfc_ack);
    RUN(poll_body_nfc_write_arms);
    RUN(nfc_write_cancel_disarms);
    RUN(nfc_write_stale_seq_ignored);
    RUN(nfc_write_bad_id_disarms);
    RUN(nfc_write_title_is_clipped);
    RUN(poll_interrupted_returns_without_backoff);
    RUN(a_poll_interrupted_after_a_backoff_keeps_the_backoff_but_is_flagged);
    RUN(a_poll_interrupted_mid_response_is_abandoned);
    RUN(a_poll_interrupt_that_says_no_changes_nothing);
    RUN(the_interrupt_is_installed_for_the_poll_only);
    RUN(tap_maps_outcomes);
    RUN(tap_write_report_body);
    RUN(status_includes_nfc_reader);

    // Multi-disk Next disk. Before the free below: these drive real fetches.
    RUN(next_is_lifted_before_desired_is_read);
    RUN(preload_fetches_next_into_inactive_without_publishing);
    RUN(no_preload_while_gate_false);
    RUN(no_refetch_when_already_preloaded);
    RUN(swap_publishes_preloaded_slot_without_fetching);
    RUN(swap_with_mismatched_preload_fetches);
    RUN(regular_fetch_invalidates_preload);
    RUN(next_null_drops_preload);
    RUN(held_swap_waits);
    RUN(tap_next_parses_outcome);
    RUN(nfc_write_kind_next_arms_next);
    RUN(status_reports_preload);
    RUN(preload_interrupted_by_a_tap_leaves_no_record_and_no_backoff);
    RUN(preload_interrupted_after_dropping_a_record_marks_it_changed);
    RUN(the_swap_fetch_is_never_interrupted);
    RUN(preload_incomplete_body_leaves_no_record_and_backs_off);
    RUN(preload_then_force_refetch_fetches_never_swaps);
    RUN(preload_404_blocks_the_digest_and_leaves_no_record);
    RUN(an_uppercase_next_is_refused);
    RUN(an_eject_clears_next);
    RUN(df1_serves_the_verified_preload_while_on);
    RUN(an_hd_next_disk_stays_off_a_dd_only_df1);
    RUN(a_fetch_that_finds_df1_unacknowledged_writes_nothing);
    RUN(next_disk_ejects_df1_and_refills_it_with_the_following_disk);
    RUN(a_regular_fetch_waits_for_df1_to_let_go);
    RUN(df1_returns_after_a_failed_preload_once_one_verifies);
    RUN(status_names_df1_only_when_capable);
    RUN(test_display_body_parses);
    RUN(test_rejected_layout_still_acks);
    RUN(test_poll_url_carries_display_ack);
    RUN(test_poll_url_carries_drive_ack);
    RUN(a_second_drive_object_never_shadows_the_poll_version);
    RUN(a_re_paired_board_with_a_higher_ack_takes_the_lower_seq);
    RUN(a_bad_mode_is_handled_as_off_and_still_acked);
    RUN(a_matching_second_drive_is_not_owed);
    RUN(test_status_reports_second_drive_and_its_ack);
    RUN(test_a_drive_change_owes_a_status_report);
    RUN(test_poll_body_reads_display_version);
    RUN(test_status_carries_display_fields);
    RUN(test_fetch_display_returns_the_body);
    RUN(test_fetch_display_failures);
    RUN(test_display_version_below_the_ack_resets_the_cursor);
    RUN(test_display_reset_to_zero_asks_for_the_default_once);
    RUN(test_display_decide_branches);

    // The observation tests run BEFORE the backing is released: several of
    // them drive a real fetch, which writes into PSRAM. Appending them after
    // free(psram_mem) -- which is where they first landed -- is a
    // heap-use-after-free that macOS tolerated silently and Linux turned into
    // a segfault on the first CI run.
    RUN(test_the_disk_title_is_read_from_the_poll_body);
    RUN(test_an_eject_clears_the_title);
    RUN(test_an_already_mounted_disk_is_still_named);
    RUN(test_a_missing_title_never_stops_a_mount);
    RUN(test_a_stale_title_cannot_survive_into_a_different_disk);
    RUN(test_progress_is_reported_once_per_percent);
    RUN(test_an_absent_observer_changes_nothing);

    // Last, so nothing below can touch it. Anything added after this line and
    // reaching image_parse_feed() writes to freed memory.
    free(psram_mem);
    return REPORT();
}
