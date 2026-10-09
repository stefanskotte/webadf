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

// One phone at a time, plus a slot of slack. When the pool is full, a new
// (never-seen) MAC evicts the least-recently-used lease rather than being
// refused (see dhcp_server.c's lease_stamp/lru_slot). Refusing was tried
// first and rejected: iOS and Android both default to per-network
// randomized MAC addresses, so a phone that starts association and is
// cancelled or sleeps before finishing presents a fresh MAC on retry --
// two such abandoned attempts fill this pool and would permanently lock
// the real client out with no recovery short of a power cycle, which
// nothing in the portal's own UI tells anyone to do. A stale lease has
// nobody behind it, so evicting it is strictly better than refusing a
// live client.
#define DHCP_POOL_SIZE 2

// Build a reply to a BOOTP/DHCP request received on port 67. Returns bytes
// written to `out`, or 0 for "do not reply" -- the request is malformed,
// too short, missing/wrong magic cookie, a BOOTREPLY rather than a
// BOOTREQUEST, an option walks past `len`, or message type is something
// other than DISCOVER/REQUEST. (The lease pool is never a reason to
// refuse: a full pool evicts its least-recently-used entry instead --
// see DHCP_POOL_SIZE above.) Never writes past `cap`. Pure: no sockets.
int dhcp_handle(const uint8_t *req, int len, uint8_t *out, int cap);

// Clear all leases. Used by host tests to isolate cases from each other,
// and called for real when the AP (re)starts so a previous session's
// leases don't linger.
void dhcp_reset_leases(void);

// DIAGNOSTIC (portal re-join, HANDOFF 2026-10-09): the lease table, for a
// foreground loop to log what changed. One entry per slot in use: the MAC,
// the address's last octet, the last message type answered (1 DISCOVER ->
// OFFER, 3 REQUEST -> ACK) and how many messages that MAC has had answered.
// Returns the entries written (<= max). The caller serialises against the
// receive path (on the device: the network lock).
typedef struct {
    uint8_t  mac[6];
    uint8_t  ip_last;
    uint8_t  last_type;
    uint32_t answered;
} dhcp_lease_info_t;
int dhcp_leases(dhcp_lease_info_t *out, int max);

#endif
