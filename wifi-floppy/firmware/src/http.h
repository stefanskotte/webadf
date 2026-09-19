#ifndef HTTP_H
#define HTTP_H
// Pure HTTP/1.1 framing: a response parser fed by a network transport that
// delivers arbitrary-sized fragments (a TCP/TLS layer, in later tasks), and
// a request builder. No sockets, no TLS, no pico-sdk/lwIP -- this links into
// the host test build.
#include <stdint.h>
#include <stdbool.h>

// No response this device ever fetches (a small JSON poll body, an image a
// few MB at most) legitimately exceeds this. A Content-Length or chunk size
// beyond it is malformed or has overflowed arithmetic on its way to us --
// either way, refused outright rather than clamped or silently substituted.
#define HTTP_MAX_BODY_BYTES (8L * 1024 * 1024)

typedef struct {
    int      status;            // 0 until the status line is parsed
    bool     headers_done;
    bool     chunked;
    long     content_length;    // -1 if absent
    bool     body_complete;
    // --- internal parser state; do not touch from outside http.c ---
    int      _state;
    char     _linebuf[128];
    int      _linelen;
    bool     _chunk_ext;        // inside a ';'-introduced chunk extension
    long     _body_got;
    long     _chunk_left;
} http_resp_t;

void http_resp_init(http_resp_t *r);

// Feed received bytes. Body bytes are handed to `sink` as they are framed.
// Returns false on a malformed response.
bool http_resp_feed(http_resp_t *r, const uint8_t *data, int len,
                    void (*sink)(void *ctx, const uint8_t *b, int n), void *ctx);

// Build a request into `out`. Returns bytes written, or -1 if it would not fit.
// `bearer` may be NULL to omit the Authorization header entirely -- the one
// request in the device protocol built this way is device_client.h's
// dc_register, which is deliberately unauthenticated (the pairing code in
// the body IS the credential). Every other caller passes a real token.
int  http_build_request(char *out, int out_len, const char *method, const char *path,
                        const char *host, const char *bearer, const char *body);

// Headers only, for a body the caller sends straight after them. Binary-safe
// where http_build_request is not: that one takes the body as a C string, and
// a disk track is full of NUL bytes. Always carries Content-Length (0 for no
// body). `content_type` NULL omits the header. Returns bytes written, or -1.
int  http_build_head(char *out, int out_len, const char *method, const char *path,
                     const char *host, const char *bearer, const char *content_type,
                     int body_len);

#endif
