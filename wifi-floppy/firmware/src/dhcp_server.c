// Pure DHCP server for the captive portal's access point (see
// dhcp_server.h). Offers/acks exactly one address per never-before-seen
// MAC, out of a small fixed pool, and points the client at this board for
// both its default route and DNS -- the latter is what makes dns_server.c's
// always-answer-with-us responder actually reachable.
//
// No pico-sdk/lwIP includes here -- only C standard headers, plus
// dns_server.h for the PORTAL_IP_* constants (Task 3 put "we are
// 192.168.4.1" there; DHCP reuses that identity rather than redefining it)
// -- so this links into the host test build unmodified (test/run.sh
// compiles every src/*.c, minus a small device-only exclusion list, into
// every test binary). Task 6 binds a UDP socket to it.
#include "dhcp_server.h"
#include "dns_server.h"     // PORTAL_IP_0..3
#include <string.h>

// BOOTP fixed header layout (RFC 2131 §2), all offsets from the start of
// the packet:
//   op(1) htype(1) hlen(1) hops(1)              0..3
//   xid(4)                                       4..7
//   secs(2) flags(2)                             8..11
//   ciaddr(4)                                    12..15
//   yiaddr(4)                                    16..19
//   siaddr(4)                                    20..23
//   giaddr(4)                                    24..27
//   chaddr(16)                                   28..43
//   sname(64)                                    44..107
//   file(128)                                    108..235
//   magic cookie(4)                              236..239
//   options...                                   240..
#define DHCP_OP 0
#define DHCP_HTYPE 1
#define DHCP_HLEN 2
#define DHCP_XID 4
#define DHCP_YIADDR 16
#define DHCP_CHADDR 28
#define DHCP_MAGIC 236
#define DHCP_OPTIONS 240
#define DHCP_MIN_LEN 240   // BOOTP header through the magic cookie

#define BOOTREQUEST 1
#define BOOTREPLY 2

#define DHCPDISCOVER 1
#define DHCPOFFER 2
#define DHCPREQUEST 3
#define DHCPACK 5

#define OPT_MSG_TYPE 53
#define OPT_SUBNET_MASK 1
#define OPT_ROUTER 3
#define OPT_DNS 6
#define OPT_LEASE_TIME 51
#define OPT_SERVER_ID 54
#define OPT_END 255

// One lease slot per known MAC. lease_used[i] is 0 until index i has been
// handed out; a MAC of all-zero bytes is legitimate (chaddr is attacker
// input), so a separate "in use" flag is used rather than treating an
// all-zero mac[] as "empty".
//
// lease_stamp[i] holds the value of lease_clock at the moment slot i was
// last issued or reused, so the pool can identify its least-recently-used
// entry. This matters because iOS and Android both default to per-network
// randomized MAC addresses: a phone that starts association, sleeps or is
// cancelled, and retries presents a *different* MAC each time. Against a
// small fixed pool, two abandoned attempts can fill every slot under two
// pseudo-MACs that nobody is behind any more; refusing a third, live
// attempt in that state is a self-lockout with no recovery available to
// the user (the AP only clears its leases on a power cycle, which nothing
// in the portal's own UI tells anyone to do). Evicting the LRU slot
// instead is strictly better for a provisioning AP that realistically
// serves one phone at a time: a stale lease has nobody behind it, so
// reclaiming it never takes an address away from a client still mid
// handshake as long as it keeps talking to us more recently than the
// abandoned one did.
static uint8_t lease_mac[DHCP_POOL_SIZE][6];
static uint8_t lease_used[DHCP_POOL_SIZE];
static unsigned long lease_stamp[DHCP_POOL_SIZE];
static unsigned long lease_clock;

void dhcp_reset_leases(void) {
    memset(lease_mac, 0, sizeof(lease_mac));
    memset(lease_used, 0, sizeof(lease_used));
    memset(lease_stamp, 0, sizeof(lease_stamp));
    lease_clock = 0;
}

// Find the pool slot already leased to `mac`, or -1.
static int find_lease(const uint8_t mac[6]) {
    for (int i = 0; i < DHCP_POOL_SIZE; i++) {
        if (lease_used[i] && memcmp(lease_mac[i], mac, 6) == 0) return i;
    }
    return -1;
}

// Return the pool slot with the smallest stamp -- the one least recently
// issued or reused. DHCP_POOL_SIZE is always >= 1 (a compile-time pool
// size chosen by the firmware), so this always returns a valid index.
static int lru_slot(void) {
    int lru = 0;
    for (int i = 1; i < DHCP_POOL_SIZE; i++) {
        if (lease_stamp[i] < lease_stamp[lru]) lru = i;
    }
    return lru;
}

// Return the slot leased to `mac`, allocating a free slot if `mac` has not
// been seen before, or -- if the pool is full -- evicting the
// least-recently-used slot and handing it to `mac`. `find_lease` is
// checked first, so a returning known MAC always gets its own slot back
// without disturbing anything else. Every path stamps the slot with the
// current tick before returning it, so both fresh allocations and reused
// leases count as "recently used" for the next eviction decision.
static int lease_for(const uint8_t mac[6]) {
    lease_clock++;
    int existing = find_lease(mac);
    if (existing >= 0) {
        lease_stamp[existing] = lease_clock;
        return existing;
    }
    for (int i = 0; i < DHCP_POOL_SIZE; i++) {
        if (!lease_used[i]) {
            lease_used[i] = 1;
            memcpy(lease_mac[i], mac, 6);
            lease_stamp[i] = lease_clock;
            return i;
        }
    }
    int evict = lru_slot();
    memcpy(lease_mac[evict], mac, 6);
    lease_stamp[evict] = lease_clock;
    return evict;
}

// Message type carried in option 53, or 0 if absent/malformed. Bounds every
// step against `len` before dereferencing: an option whose declared length
// runs past the end of the packet is malformed input (attacker-reachable --
// anything associated to the AP can send arbitrary UDP to port 67) and must
// stop the walk rather than read past it.
static uint8_t option_msg_type(const uint8_t *req, int len) {
    int i = DHCP_OPTIONS;
    while (i < len) {
        uint8_t code = req[i];
        if (code == OPT_END) break;
        if (code == 0) { i++; continue; }   // pad
        if (i + 1 >= len) break;             // no room for a length byte
        uint8_t opt_len = req[i + 1];
        if (i + 2 + opt_len > len) break;    // option body runs past `len`
        if (code == OPT_MSG_TYPE && opt_len >= 1) return req[i + 2];
        i += 2 + opt_len;
    }
    return 0;
}

// Append one TLV option to `out` at `*pos`, refusing to write past `cap`.
// Returns 1 on success, 0 if it would not fit (caller aborts the reply).
static int put_opt(uint8_t *out, int cap, int *pos, uint8_t code,
                    const uint8_t *data, int dlen) {
    if (*pos + 2 + dlen > cap) return 0;
    out[*pos] = code;
    out[*pos + 1] = (uint8_t)dlen;
    memcpy(out + *pos + 2, data, dlen);
    *pos += 2 + dlen;
    return 1;
}

int dhcp_handle(const uint8_t *req, int len, uint8_t *out, int cap) {
    if (len < DHCP_MIN_LEN) return 0;                  // header cut short

    if (req[DHCP_OP] != BOOTREQUEST) return 0;         // never answer a reply

    // Magic cookie must be checked before anything in the options area is
    // trusted.
    static const uint8_t cookie[4] = {0x63, 0x82, 0x53, 0x63};
    if (memcmp(req + DHCP_MAGIC, cookie, 4) != 0) return 0;

    uint8_t msg_type = option_msg_type(req, len);
    if (msg_type != DHCPDISCOVER && msg_type != DHCPREQUEST) return 0;

    uint8_t mac[6];
    memcpy(mac, req + DHCP_CHADDR, 6);

    // lease_for never returns a negative slot: an unknown mac with a full
    // pool evicts the least-recently-used lease rather than being refused
    // (see the lease_mac/lease_stamp comment above).
    int slot = lease_for(mac);

    uint8_t yiaddr[4] = {PORTAL_IP_0, PORTAL_IP_1, PORTAL_IP_2, (uint8_t)(16 + slot)};
    uint8_t server_id[4] = {PORTAL_IP_0, PORTAL_IP_1, PORTAL_IP_2, PORTAL_IP_3};
    uint8_t subnet[4] = {255, 255, 255, 0};
    uint8_t lease_time[4] = {0x00, 0x00, 0x0E, 0x10};   // 3600s = 1 hour, big-endian

    if (cap < DHCP_MIN_LEN) return 0;   // no room even for the fixed header

    memset(out, 0, DHCP_MIN_LEN);
    out[DHCP_OP] = BOOTREPLY;
    out[DHCP_HTYPE] = req[DHCP_HTYPE];
    out[DHCP_HLEN] = req[DHCP_HLEN];
    memcpy(out + DHCP_XID, req + DHCP_XID, 4);
    memcpy(out + DHCP_YIADDR, yiaddr, 4);
    memcpy(out + DHCP_CHADDR, mac, 6);
    memcpy(out + DHCP_MAGIC, cookie, 4);

    int pos = DHCP_OPTIONS;
    uint8_t reply_type = (msg_type == DHCPDISCOVER) ? DHCPOFFER : DHCPACK;

    if (!put_opt(out, cap, &pos, OPT_MSG_TYPE, &reply_type, 1)) return 0;
    if (!put_opt(out, cap, &pos, OPT_SUBNET_MASK, subnet, 4)) return 0;
    if (!put_opt(out, cap, &pos, OPT_ROUTER, server_id, 4)) return 0;
    if (!put_opt(out, cap, &pos, OPT_DNS, server_id, 4)) return 0;
    if (!put_opt(out, cap, &pos, OPT_LEASE_TIME, lease_time, 4)) return 0;
    if (!put_opt(out, cap, &pos, OPT_SERVER_ID, server_id, 4)) return 0;
    if (pos + 1 > cap) return 0;
    out[pos++] = OPT_END;

    return pos;
}
