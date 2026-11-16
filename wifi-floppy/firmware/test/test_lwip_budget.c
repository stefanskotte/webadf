// lwipopts.h's pcb pools against what runs at once with the setup page opened beside the station (bench
// 2026-11-15, fw 1.25.0 TEST: lwIP's default 4 UDP pcbs left the DNS client none, and the board was offline for the
// whole ten minutes). The budget is counted in lwipopts.h; this pins the arithmetic, and run.sh checks that the
// board's own sources open exactly the portal's UDP pcbs (any new udp_new() must join the budget).
#include "harness.h"
#include "../lwipopts.h"

static void udp_holds_every_user_at_once(void) {
    // DHCP client (one shared pcb, dhcp.c) + SNTP (sntp.c) + one per DNS lookup in flight (LWIP_DNS_SECURE's
    // random source port, up to DNS_TABLE_SIZE) + the portal's DHCP and DNS servers.
    const int users = 1 + 1 + DNS_TABLE_SIZE + 2;
    CHECK_EQ_INT(WF_UDP_PCB_BUDGET, users);
    CHECK(MEMP_NUM_UDP_PCB >= users, "the UDP pool holds them all");
    CHECK(4 < users, "lwIP's default (4) does not: the bench failure");
    // The failure itself: with the default, the station's users plus the portal leave DNS nothing.
    CHECK_EQ_INT(4 - (1 + 1 + 2), 0);
}

static void tcp_holds_every_user_at_once(void) {
    // The HTTPS connection twice (one abandoned or in TIME_WAIT while the next connects) + Transfer's connection +
    // the portal's three HTTP connections, and spare: an empty TCP pool makes lwIP kill a live connection.
    const int users = 2 + 1 + 3;
    CHECK(MEMP_NUM_TCP_PCB >= users + 1, "the TCP pool holds them all, with room");
    CHECK(5 < users, "lwIP's default (5) does not");
    CHECK_EQ_INT(WF_TCP_PCB_PORTAL_HTTP, 3);
}

int main(void) {
    RUN(udp_holds_every_user_at_once);
    RUN(tcp_holds_every_user_at_once);
    return REPORT();
}
