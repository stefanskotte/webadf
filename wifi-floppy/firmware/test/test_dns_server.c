#include "harness.h"
#include "../src/dns_server.h"
#include <string.h>

// A minimal DNS query for "captive.apple.com" type A, class IN.
static int build_query(uint8_t *b, int cap) {
    static const uint8_t q[] = {
        0x12, 0x34,             // id
        0x01, 0x00,             // flags: standard query, RD
        0x00, 0x01,             // qdcount 1
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        7, 'c','a','p','t','i','v','e',
        5, 'a','p','p','l','e',
        3, 'c','o','m',
        0,
        0x00, 0x01,             // qtype A
        0x00, 0x01,             // qclass IN
    };
    if (cap < (int)sizeof q) return 0;
    memcpy(b, q, sizeof q);
    return (int)sizeof q;
}

static void test_answers_an_a_query_with_the_portal_ip(void) {
    uint8_t req[128], out[256];
    int n = build_query(req, sizeof req);
    int r = dns_handle(req, n, out, sizeof out);
    CHECK(r > n, "a reply carries the question plus an answer");
    CHECK_EQ_INT(out[0], 0x12); CHECK_EQ_INT(out[1], 0x34);   // id echoed
    CHECK_EQ_INT(out[2] & 0x80, 0x80);                        // QR = response
    CHECK_EQ_INT(out[7], 1);                                  // ancount 1
    // The A record's four address bytes are the last four of the reply.
    CHECK_EQ_INT(out[r - 4], PORTAL_IP_0);
    CHECK_EQ_INT(out[r - 3], PORTAL_IP_1);
    CHECK_EQ_INT(out[r - 2], PORTAL_IP_2);
    CHECK_EQ_INT(out[r - 1], PORTAL_IP_3);
}

static void test_truncated_query_is_ignored(void) {
    uint8_t req[128], out[256];
    int n = build_query(req, sizeof req);
    CHECK_EQ_INT(dns_handle(req, 4, out, sizeof out), 0);       // header cut short
    CHECK_EQ_INT(dns_handle(req, n - 3, out, sizeof out), 0);   // question cut short
}

static void test_response_packet_is_ignored(void) {
    // Never answer something that is itself an answer -- that is how two
    // servers on one segment end up talking to each other forever.
    uint8_t req[128], out[256];
    int n = build_query(req, sizeof req);
    req[2] |= 0x80;                                            // set QR
    CHECK_EQ_INT(dns_handle(req, n, out, sizeof out), 0);
}

static void test_no_question_section_is_ignored(void) {
    uint8_t req[128], out[256];
    int n = build_query(req, sizeof req);
    req[4] = 0; req[5] = 0;                                    // qdcount 0
    CHECK_EQ_INT(dns_handle(req, n, out, sizeof out), 0);
}

static void test_reply_that_would_not_fit_is_refused(void) {
    uint8_t req[128], out[16];
    int n = build_query(req, sizeof req);
    CHECK_EQ_INT(dns_handle(req, n, out, sizeof out), 0);
}

// --- Edge cases the brief's tests don't cover ---

// A label length byte that points past the end of the buffer entirely (not
// just past the remaining question bytes within a well-formed packet) --
// the length check must bound against the actual input length before ever
// touching the label bytes it claims to cover.
static void test_label_length_runs_past_end_of_buffer(void) {
    uint8_t req[64], out[256];
    memset(req, 0, sizeof req);
    req[0] = 0x12; req[1] = 0x34;
    req[2] = 0x01; req[3] = 0x00;
    req[4] = 0x00; req[5] = 0x01;  // qdcount 1
    // Question starts at offset 12: a label claiming length 60, but only a
    // few bytes actually follow before the buffer (and `len`) end.
    req[12] = 60;
    req[13] = 'a'; req[14] = 'b'; req[15] = 'c';
    int n = 16;
    CHECK_EQ_INT(dns_handle(req, n, out, sizeof out), 0);
}

// A compression pointer (top two bits of the length byte set) inside the
// question name must not be treated as a plain label length -- 0xC0 is 192,
// which is not "past the remaining input" in a large buffer, so a naive
// length check alone would walk off into unrelated bytes instead of
// recognizing this shape as unsupported and refusing to answer.
static void test_compression_pointer_in_question_is_refused(void) {
    uint8_t req[64], out[256];
    memset(req, 0, sizeof req);
    req[0] = 0x12; req[1] = 0x34;
    req[2] = 0x01; req[3] = 0x00;
    req[4] = 0x00; req[5] = 0x01;  // qdcount 1
    req[12] = 0xC0; req[13] = 0x00;  // compression pointer, not a label
    req[14] = 0x00; req[15] = 0x01;  // qtype A
    req[16] = 0x00; req[17] = 0x01;  // qclass IN
    CHECK_EQ_INT(dns_handle(req, 18, out, sizeof out), 0);
}

int main(void) {
    RUN(test_answers_an_a_query_with_the_portal_ip);
    RUN(test_truncated_query_is_ignored);
    RUN(test_response_packet_is_ignored);
    RUN(test_no_question_section_is_ignored);
    RUN(test_reply_that_would_not_fit_is_refused);
    RUN(test_label_length_runs_past_end_of_buffer);
    RUN(test_compression_pointer_in_question_is_refused);
    return REPORT();
}
