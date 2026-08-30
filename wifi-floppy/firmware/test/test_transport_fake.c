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

int main(void) {
    RUN(test_truncation_reports_close); RUN(test_connect_failure_is_negative);
    RUN(test_records_request);
    return REPORT();
}
