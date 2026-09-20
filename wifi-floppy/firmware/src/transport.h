#ifndef TRANSPORT_H
#define TRANSPORT_H
// The transport seam: everything above this (the HTTP parser, the device
// protocol state machine) talks to the network only through this vtable, so
// it can be driven by a scriptable fake on the host instead of a real TLS
// socket on the device. No SDK includes, no lwIP, no implementation here --
// this header is shared by both the real (device-only, later task)
// implementation and test/transport_fake.c.
#include <stdint.h>
#include <stdbool.h>

typedef struct transport {
    // Returns 0 on success, negative on failure.
    int  (*connect)(struct transport *t, const char *host, int port);
    int  (*write)(struct transport *t, const uint8_t *b, int n);
    // Returns bytes read, 0 on clean close, negative on error/timeout.
    int  (*read)(struct transport *t, uint8_t *b, int cap, int timeout_ms);
    void (*close)(struct transport *t);
    // Optional, may be NULL. True when the connection the last connect()
    // handed back was an ALREADY OPEN one rather than a fresh handshake.
    // The caller needs this to tell two failures apart: a fresh connection
    // that failed says something about the network, while a reused one that
    // failed usually says only that the server had closed it since -- and
    // that one is worth retrying immediately, once, on a new connection.
    bool (*reused)(struct transport *t);
    // Optional, may be NULL -- NULL means "just close()". Ends the
    // connection for real, whatever close() would have done with it.
    //
    // close() cannot tell "the response finished" from "we gave up on it":
    // both look like the caller being done. A transport that keeps a clean
    // connection alive would keep one the caller ABANDONED mid-response
    // too -- and then every later response belongs to the previous
    // request, permanently, because nothing in the protocol ever
    // resynchronises. So every non-clean exit calls this instead, and it
    // can never hand the socket back.
    void (*abandon)(struct transport *t);
    void *impl;
} transport_t;

// Injected clock: milliseconds since boot, monotonic.
typedef uint32_t (*clock_ms_fn)(void);

#endif
