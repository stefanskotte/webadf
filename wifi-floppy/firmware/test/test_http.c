#include "harness.h"
#include "../src/http.h"
#include <string.h>

static uint8_t body[4096];
static int body_len;
static void sink(void *ctx, const uint8_t *b, int n) {
    (void)ctx; memcpy(body + body_len, b, n); body_len += n;
}
#define FEED(r, s) http_resp_feed((r), (const uint8_t *)(s), (int)strlen(s), sink, NULL)

static void test_content_length_body(void) {
    http_resp_t r; http_resp_init(&r); body_len = 0;
    CHECK(FEED(&r, "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello"), "should parse");
    CHECK_EQ_INT(r.status, 200);
    CHECK(r.body_complete, "body should be complete at content-length");
    CHECK_EQ_INT(body_len, 5);
    CHECK(memcmp(body, "hello", 5) == 0, "body bytes");
}

static void test_chunked_body(void) {
    http_resp_t r; http_resp_init(&r); body_len = 0;
    CHECK(FEED(&r, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
                   "5\r\nhello\r\n3\r\n123\r\n0\r\n\r\n"), "should parse");
    CHECK_EQ_INT(body_len, 8);
    CHECK(r.body_complete, "zero chunk terminates the body");
}

static void test_split_across_feeds(void) {
    // The real transport delivers arbitrary fragments; a status line split
    // mid-token must not lose the status.
    http_resp_t r; http_resp_init(&r); body_len = 0;
    FEED(&r, "HTTP/1.1 20");
    FEED(&r, "4 No Content\r\n\r\n");
    CHECK_EQ_INT(r.status, 204);
}

static void test_204_has_no_body(void) {
    http_resp_t r; http_resp_init(&r); body_len = 0;
    FEED(&r, "HTTP/1.1 204 No Content\r\n\r\n");
    CHECK(r.body_complete, "204 is complete with no body");
    CHECK_EQ_INT(body_len, 0);
}

static void test_request_includes_bearer(void) {
    char out[512];
    int n = http_build_request(out, sizeof out, "GET", "/api/device/poll?since=0",
                               "webadf.vercel.app", "tok123", NULL);
    CHECK(n > 0, "should build");
    CHECK(strstr(out, "Authorization: Bearer tok123\r\n") != NULL, "bearer header");
    CHECK(strstr(out, "Host: webadf.vercel.app\r\n") != NULL, "host header");
}

static void test_request_refuses_overflow(void) {
    char out[32];
    CHECK_EQ_INT(http_build_request(out, sizeof out, "GET", "/very/long/path",
                                    "webadf.vercel.app", "tok", NULL), -1);
}

// --- Edge cases the brief's tests don't cover ---

// Live probe (webadf.vercel.app) returns headers with mixed case
// ("Transfer-Encoding", not "transfer-encoding"); the parser must not
// silently miss framing because of case.
static void test_header_names_case_insensitive(void) {
    http_resp_t r; http_resp_init(&r); body_len = 0;
    CHECK(FEED(&r, "HTTP/1.1 200 OK\r\nCONTENT-LENGTH: 5\r\n\r\nhello"), "should parse");
    CHECK(r.body_complete, "mixed-case Content-Length still frames the body");
    CHECK_EQ_INT(body_len, 5);
}

static void test_304_has_no_body(void) {
    http_resp_t r; http_resp_init(&r); body_len = 0;
    FEED(&r, "HTTP/1.1 304 Not Modified\r\nContent-Length: 100\r\n\r\n");
    CHECK(r.body_complete, "304 completes with no body even though "
                            "Content-Length claims one");
    CHECK_EQ_INT(body_len, 0);
}

// A feed boundary can land anywhere, including inside a header name and
// between the \r and \n of any terminator -- not just inside the status
// line's number, which is the only split the brief's own test exercises.
static void test_split_inside_header_name_and_terminators(void) {
    http_resp_t r; http_resp_init(&r); body_len = 0;
    CHECK(FEED(&r, "HTTP/1.1 200 OK\r"), "first fragment ends mid-terminator");
    CHECK(FEED(&r, "\nConten"), "second fragment splits inside a header name");
    CHECK(FEED(&r, "t-Length: 5\r"), "third fragment ends right before \\n");
    CHECK(FEED(&r, "\n\r"), "fourth fragment: blank-line terminator's \\r only");
    CHECK(FEED(&r, "\nhel"), "fifth fragment: \\n then a partial body");
    CHECK(FEED(&r, "lo"), "sixth fragment completes the body");
    CHECK_EQ_INT(r.status, 200);
    CHECK(r.body_complete, "body complete after all fragments delivered");
    CHECK_EQ_INT(body_len, 5);
    CHECK(memcmp(body, "hello", 5) == 0, "body bytes reassembled across splits");
}

// A chunk-size line (hex digits, not decimal) split mid-number, plus a chunk
// boundary split right at the terminating CRLF -- neither is the same code
// path as the status-line split the brief's test covers.
static void test_chunked_split_inside_size_line_and_boundary(void) {
    http_resp_t r; http_resp_init(&r); body_len = 0;
    CHECK(FEED(&r, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"),
          "headers parse");
    // Chunk size 0x10 (16) split before its second hex digit.
    CHECK(FEED(&r, "1"), "chunk-size line split before its second hex digit");
    CHECK(FEED(&r, "0\r\n0123456789012345"), "rest of size line plus full chunk data");
    CHECK(FEED(&r, "\r"), "chunk terminator split: \\r only");
    CHECK(FEED(&r, "\n0\r\n\r\n"), "\\n, then the terminating zero chunk");
    CHECK_EQ_INT(body_len, 16);
    CHECK(memcmp(body, "0123456789012345", 16) == 0, "chunk body bytes");
    CHECK(r.body_complete, "zero chunk terminates the body");
}

// Multiple small chunks, each split across its own feed boundary -- the
// case the real transport (arbitrary TCP/TLS record fragments) produces
// constantly, unlike the brief's single-feed chunked test.
static void test_chunked_multiple_chunks_byte_at_a_time(void) {
    http_resp_t r; http_resp_init(&r); body_len = 0;
    const char *msg = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"
                       "3\r\nfoo\r\n3\r\nbar\r\n0\r\n\r\n";
    for (size_t i = 0; i < strlen(msg); i++) {
        CHECK(http_resp_feed(&r, (const uint8_t *)&msg[i], 1, sink, NULL),
              "byte-at-a-time feed should parse");
    }
    CHECK_EQ_INT(body_len, 6);
    CHECK(memcmp(body, "foobar", 6) == 0, "chunk bytes concatenated in order");
    CHECK(r.body_complete, "zero chunk terminates the body");
}

// No Content-Length and no Transfer-Encoding at all: the response can't be
// framed further, so it must be treated as complete right after headers
// rather than hanging forever waiting for a body that will never be
// delimited.
static void test_no_framing_header_completes_after_headers(void) {
    http_resp_t r; http_resp_init(&r); body_len = 0;
    FEED(&r, "HTTP/1.1 200 OK\r\n\r\n");
    CHECK(r.headers_done, "headers parsed");
    CHECK(r.body_complete, "no framing header means no further body to wait for");
    CHECK_EQ_INT(body_len, 0);
}

// --- Code review round 1: integer-overflow regressions ---

// A Content-Length that wraps `long` negative must not be treated as a
// small-or-zero body and reported complete. This is the reviewer's exact
// repro: 18446744073709551611 wraps signed 64-bit `long` to -5, and the old
// start_body_phase() fell through its `else` (neither == 0 nor > 0) straight
// to body_complete = true with nothing read.
static void test_content_length_overflow_rejected(void) {
    http_resp_t r; http_resp_init(&r); body_len = 0;
    bool ok = FEED(&r, "HTTP/1.1 200 OK\r\nContent-Length: 18446744073709551611"
                       "\r\n\r\nhelloworldXXXXXXXXXX");
    CHECK(!ok, "an overflowing Content-Length must be refused, not accepted");
    CHECK(!r.body_complete, "must not report a truncated body as complete");
    CHECK_EQ_INT(body_len, 0);

    // Also cover the sanity ceiling on its own: a value that is merely
    // absurd (far beyond anything this device ever legitimately fetches),
    // with no `long` wraparound involved, must be refused too -- not
    // accepted just because the arithmetic happened not to overflow.
    http_resp_t r2; http_resp_init(&r2); body_len = 0;
    bool ok2 = FEED(&r2, "HTTP/1.1 200 OK\r\nContent-Length: 999999999\r\n\r\n");
    CHECK(!ok2, "a Content-Length far beyond any legitimate body must be refused");
    CHECK(!r2.body_complete, "must not report completion for a rejected response");
}

// A chunk-size line whose hex value overflows must be rejected outright,
// the same way a bad hex digit already was -- not silently truncated to a
// small `int` (`ffffffffffffffff` wraps to -1 as a 64-bit `long`, and the
// old code's unguarded `size = size * 16 + d` produced exactly that), which
// would otherwise leave ST_CHUNK_DATA computing `int want = -1` and never
// advancing: every future feed keeps returning true while discarding all
// input, forever.
static void test_chunk_size_overflow_rejected(void) {
    http_resp_t r; http_resp_init(&r); body_len = 0;
    CHECK(FEED(&r, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n"),
          "headers parse");
    bool ok = FEED(&r, "ffffffffffffffff\r\nhello");
    CHECK(!ok, "an overflowing chunk size must be refused, not silently stalled");
    CHECK(!r.body_complete, "must not report completion for a rejected response");
    CHECK_EQ_INT(body_len, 0);
}

// Minor: an overlong trailer line (after the terminating zero chunk) must
// not grow `_linelen` without bound. It never indexes the line buffer in
// this state, so the old code could not corrupt memory, but an unbounded
// signed-int counter is still a latent overflow (undefined behaviour once
// it wraps) for no reason -- it only ever needs to tell "was this line
// blank" apart from "was there anything on it", so it should cap at the
// line buffer's own size like every other line-accumulating state does.
static void test_chunk_trailer_linelen_bounded(void) {
    http_resp_t r; http_resp_init(&r); body_len = 0;
    CHECK(FEED(&r, "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n"),
          "headers plus the terminating zero chunk parse");
    char junk[600];
    memset(junk, 'x', sizeof junk);
    CHECK(http_resp_feed(&r, (const uint8_t *)junk, (int)sizeof junk, sink, NULL),
          "an overlong, not-yet-terminated trailer line is not itself an error");
    CHECK(r._linelen <= (int)sizeof(r._linebuf),
          "_linelen must be capped at the line buffer size, not grown unbounded");
}

int main(void) {
    RUN(test_content_length_body); RUN(test_chunked_body);
    RUN(test_split_across_feeds); RUN(test_204_has_no_body);
    RUN(test_request_includes_bearer); RUN(test_request_refuses_overflow);
    RUN(test_header_names_case_insensitive); RUN(test_304_has_no_body);
    RUN(test_split_inside_header_name_and_terminators);
    RUN(test_chunked_split_inside_size_line_and_boundary);
    RUN(test_chunked_multiple_chunks_byte_at_a_time);
    RUN(test_no_framing_header_completes_after_headers);
    RUN(test_content_length_overflow_rejected);
    RUN(test_chunk_size_overflow_rejected);
    RUN(test_chunk_trailer_linelen_bounded);
    return REPORT();
}
