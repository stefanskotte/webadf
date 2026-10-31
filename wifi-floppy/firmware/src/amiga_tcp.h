#ifndef AMIGA_TCP_H
#define AMIGA_TCP_H
// PaulaNET Phase 4: the board's ops for amiga_send.c -- one lwIP raw-API TCP connection to the Amiga's Receive (over
// the PaulaNET local path, pnet_bridge.c) and the HTTPS calls to the server (device_client.c). Device-only.
#include "amiga_send.h"
#include "device_client.h"

// The line ring, in PSRAM: more than lwIP's TCP_WND (32 * 1460 = 46,720), so it holds a whole receive window.
#define AMIGA_TCP_RING_BYTES 49152

// ring: AMIGA_TCP_RING_BYTES in PSRAM, or NULL when PSRAM is missing (sending is off then).
void amiga_tcp_ops(as_ops_t *ops, device_client_t *c, uint8_t *ring);

#endif
