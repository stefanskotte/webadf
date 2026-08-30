#include "harness.h"
#include "transport_fake.h"
#include "../src/device_client.h"
#include <string.h>

static device_client_t c;
static void boot(void) {
    fake_reset(); fake_set_clock(0);
    dc_init(&c, fake_transport(), fake_clock_ms, "webadf.vercel.app", "tok");
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

static void poll_then_image(const char *image_response) {
    fake_push_response("HTTP/1.1 200 OK\r\nContent-Length: 125\r\n\r\n"
        "{\"version\":7,\"desired\":{\"sha256\":\"aa\",\"diskId\":\"d1\",\"gameId\":\"g\","
        "\"game\":\"G\",\"diskNo\":1,\"diskCount\":1,\"writeProtected\":false}}");
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

static void test_status_sends_all_six_fields(void) {
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 4096, -55, NULL);
    const char *r = fake_last_request();
    CHECK(strstr(r, "mountedSha256") != NULL, "mountedSha256");
    CHECK(strstr(r, "mountedDiskId") != NULL, "mountedDiskId");
    CHECK(strstr(r, "\"version\"")   != NULL, "version");
    CHECK(strstr(r, "\"error\"")     != NULL, "error");
    CHECK(strstr(r, "psramFree")     != NULL, "psramFree");
    CHECK(strstr(r, "\"rssi\"")      != NULL, "rssi");
}

static void test_unmounted_reports_null_not_omitted(void) {
    // null means "I hold no disk" -- an honest report. Omitting the key means
    // "no opinion" and leaves the server's column stale.
    boot();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    dc_report_status(&c, 4096, -55, NULL);
    CHECK(strstr(fake_last_request(), "\"mountedSha256\":null") != NULL,
          "an unmounted device must report null explicitly");
}

int main(void) {
    RUN(test_cold_boot_polls_since_zero);
    RUN(test_request_survives_single_byte_writes);
    RUN(test_since_does_not_advance_on_a_failed_fetch);
    RUN(test_poll_404_keeps_the_disk_mounted);
    RUN(test_401_halts);
    RUN(test_204_repolls_with_same_since);
    RUN(test_image_422_does_not_retry_the_digest_but_keeps_polling);
    RUN(test_image_404_behaves_the_same_as_422);
    RUN(test_image_400_is_a_firmware_bug_and_never_retried);
    RUN(test_image_503_is_retried);
    RUN(test_read_timeout_exceeds_the_hold);
    RUN(test_backoff_grows_and_is_capped);
    RUN(test_backoff_resets_after_success);
    RUN(test_status_sends_all_six_fields);
    RUN(test_unmounted_reports_null_not_omitted);
    return REPORT();
}
