// Test infrastructure only -- never shipped to the device. Backs every
// transport_t used by a host test with a queue of scripted events (a full
// response, a truncated one, or a connect failure), consumed one per
// connect() cycle. No allocation: fixed-size static storage throughout. A
// test that queues more than fits, or a client under test that writes or
// reads more than fits, aborts loudly (fake_fatal) rather than silently
// truncating or overflowing -- a fake that lies quietly would let broken
// code above it pass its tests.
#include "transport_fake.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Sized generously for the few-KB response bodies (status line + headers +
// a small JSON or image-metadata body) that tests in tasks 6+ script. Not
// sized for the multi-MB image body itself -- the fake never needs to carry
// one of those in full, per the task brief.
#define FAKE_MAX_QUEUE 8
#define FAKE_MAX_RESPONSE_BYTES 8192
#define FAKE_MAX_REQUEST_BYTES 4096

typedef enum { FAKE_EV_RESPONSE, FAKE_EV_CONNECT_FAIL } fake_event_type_t;

typedef struct {
    fake_event_type_t type;
    uint8_t data[FAKE_MAX_RESPONSE_BYTES];
    int len;            // total bytes stored (the untruncated response length)
    int deliver_limit;  // how many bytes read() will ever hand out for this
                         // event -- == len for a full response, == n for a
                         // truncated one
} fake_event_t;

static fake_event_t g_queue[FAKE_MAX_QUEUE];
static int g_queue_count;   // number of events pushed since fake_reset()
static int g_queue_pos;     // number consumed by connect() so far

static int g_connected;
static int g_active_slot;   // index into g_queue of the current connection's
                             // event, or -1 if none is active
static int g_cursor;        // bytes already delivered by read() for it

static char g_request[FAKE_MAX_REQUEST_BYTES];
static int g_request_len;
static int g_request_count;

static uint32_t g_clock_ms;

static void fake_fatal(const char *msg) {
    fprintf(stderr, "transport_fake: fatal: %s\n", msg);
    abort();
}

void fake_reset(void) {
    g_queue_count = 0;
    g_queue_pos = 0;
    g_connected = 0;
    g_active_slot = -1;
    g_cursor = 0;
    g_request_len = 0;
    g_request[0] = '\0';
    g_request_count = 0;
    g_clock_ms = 0;
}

static fake_event_t *fake_push_slot(void) {
    if (g_queue_count >= FAKE_MAX_QUEUE) {
        fake_fatal("response queue full -- increase FAKE_MAX_QUEUE or "
                    "push fewer scripted responses in this test");
    }
    return &g_queue[g_queue_count++];
}

void fake_push_response(const char *raw) {
    size_t len = strlen(raw);
    if (len > (size_t)FAKE_MAX_RESPONSE_BYTES) {
        fake_fatal("pushed response longer than FAKE_MAX_RESPONSE_BYTES");
    }
    fake_event_t *e = fake_push_slot();
    e->type = FAKE_EV_RESPONSE;
    memcpy(e->data, raw, len);
    e->len = (int)len;
    e->deliver_limit = (int)len;
}

void fake_push_truncated(const char *raw, int n) {
    size_t len = strlen(raw);
    if (len > (size_t)FAKE_MAX_RESPONSE_BYTES) {
        fake_fatal("pushed response longer than FAKE_MAX_RESPONSE_BYTES");
    }
    if (n < 0 || (size_t)n > len) {
        fake_fatal("fake_push_truncated: n exceeds the response length");
    }
    fake_event_t *e = fake_push_slot();
    e->type = FAKE_EV_RESPONSE;
    memcpy(e->data, raw, len);
    e->len = (int)len;
    e->deliver_limit = n;
}

void fake_push_connect_failure(void) {
    fake_event_t *e = fake_push_slot();
    e->type = FAKE_EV_CONNECT_FAIL;
    e->len = 0;
    e->deliver_limit = 0;
}

static int fake_connect(struct transport *t, const char *host, int port) {
    (void)t; (void)host; (void)port;
    if (g_queue_pos >= g_queue_count) {
        fake_fatal("connect() called with no scripted response or "
                    "connect-failure queued -- push one before connecting");
    }
    g_active_slot = g_queue_pos++;
    g_cursor = 0;
    g_request_len = 0;
    g_request[0] = '\0';
    if (g_queue[g_active_slot].type == FAKE_EV_CONNECT_FAIL) {
        g_connected = 0;
        return -1;
    }
    g_connected = 1;
    return 0;
}

static int fake_write(struct transport *t, const uint8_t *b, int n) {
    (void)t;
    if (!g_connected) return -1;
    if (n < 0) return -1;
    if (g_request_len + n > (int)sizeof(g_request) - 1) {
        fake_fatal("recorded request exceeds FAKE_MAX_REQUEST_BYTES");
    }
    memcpy(g_request + g_request_len, b, (size_t)n);
    g_request_len += n;
    g_request[g_request_len] = '\0';
    g_request_count++;
    return n;
}

static int fake_read(struct transport *t, uint8_t *b, int cap, int timeout_ms) {
    (void)t; (void)timeout_ms;
    if (!g_connected || g_active_slot < 0) return -1;
    fake_event_t *e = &g_queue[g_active_slot];
    if (g_cursor >= e->deliver_limit) return 0; // clean close: exhausted or truncated
    int avail = e->deliver_limit - g_cursor;
    int n = (avail < cap) ? avail : cap;
    if (n < 0) n = 0;
    memcpy(b, e->data + g_cursor, (size_t)n);
    g_cursor += n;
    return n;
}

static void fake_close(struct transport *t) {
    (void)t;
    g_connected = 0;
}

static transport_t g_transport = {
    .connect = fake_connect,
    .write = fake_write,
    .read = fake_read,
    .close = fake_close,
    .impl = NULL,
};

transport_t *fake_transport(void) {
    return &g_transport;
}

const char *fake_last_request(void) {
    return g_request;
}

int fake_request_count(void) {
    return g_request_count;
}

void fake_set_clock(uint32_t ms) {
    g_clock_ms = ms;
}

uint32_t fake_clock_ms(void) {
    return g_clock_ms;
}
