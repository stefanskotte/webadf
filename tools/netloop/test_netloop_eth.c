/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#include "netloop_eth.h"
#include "pnet_sort.h"
#include "pnet_status.h"
#include "pnet_mfm.h"
#include "pnet_frame.h"
#include "netloop_stats.h"
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
    /* The drain stops on a quiet exchange or at its bound, never while a batch is still coming. */
    CHECK(!nl_drain_done(1, 2, 1, 8) && nl_drain_done(1, 0, 2, 8) && !nl_drain_done(2, 0, 3, 8) && nl_drain_done(2, 4, 8, 8),
          "drain decision");
    /* An ARP run passes when every round was answered. */
    CHECK(nl_arp_pass(1, 1) && nl_arp_pass(1000, 1000) && !nl_arp_pass(999, 1000) && !nl_arp_pass(0, 1), "arp pass");
    CHECK(nl_arg_fits("192.168.100.100", 16) && !nl_arg_fits("192.168.100.1000", 16), "long IP is refused");
    /* Undersized buffers build nothing. */
    CHECK(nl_dhcp_discover(f, NL_DHCP_FRAME_BYTES - 1u, mac, 1u) == 0, "cap");
    {
        static uint8_t loop[PNET_STATUS_LOOP_BYTES], rd[1024], st[PNET_STATUS_BYTES];
        static const uint8_t bm[6] = {0x28, 0xcd, 0xc1, 0x19, 0x6a, 0x38};
        pnet_status_t s76 = { {0x28, 0xcd, 0xc1, 0x19, 0x6a, 0x38}, -55, PNET_LINK_NOIP, 1, 10, 0 };
        CHECK(pnet_build_status(loop, sizeof loop, 1, 2, &s76) == PNET_STATUS_LOOP_BYTES, "status built");
        for (size_t i = 0; i < sizeof rd; i++) rd[i] = loop[(i + 37u) % PNET_STATUS_LOOP_BYTES];
        const long off = pnet_find_sync(rd, sizeof rd, NL_DRIVER_SCAN);
        CHECK(off >= 0, "status sync");
        const size_t valid = off >= 0 ? pnet_shift_left(rd, sizeof rd, (size_t)off) : 0;
        pnet_hdr_t h;
        CHECK(pnet_parse_hdr_to_amiga_as(rd, valid, &h, 1, PNET_MODE_CONFIG) == PNET_OK, "status header");
        CHECK(pnet_rle_decode(rd + PNET_HDR_MFM_BYTES, h.compressed_size, st, sizeof st) == (long)PNET_STATUS_BYTES,
              "status payload");
        CHECK(nl_status_problem(st, sizeof st, bm) == NULL, "the board's status passes");
        static const uint8_t other[6] = {0x28, 0xcd, 0xc1, 0x19, 0x6a, 0x39};
        CHECK(nl_status_problem(st, sizeof st, other) != NULL, "a different MAC does not");
        st[PNET_ST_LINK] = PNET_LINK_DOWN;
        CHECK(nl_status_problem(st, sizeof st, bm) != NULL, "nor does a link that is down");
    }
    printf("%s: %s\n", __FILE__, failed ? "FAIL" : "ok");
    return failed ? 1 : 0;
}
