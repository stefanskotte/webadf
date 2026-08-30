#ifndef DHCP_SERVER_H
#define DHCP_SERVER_H
// Pure DHCP server for the captive portal's access point: hands the one
// phone associated to the AP an IP address in our subnet, and points it at
// this board for both the default route and DNS (dns_server.h's
// responder). No sockets, no pico-sdk/lwIP -- only C standard headers plus
// dns_server.h for the PORTAL_IP_* constants (defined there because both
// servers share the same "we are 192.168.4.1" identity) -- so this links
// into the host test build. Task 6 binds a UDP socket to it.
#include <stdint.h>

// One phone at a time, plus a slot of slack. When the pool is exhausted, a
// new (never-seen) MAC gets no reply at all (see dhcp_server.c) rather than
// evicting an existing lease -- this AP realistically serves a single
// phone, so refusing a second one is an acceptable, deliberate limitation.
#define DHCP_POOL_SIZE 2

// Build a reply to a BOOTP/DHCP request received on port 67. Returns bytes
// written to `out`, or 0 for "do not reply" -- the request is malformed,
// too short, missing/wrong magic cookie, a BOOTREPLY rather than a
// BOOTREQUEST, an option walks past `len`, message type is something other
// than DISCOVER/REQUEST, or the lease pool is exhausted. Never writes past
// `cap`. Pure: no sockets.
int dhcp_handle(const uint8_t *req, int len, uint8_t *out, int cap);

// Clear all leases. Used by host tests to isolate cases from each other,
// and called for real when the AP (re)starts so a previous session's
// leases don't linger.
void dhcp_reset_leases(void);

#endif
