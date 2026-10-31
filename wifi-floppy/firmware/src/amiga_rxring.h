#ifndef AMIGA_RXRING_H
#define AMIGA_RXRING_H
// The bytes from Transfer, between lwIP's receive callback and amiga_send.c (fw 1.23.0: taken out of amiga_tcp.c so
// that a host test can judge the TCP ack accounting -- spec 2026-10-31 section 3, 1.22's deferred minor).
//
// A line byte is acknowledged to lwIP only when rr_take_line has taken it, so the receive window is the backpressure:
// Transfer waits in its own socket while core1 is busy (an HTTPS call), and the ring -- bigger than the window --
// never overflows (bench 2026-10-31). An upload's raw bytes go to the upload ring (as_raw_feed) and are acknowledged
// at once: the upload's credit paces them. A close acknowledges whatever is unread, so lwIP closes with a FIN, not RST.
//
// Pure: no lwIP or pico-sdk header. The caller (amiga_tcp.c) holds the lwIP lock around every call and makes the
// tcp_recved calls with the counts these return. RULE: compiled into every host test.
#include <stdbool.h>
#include <stdint.h>
#include "amiga_send.h"   // as_raw_t, as_raw_feed

typedef struct rr_ring {
    uint8_t *buf;            // NULL: no PSRAM, nothing is ever stored
    int size;
    volatile int head, tail; // bytes [tail, head) are unread; one byte stays free, so head == tail is empty
} rr_ring_t;

void rr_init(rr_ring_t *r, uint8_t *buf, int size);
int rr_used(const rr_ring_t *r);
// One segment from lwIP: while *raw is armed its bytes go to as_raw_feed and are added to *ack_now (acknowledge them
// now); *raw becomes NULL when its section is complete, and the rest are line bytes, stored unacknowledged. -1: a byte
// past the upload's credit, or the ring full or missing -- the connection must close (raw bytes taken before that
// are in *ack_now all the same). 0 otherwise.
int rr_feed(rr_ring_t *r, as_raw_t **raw, const uint8_t *b, int n, uint32_t *ack_now);
// 1: a whole line into out (no LF, CRs dropped, cut at cap - 1), *ack = the bytes it used, LF included. 0: no whole
// line yet (*ack = 0).
int rr_take_line(rr_ring_t *r, char *out, int cap, int *ack);
// Empties the ring: the unread bytes, to acknowledge at a close.
int rr_drain(rr_ring_t *r);

#endif
