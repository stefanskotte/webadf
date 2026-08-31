#ifndef DNS_SERVER_H
#define DNS_SERVER_H
// Pure DNS responder: answers every A query with the portal's own address,
// so a captive-portal client resolves any hostname (including the OS's own
// connectivity-check domains) to the AP. A query for any other type gets an
// empty NOERROR reply (question echoed, ANCOUNT 0) rather than an A record
// carrying the wrong RR type -- see dns_server.c. No sockets, no
// pico-sdk/lwIP -- this links into the host test build.
#include <stdint.h>

#define PORTAL_IP_0 192
#define PORTAL_IP_1 168
#define PORTAL_IP_2 4
#define PORTAL_IP_3 1

// Build a reply to `req` (a UDP payload received on port 53) into `out`.
// Returns bytes written to `out`, or 0 for "do not reply" -- the request is
// malformed, is itself a response (QR bit set), or has no question section.
// A well-formed non-A query is still answered (empty NOERROR), not ignored:
// silence there costs the client its whole retry timer before it falls back
// to the A query the portal actually depends on.
// Never writes past `cap`. Pure: no sockets.
int dns_handle(const uint8_t *req, int len, uint8_t *out, int cap);

#endif
