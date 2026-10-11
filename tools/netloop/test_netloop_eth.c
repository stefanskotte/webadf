/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#include "netloop_eth.h"
#include "pnet_sort.h"
#include <stdio.h>
#include <string.h>

static int failed;
#define CHECK(c, m) do { if (!(c)) { printf("  FAIL %s:%d: %s\n", __FILE__, __LINE__, m); failed++; } } while (0)

int main(void) {
    const char *st = nl_eth_selftest();
    CHECK(st == NULL, st ? st : "");
    static const uint8_t mac[6] = {0x28, 0xcd, 0xc1, 0x01, 0x02, 0x03};
    const uint32_t board = 0xC0A80128u, router = 0xC0A80101u, me = 0xC0A80139u;
    uint8_t f[NL_DHCP_FRAME_BYTES];
    pnet_sort_t s;
    pnet_sort_init(&s);
    /* The board lets NetLoop's DISCOVER out and learns its xid... */
    size_t n = nl_dhcp_discover(f, sizeof f, mac, 0xCAFEF00Du);
    CHECK(n == NL_DHCP_FRAME_BYTES, "discover size");
    CHECK(pnet_sort_tx(&s, f, n, mac, board) == PNET_TX_SEND, "the board sends the DISCOVER");
    CHECK(s.nxid == 1 && s.xid[0] == 0xCAFEF00Du, "and learns its xid");
    /* ...and its REQUEST, which carries the offered address and the server. */
    n = nl_dhcp_request(f, sizeof f, mac, 0xCAFEF00Du, me, router);
    CHECK(pnet_sort_tx(&s, f, n, mac, board) == PNET_TX_SEND, "the board sends the REQUEST");
    /* NetLoop's ARP teaches the board the Amiga's address. */
    n = nl_arp_request(f, mac, me, router);
    CHECK(n == NL_ETH_MIN, "arp size");
    CHECK(pnet_sort_tx(&s, f, n, mac, board) == PNET_TX_SEND && s.amiga_ip == me, "arp teaches");
    /* A wrong MAC= is refused by the board, visibly. */
    static const uint8_t typo[6] = {0x28, 0xcd, 0xc1, 0x01, 0x02, 0x04};
    n = nl_arp_request(f, typo, me, router);
    CHECK(pnet_sort_tx(&s, f, n, mac, board) == PNET_TX_MAC, "a typo is a MAC refusal");
    /* An L2 start never echoes the served counter, so the first write frees nothing. */
    for (unsigned p = 0; p < 256u; p++) CHECK(nl_l2_start_ack((uint8_t)p) != (uint8_t)p, "start ack differs");
    /* Undersized buffers build nothing. */
    CHECK(nl_dhcp_discover(f, NL_DHCP_FRAME_BYTES - 1u, mac, 1u) == 0, "cap");
    printf("%s: %s\n", __FILE__, failed ? "FAIL" : "ok");
    return failed ? 1 : 0;
}
