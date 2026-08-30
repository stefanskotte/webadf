#include "harness.h"
#include "transport_fake.h"
#include <string.h>

static void test_truncation_reports_close(void) {
    fake_reset();
    fake_push_truncated("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n0123456789", 20);
    transport_t *t = fake_transport();
    CHECK_EQ_INT(t->connect(t, "h", 443), 0);
    uint8_t b[64];
    int n = t->read(t, b, sizeof b, 1000);
    CHECK_EQ_INT(n, 20);
    CHECK_EQ_INT(t->read(t, b, sizeof b, 1000), 0);  // clean close, mid-body
}

static void test_connect_failure_is_negative(void) {
    fake_reset();
    fake_push_connect_failure();
    transport_t *t = fake_transport();
    CHECK(t->connect(t, "h", 443) < 0, "connect should fail");
}

static void test_records_request(void) {
    fake_reset();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    transport_t *t = fake_transport();
    t->connect(t, "h", 443);
    t->write(t, (const uint8_t *)"GET /x\r\n", 8);
    CHECK(strstr(fake_last_request(), "GET /x") != NULL, "request recorded");
    CHECK_EQ_INT(fake_request_count(), 1);
}

static void test_request_count_tracks_connects_not_writes(void) {
    // Finding 1 (review round 1): fake_request_count() must count completed
    // connect() cycles, not write() calls -- a client that splits one
    // request across two writes (e.g. a header write then a body write for
    // a POST) must still register as a single request.
    fake_reset();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    transport_t *t = fake_transport();
    t->connect(t, "h", 443);
    t->write(t, (const uint8_t *)"GET ", 4);
    t->write(t, (const uint8_t *)"/x\r\n", 4);
    CHECK(strstr(fake_last_request(), "GET /x") != NULL,
          "both writes reassemble into the recorded request");
    CHECK_EQ_INT(fake_request_count(), 1);
}

static void test_write_cap_forces_partial_writes(void) {
    // Finding 2 (review round 1): a real socket (and mbedTLS over lwIP) can
    // accept fewer bytes than offered under backpressure. fake_set_max_write
    // must reproduce that so a client that doesn't loop on a short write
    // fails here, on the host, instead of only on hardware.
    fake_reset();
    fake_push_response("HTTP/1.1 204 No Content\r\n\r\n");
    transport_t *t = fake_transport();
    CHECK_EQ_INT(t->connect(t, "h", 443), 0);
    fake_set_max_write(3);

    const char *req = "GET /x\r\n";
    int total = (int)strlen(req);
    int n = t->write(t, (const uint8_t *)req, total);
    CHECK(n > 0 && n < total, "a capped write must return less than offered");

    int sent = n;
    while (sent < total) {
        n = t->write(t, (const uint8_t *)req + sent, total - sent);
        CHECK(n > 0, "capped write should keep making forward progress");
        sent += n;
    }
    CHECK_EQ_INT(sent, total);
    CHECK(strcmp(fake_last_request(), req) == 0,
          "repeated partial writes reassemble the whole request");
}

int main(void) {
    RUN(test_truncation_reports_close); RUN(test_connect_failure_is_negative);
    RUN(test_records_request);
    RUN(test_request_count_tracks_connects_not_writes);
    RUN(test_write_cap_forces_partial_writes);
    return REPORT();
}
