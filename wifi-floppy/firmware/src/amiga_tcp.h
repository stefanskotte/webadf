#ifndef AMIGA_TCP_H
#define AMIGA_TCP_H
// PaulaNET Phase 4: the board's ops for amiga_send.c -- one lwIP raw-API TCP connection to the Amiga's Receive (over
// the PaulaNET local path, pnet_bridge.c) and the HTTPS calls to the server (device_client.c). Device-only.
#include "amiga_send.h"
#include "device_client.h"

void amiga_tcp_ops(as_ops_t *ops, device_client_t *c);

#endif
