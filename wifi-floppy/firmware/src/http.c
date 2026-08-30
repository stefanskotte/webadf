#include "http.h"
#include <string.h>
#include <stdio.h>

// Byte-at-a-time HTTP/1.1 response parser. The transport (a later task's TLS
// layer) hands us bytes in whatever fragments it happens to receive them --
// possibly one byte at a time, possibly mid-token, possibly split between
// the \r and \n of a terminator -- so every state must be resumable at any
// byte boundary. No allocation; a fixed line buffer holds the status line
// and each header line as it accumulates.
enum {
    ST_STATUS_LINE, ST_HEADER_LINE, ST_BODY_LEN,
    ST_CHUNK_SIZE_LINE, ST_CHUNK_DATA, ST_CHUNK_CRLF, ST_CHUNK_TRAILER, ST_DONE, ST_ERROR
};

static int hex_digit(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// Freestanding-friendly decimal parse (no locale/errno dependence on strtol),
// used only for the 3-digit status code -- small enough that no bound is
// needed here (see parse_decimal_bounded for the body-size-affecting path).
static long parse_decimal(const char *s) {
    long v = 0;
    while (*s >= '0' && *s <= '9') { v = v * 10 + (*s - '0'); s++; }
    return v;
}

// Bounded accumulation for values that gate how many body bytes we expect:
// Content-Length and a chunk size. Checks the bound BEFORE each multiply so
// the accumulator itself can never wrap (task 3's image_loader.c fix is the
// same shape: bound before the arithmetic, not after). Rejects rather than
// clamping or truncating -- a value this large or malformed is treated as a
// malformed response, not a plausible one.
static bool parse_bounded(const char *s, int len, int base, long max, long *out) {
    long v = 0;
    for (int i = 0; i < len; i++) {
        int d = (base == 16) ? hex_digit(s[i])
                              : (s[i] >= '0' && s[i] <= '9' ? s[i] - '0' : -1);
        if (d < 0) return false;
        if (v > (max - d) / base) return false; // would exceed max (or wrap)
        v = v * base + d;
    }
    *out = v;
    return true;
}

static bool ci_equal(const char *a, const char *b) {
    for (; *a && *b; a++, b++) {
        char ca = *a, cb = *b;
        if (ca >= 'A' && ca <= 'Z') ca += 'a' - 'A';
        if (cb >= 'A' && cb <= 'Z') cb += 'a' - 'A';
        if (ca != cb) return false;
    }
    return *a == *b;
}

static bool ci_starts_with(const char *s, const char *prefix) {
    for (; *prefix; s++, prefix++) {
        char a = *s, b = *prefix;
        if (a >= 'A' && a <= 'Z') a += 'a' - 'A';
        if (b >= 'A' && b <= 'Z') b += 'a' - 'A';
        if (a != b) return false;
    }
    return true;
}

static void parse_status_line(http_resp_t *r) {
    // "HTTP/1.1 NNN reason"
    const char *sp = strchr(r->_linebuf, ' ');
    r->status = sp ? (int)parse_decimal(sp + 1) : 0;
}

static void handle_header_line(http_resp_t *r) {
    if (r->_linelen == 0) { r->headers_done = true; return; }
    r->_linebuf[r->_linelen] = '\0';
    char *colon = strchr(r->_linebuf, ':');
    if (!colon) return; // malformed header line; ignore rather than abort
    *colon = '\0';
    const char *name = r->_linebuf;
    const char *val = colon + 1;
    while (*val == ' ' || *val == '\t') val++;
    int vlen = (int)strlen(val);
    while (vlen > 0 && (val[vlen - 1] == ' ' || val[vlen - 1] == '\t')) vlen--;
    if (ci_equal(name, "content-length")) {
        long v;
        if (!parse_bounded(val, vlen, 10, HTTP_MAX_BODY_BYTES, &v)) {
            r->_state = ST_ERROR;
            return;
        }
        r->content_length = v;
    } else if (ci_equal(name, "transfer-encoding")) {
        if (ci_starts_with(val, "chunked")) r->chunked = true;
    }
}

void http_resp_init(http_resp_t *r) {
    memset(r, 0, sizeof *r);
    r->content_length = -1;
    r->_state = ST_STATUS_LINE;
}

static void start_body_phase(http_resp_t *r) {
    int s = r->status;
    if (s == 204 || s == 304) {
        r->body_complete = true;
        r->_state = ST_DONE;
    } else if (r->chunked) {
        r->_state = ST_CHUNK_SIZE_LINE;
    } else if (r->content_length == 0) {
        r->body_complete = true;
        r->_state = ST_DONE;
    } else if (r->content_length > 0) {
        r->_body_got = 0;
        r->_state = ST_BODY_LEN;
    } else {
        // No framing header at all: nothing further can be delimited.
        r->body_complete = true;
        r->_state = ST_DONE;
    }
}

bool http_resp_feed(http_resp_t *r, const uint8_t *data, int len,
                    void (*sink)(void *ctx, const uint8_t *b, int n), void *ctx) {
    if (r->_state == ST_ERROR) return false;

    for (int i = 0; i < len; i++) {
        uint8_t c = data[i];

        switch (r->_state) {
        case ST_STATUS_LINE:
        case ST_HEADER_LINE:
            if (c == '\r') continue;
            if (c == '\n') {
                if (r->_state == ST_STATUS_LINE) {
                    int n = r->_linelen < (int)sizeof(r->_linebuf) ?
                             r->_linelen : (int)sizeof(r->_linebuf) - 1;
                    r->_linebuf[n] = '\0';
                    parse_status_line(r);
                    r->_state = ST_HEADER_LINE;
                } else {
                    handle_header_line(r);
                    if (r->_state == ST_ERROR) return false;
                    if (r->headers_done) start_body_phase(r);
                }
                r->_linelen = 0;
                continue;
            }
            if (r->_linelen < (int)sizeof(r->_linebuf) - 1) {
                r->_linebuf[r->_linelen++] = (char)c;
            } // else: overlong line, drop extra bytes but keep scanning for \n
            continue;

        case ST_BODY_LEN: {
            int want = (int)(r->content_length - r->_body_got);
            int take = (len - i) < want ? (len - i) : want;
            if (take > 0) {
                sink(ctx, data + i, take);
                r->_body_got += take;
                i += take - 1;
            }
            if (r->_body_got >= r->content_length) {
                r->body_complete = true;
                r->_state = ST_DONE;
            }
            continue;
        }

        case ST_CHUNK_SIZE_LINE:
            if (c == '\r') continue;
            if (c == ';') { r->_chunk_ext = true; continue; }
            if (c == '\n') {
                long size;
                if (!parse_bounded(r->_linebuf, r->_linelen, 16, HTTP_MAX_BODY_BYTES, &size)) {
                    r->_state = ST_ERROR;
                    return false;
                }
                r->_linelen = 0;
                r->_chunk_ext = false;
                r->_chunk_left = size;
                r->_state = (size == 0) ? ST_CHUNK_TRAILER : ST_CHUNK_DATA;
                continue;
            }
            if (!r->_chunk_ext && r->_linelen < (int)sizeof(r->_linebuf) - 1) {
                r->_linebuf[r->_linelen++] = (char)c;
            }
            continue;

        case ST_CHUNK_DATA: {
            int want = (int)r->_chunk_left;
            int take = (len - i) < want ? (len - i) : want;
            if (take > 0) {
                sink(ctx, data + i, take);
                r->_chunk_left -= take;
                i += take - 1;
            }
            if (r->_chunk_left == 0) r->_state = ST_CHUNK_CRLF;
            continue;
        }

        case ST_CHUNK_CRLF:
            if (c == '\r') continue;
            if (c == '\n') { r->_state = ST_CHUNK_SIZE_LINE; continue; }
            r->_state = ST_ERROR;
            return false;

        case ST_CHUNK_TRAILER:
            // Trailer headers after the terminating zero chunk, ended by a
            // blank line. Trailer values are not exposed to the caller.
            if (c == '\r') continue;
            if (c == '\n') {
                if (r->_linelen == 0) {
                    r->body_complete = true;
                    r->_state = ST_DONE;
                }
                r->_linelen = 0;
                continue;
            }
            if (r->_linelen < (int)sizeof(r->_linebuf)) r->_linelen++;
            continue;

        case ST_DONE:
        default:
            continue; // extra bytes after completion are ignored
        }
    }
    return true;
}

int http_build_request(char *out, int out_len, const char *method, const char *path,
                       const char *host, const char *bearer, const char *body) {
    int body_len = body ? (int)strlen(body) : 0;
    int n = body_len > 0 ?
        snprintf(out, (size_t)out_len,
            "%s %s HTTP/1.1\r\n"
            "Host: %s\r\n"
            "Authorization: Bearer %s\r\n"
            "Content-Length: %d\r\n"
            "Connection: keep-alive\r\n"
            "\r\n"
            "%s",
            method, path, host, bearer, body_len, body)
      : snprintf(out, (size_t)out_len,
            "%s %s HTTP/1.1\r\n"
            "Host: %s\r\n"
            "Authorization: Bearer %s\r\n"
            "Connection: keep-alive\r\n"
            "\r\n",
            method, path, host, bearer);
    if (n < 0 || n >= out_len) return -1;
    return n;
}
