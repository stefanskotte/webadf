#ifndef TRANSPORT_H
#define TRANSPORT_H
// The transport seam: everything above this (the HTTP parser, the device
// protocol state machine) talks to the network only through this vtable, so
// it can be driven by a scriptable fake on the host instead of a real TLS
// socket on the device. No SDK includes, no lwIP, no implementation here --
// this header is shared by both the real (device-only, later task)
// implementation and test/transport_fake.c.
#include <stdint.h>

typedef struct transport {
    // Returns 0 on success, negative on failure.
    int  (*connect)(struct transport *t, const char *host, int port);
    int  (*write)(struct transport *t, const uint8_t *b, int n);
    // Returns bytes read, 0 on clean close, negative on error/timeout.
    int  (*read)(struct transport *t, uint8_t *b, int cap, int timeout_ms);
    void (*close)(struct transport *t);
    void *impl;
} transport_t;

// Injected clock: milliseconds since boot, monotonic.
typedef uint32_t (*clock_ms_fn)(void);

#endif
