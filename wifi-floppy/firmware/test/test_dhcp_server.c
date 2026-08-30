#include "harness.h"
#include "../src/dhcp_server.h"
#include "../src/dns_server.h"     // PORTAL_IP_*
#include <string.h>

#define DHCP_MIN_LEN 240           // BOOTP header + magic cookie

// op=1 BOOTREQUEST, htype=1, hlen=6, one option 53 with `msg_type`.
static int build_request(uint8_t *b, int cap, uint8_t msg_type, const uint8_t mac[6]) {
    if (cap < DHCP_MIN_LEN + 6) return 0;
    memset(b, 0, cap);
    b[0] = 1; b[1] = 1; b[2] = 6;
    b[4] = 0xDE; b[5] = 0xAD; b[6] = 0xBE; b[7] = 0xEF;   // xid
    memcpy(b + 28, mac, 6);                                // chaddr
    b[236] = 0x63; b[237] = 0x82; b[238] = 0x53; b[239] = 0x63;
    b[240] = 53; b[241] = 1; b[242] = msg_type;
    b[243] = 255;                                          // end option
    return DHCP_MIN_LEN + 4;
}

static uint8_t opt(const uint8_t *p, int len, uint8_t want) {
    for (int i = DHCP_MIN_LEN; i + 1 < len; ) {
        if (p[i] == 255) break;
        if (p[i] == want) return p[i + 2];
        i += 2 + p[i + 1];
    }
    return 0;
}

static void test_discover_gets_an_offer(void) {
    dhcp_reset_leases();
    uint8_t mac[6] = {2,3,4,5,6,7}, req[512], out[512];
    int n = build_request(req, sizeof req, 1 /* DISCOVER */, mac);
    int r = dhcp_handle(req, n, out, sizeof out);
    CHECK(r > 0, "an offer is sent");
    CHECK_EQ_INT(out[0], 2);                       // BOOTREPLY
    CHECK_EQ_INT(opt(out, r, 53), 2);              // DHCPOFFER
    CHECK_EQ_INT(out[16], PORTAL_IP_0);            // yiaddr in our subnet
    CHECK_EQ_INT(out[18], PORTAL_IP_2);
    CHECK(out[19] != PORTAL_IP_3, "never offer the server's own address");
    CHECK(memcmp(out + 4, req + 4, 4) == 0, "xid is echoed");
}

static void test_request_gets_an_ack(void) {
    dhcp_reset_leases();
    uint8_t mac[6] = {2,3,4,5,6,7}, req[512], out[512];
    int n = build_request(req, sizeof req, 3 /* REQUEST */, mac);
    int r = dhcp_handle(req, n, out, sizeof out);
    CHECK(r > 0, "an ack is sent");
    CHECK_EQ_INT(opt(out, r, 53), 5);              // DHCPACK
    CHECK_EQ_INT(opt(out, r, 54), PORTAL_IP_0);    // server id is us
}

static void test_the_same_mac_keeps_its_address(void) {
    dhcp_reset_leases();
    uint8_t mac[6] = {2,3,4,5,6,7}, req[512], a[512], b[512];
    int n = build_request(req, sizeof req, 1, mac);
    int ra = dhcp_handle(req, n, a, sizeof a);
    int rb = dhcp_handle(req, n, b, sizeof b);
    CHECK(ra > 0 && rb > 0, "both answered");
    CHECK_EQ_INT(a[19], b[19]);                    // same yiaddr
}

static void test_a_bootreply_is_ignored(void) {
    dhcp_reset_leases();
    uint8_t mac[6] = {2,3,4,5,6,7}, req[512], out[512];
    int n = build_request(req, sizeof req, 1, mac);
    req[0] = 2;                                     // BOOTREPLY, not a request
    CHECK_EQ_INT(dhcp_handle(req, n, out, sizeof out), 0);
}

static void test_bad_magic_cookie_is_ignored(void) {
    dhcp_reset_leases();
    uint8_t mac[6] = {2,3,4,5,6,7}, req[512], out[512];
    int n = build_request(req, sizeof req, 1, mac);
    req[236] = 0;
    CHECK_EQ_INT(dhcp_handle(req, n, out, sizeof out), 0);
}

static void test_short_packet_is_ignored(void) {
    dhcp_reset_leases();
    uint8_t mac[6] = {2,3,4,5,6,7}, req[512], out[512];
    build_request(req, sizeof req, 1, mac);
    CHECK_EQ_INT(dhcp_handle(req, 100, out, sizeof out), 0);
}

static void test_option_length_running_past_the_packet_is_ignored(void) {
    // A hostile or truncated option must not walk the parser off the end.
    dhcp_reset_leases();
    uint8_t mac[6] = {2,3,4,5,6,7}, req[512], out[512];
    int n = build_request(req, sizeof req, 1, mac);
    req[241] = 200;                                 // option 53 claims 200 bytes
    CHECK_EQ_INT(dhcp_handle(req, n, out, sizeof out), 0);
}

// --- Edge case the brief's tests don't cover ---

// RELEASE (7), DECLINE (4), INFORM (8) etc. are real DHCP messages this
// server doesn't implement; answering them as if they were a
// DISCOVER/REQUEST would be wrong (e.g. handing out a fresh lease in
// reply to a RELEASE). Only DISCOVER/REQUEST get an answer.
static void test_unrecognized_message_type_is_ignored(void) {
    dhcp_reset_leases();
    uint8_t mac[6] = {2,3,4,5,6,7}, req[512], out[512];
    int n = build_request(req, sizeof req, 7 /* RELEASE */, mac);
    CHECK_EQ_INT(dhcp_handle(req, n, out, sizeof out), 0);
}

// --- Pool-exhaustion / MAC-randomization edge cases (review round 1) ---
//
// iOS and Android both default to per-network randomized MAC addresses.
// A phone that starts association, sleeps or is cancelled, and retries,
// presents a *different* MAC each time. Two abandoned attempts fill both
// slots of a DHCP_POOL_SIZE=2 pool under two pseudo-MACs; a naive "refuse
// when full" policy would then lock the user out of their own
// provisioning portal on the third attempt, with no recovery short of a
// power cycle. LRU eviction closes this: the slot with the oldest stamp
// (nobody live behind it, on this single-phone AP) is reclaimed instead.

static void test_pool_exhaustion_evicts_the_least_recently_used_lease(void) {
    dhcp_reset_leases();
    uint8_t mac1[6] = {1,1,1,1,1,1};
    uint8_t mac2[6] = {2,2,2,2,2,2};
    uint8_t mac3[6] = {3,3,3,3,3,3};
    uint8_t req[512], out1[512], out2[512], out3[512];

    int n1 = build_request(req, sizeof req, 1, mac1);
    int r1 = dhcp_handle(req, n1, out1, sizeof out1);
    CHECK(r1 > 0, "mac1 is served");

    int n2 = build_request(req, sizeof req, 1, mac2);
    int r2 = dhcp_handle(req, n2, out2, sizeof out2);
    CHECK(r2 > 0, "mac2 is served");

    // Pool (size 2) is now full with mac1 (least recently used) and mac2
    // (most recently used). A third, never-before-seen MAC must still be
    // served -- not refused -- by evicting mac1's slot.
    int n3 = build_request(req, sizeof req, 1, mac3);
    int r3 = dhcp_handle(req, n3, out3, sizeof out3);
    CHECK(r3 > 0, "mac3 is served rather than refused when the pool is full");
    CHECK_EQ_INT(out3[19], out1[19]);   // reclaims mac1's (LRU) address, not mac2's
}

static void test_mac_randomization_third_attempt_is_served(void) {
    // Models a real phone whose OS randomizes its MAC per association
    // attempt: it discovers, walks away (or is cancelled) before
    // completing the handshake, and retries with a fresh MAC. Two such
    // abandoned attempts must not permanently strand a third, genuine
    // attempt -- there is no user-visible way to recover except a power
    // cycle of the AP, which nothing in the portal's UI tells anyone to do.
    dhcp_reset_leases();
    uint8_t mac_a[6] = {0xAA,1,2,3,4,5};
    uint8_t mac_b[6] = {0xBB,1,2,3,4,5};
    uint8_t mac_c[6] = {0xCC,1,2,3,4,5};
    uint8_t req[512], out[512];

    int na = build_request(req, sizeof req, 1, mac_a);
    CHECK(dhcp_handle(req, na, out, sizeof out) > 0, "mac_a (abandoned attempt 1) discovers");

    int nb = build_request(req, sizeof req, 1, mac_b);
    CHECK(dhcp_handle(req, nb, out, sizeof out) > 0, "mac_b (abandoned attempt 2) discovers");

    int nc = build_request(req, sizeof req, 1, mac_c);
    int rc = dhcp_handle(req, nc, out, sizeof out);
    CHECK(rc > 0, "mac_c (the real retry) must be served, not locked out");
}

int main(void) {
    RUN(test_discover_gets_an_offer);
    RUN(test_request_gets_an_ack);
    RUN(test_the_same_mac_keeps_its_address);
    RUN(test_a_bootreply_is_ignored);
    RUN(test_bad_magic_cookie_is_ignored);
    RUN(test_short_packet_is_ignored);
    RUN(test_option_length_running_past_the_packet_is_ignored);
    RUN(test_unrecognized_message_type_is_ignored);
    RUN(test_pool_exhaustion_evicts_the_least_recently_used_lease);
    RUN(test_mac_randomization_third_attempt_is_served);
    return REPORT();
}
