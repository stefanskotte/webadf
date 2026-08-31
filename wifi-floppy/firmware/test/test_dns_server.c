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

// --- Final review, Minor 5: qtype is honoured -------------------------

// Same name, qtype AAAA (28). iOS and Android both send this alongside the
// A query for their captive-portal check hostnames. This responder used to
// answer it with a TYPE A record -- an answer whose RR type does not match
// the question, which a resolver is entitled to treat as a broken server
// rather than as "there is no AAAA record here".
static int build_query_qtype(uint8_t *b, int cap, uint8_t qtype_hi,
                              uint8_t qtype_lo) {
    int n = build_query(b, cap);
    if (n == 0) return 0;
    // The qtype is the second-to-last field: QTYPE(2) + QCLASS(2) close the
    // question, so it starts 4 bytes back from the end of what was built.
    b[n - 4] = qtype_hi;
    b[n - 3] = qtype_lo;
    return n;
}

static void test_aaaa_query_is_not_answered_with_an_a_record(void) {
    uint8_t req[128], out[256];
    int n = build_query_qtype(req, sizeof req, 0x00, 0x1C);   // qtype AAAA
    int r = dns_handle(req, n, out, sizeof out);
    // Answered, but empty: header + question echoed, nothing after it.
    CHECK_EQ_INT(r, n);
    CHECK_EQ_INT(out[2] & 0x80, 0x80);            // QR = response
    CHECK_EQ_INT(out[3] & 0x0F, 0x00);            // RCODE = NOERROR
    CHECK_EQ_INT(out[6], 0); CHECK_EQ_INT(out[7], 0);   // ANCOUNT 0
    CHECK_EQ_INT(out[0], 0x12); CHECK_EQ_INT(out[1], 0x34);  // id echoed
    // The question is echoed back verbatim, qtype included -- so the reply
    // answers the question that was actually asked.
    CHECK(memcmp(out + 12, req + 12, (size_t)(n - 12)) == 0,
          "question section echoed unchanged");
}

// An empty NOERROR is deliberate rather than silence: a dropped query
// costs the client its whole retry timer before it falls back to the A
// query the portal depends on.
static void test_a_query_still_gets_the_portal_ip_after_the_qtype_check(void) {
    uint8_t req[128], out[256];
    int n = build_query_qtype(req, sizeof req, 0x00, 0x01);   // qtype A
    int r = dns_handle(req, n, out, sizeof out);
    CHECK_EQ_INT(r, n + 16);                       // question + one A record
    CHECK_EQ_INT(out[7], 1);                       // ANCOUNT 1
    CHECK_EQ_INT(out[r - 4], PORTAL_IP_0);
    CHECK_EQ_INT(out[r - 1], PORTAL_IP_3);
}

// Any other type gets the same empty answer -- the check is on A, not on a
// list of types someone remembered to enumerate.
static void test_other_qtypes_get_an_empty_answer_too(void) {
    uint8_t req[128], out[256];
    const uint8_t types[] = { 0x02 /* NS */, 0x0F /* MX */, 0x10 /* TXT */,
                              0x21 /* SRV */, 0xFF /* ANY */ };
    for (unsigned i = 0; i < sizeof types / sizeof types[0]; i++) {
        int n = build_query_qtype(req, sizeof req, 0x00, types[i]);
        int r = dns_handle(req, n, out, sizeof out);
        CHECK_EQ_INT(r, n);
        CHECK_EQ_INT(out[7], 0);
    }
}

int main(void) {
    RUN(test_answers_an_a_query_with_the_portal_ip);
    RUN(test_truncated_query_is_ignored);
    RUN(test_response_packet_is_ignored);
    RUN(test_no_question_section_is_ignored);
    RUN(test_reply_that_would_not_fit_is_refused);
    RUN(test_label_length_runs_past_end_of_buffer);
    RUN(test_compression_pointer_in_question_is_refused);
    RUN(test_aaaa_query_is_not_answered_with_an_a_record);
    RUN(test_a_query_still_gets_the_portal_ip_after_the_qtype_check);
    RUN(test_other_qtypes_get_an_empty_answer_too);
    return REPORT();
}
