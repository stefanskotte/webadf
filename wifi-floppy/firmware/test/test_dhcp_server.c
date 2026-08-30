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

int main(void) {
    RUN(test_discover_gets_an_offer);
    RUN(test_request_gets_an_ack);
    RUN(test_the_same_mac_keeps_its_address);
    RUN(test_a_bootreply_is_ignored);
    RUN(test_bad_magic_cookie_is_ignored);
    RUN(test_short_packet_is_ignored);
    RUN(test_option_length_running_past_the_packet_is_ignored);
    RUN(test_unrecognized_message_type_is_ignored);
    return REPORT();
}
