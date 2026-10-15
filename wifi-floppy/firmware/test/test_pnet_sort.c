#include "harness.h"
#include "../src/pnet_sort.h"
#include <stdint.h>
#include <string.h>

/* The layer-2 sharing sorter: whose frame is it? */

#define IP(a, b, c, d) ((uint32_t)(a) << 24 | (uint32_t)(b) << 16 | (uint32_t)(c) << 8 | (uint32_t)(d))
#define BOARD  IP(192, 168, 1, 40)
#define AMIGA  IP(192, 168, 1, 57)
#define ROUTER IP(192, 168, 1, 1)
static const uint8_t MAC[6]   = {0x28, 0xcd, 0xc1, 0x01, 0x02, 0x03};   /* the board's, shared */
static const uint8_t RMAC[6]  = {0x00, 0x11, 0x22, 0x33, 0x44, 0x55};   /* the router's */
static const uint8_t BCAST[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};
static uint8_t F[1600];

static void put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }
static void put32(uint8_t *p, uint32_t v) { put16(p, (uint16_t)(v >> 16)); put16(p + 2, (uint16_t)v); }

static size_t eth(const uint8_t *dst, const uint8_t *src, uint16_t type) {
    memset(F, 0, sizeof F);
    memcpy(F, dst, 6); memcpy(F + 6, src, 6); put16(F + 12, type);
    return 14;
}
static size_t arp(const uint8_t *dst, const uint8_t *src, uint16_t op, uint32_t spa, uint32_t tpa) {
    uint8_t *a = F + eth(dst, src, 0x0806);
    put16(a, 1); put16(a + 2, 0x0800); a[4] = 6; a[5] = 4; put16(a + 6, op);
    memcpy(a + 8, src, 6); put32(a + 14, spa); put32(a + 24, tpa);
    return 60;
}
/* IPv4 + `l4` bytes of payload; returns the offset of the payload. */
static size_t ipv4(const uint8_t *dst, const uint8_t *src, uint8_t proto, uint32_t sip, uint32_t dip, size_t l4) {
    uint8_t *ip = F + eth(dst, src, 0x0800);
    ip[0] = 0x45; put16(ip + 2, (uint16_t)(20 + l4)); ip[8] = 64; ip[9] = proto;
    put32(ip + 12, sip); put32(ip + 16, dip);
    return 34;
}
static size_t udp(const uint8_t *dst, const uint8_t *src, uint32_t sip, uint32_t dip,
                  uint16_t sp, uint16_t dp, size_t plen) {
    const size_t o = ipv4(dst, src, 17, sip, dip, 8 + plen);
    put16(F + o, sp); put16(F + o + 2, dp); put16(F + o + 4, (uint16_t)(8 + plen));
    return o + 8 + plen;
}
/* A BOOTP message: op 1 from the Amiga (68 -> 67), op 2 to it (67 -> 68), DHCP type `t`. */
static size_t dhcp(const uint8_t *dst, const uint8_t *src, uint32_t sip, uint32_t dip,
                   uint8_t op, uint32_t xid, uint32_t yiaddr, uint8_t t) {
    const size_t end = udp(dst, src, sip, dip, op == 1 ? 68 : 67, op == 1 ? 67 : 68, 300);
    uint8_t *b = F + 42;
    b[0] = op; b[1] = 1; b[2] = 6;
    put32(b + 4, xid); put32(b + 16, yiaddr);
    memcpy(b + 28, MAC, 6);                            /* chaddr: the shared MAC, either stack */
    put32(b + 236, 0x63825363u);
    b[240] = 53; b[241] = 1; b[242] = t; b[243] = 255;
    return end;
}
static pnet_sort_t fresh(uint32_t amiga) { pnet_sort_t s; pnet_sort_init(&s); s.amiga_ip = amiga; return s; }

static void arp_for_the_amiga_goes_to_both(void) {
    pnet_sort_t s = fresh(AMIGA);
    size_t n = arp(BCAST, RMAC, 1, ROUTER, AMIGA);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOTH);
    n = arp(MAC, RMAC, 2, ROUTER, AMIGA);             /* the router's reply to the Amiga */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOTH);
    n = arp(BCAST, RMAC, 1, ROUTER, BOARD);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = arp(BCAST, RMAC, 1, ROUTER, IP(192, 168, 1, 99));
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    pnet_sort_t none = fresh(0);
    n = arp(BCAST, RMAC, 1, ROUTER, AMIGA);
    CHECK_EQ_INT(pnet_sort_rx(&none, F, n, BOARD), PNET_SORT_BOARD);   /* no Amiga known: the board's */
    CHECK_EQ_INT(s.to_both, 2);
}

static void ipv4_unicast_to_the_amiga_goes_to_the_amiga_only(void) {
    pnet_sort_t s = fresh(AMIGA);
    size_t n = udp(MAC, RMAC, ROUTER, AMIGA, 53, 4000, 40);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    n = udp(MAC, RMAC, ROUTER, BOARD, 443, 50000, 40);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = udp(BCAST, RMAC, ROUTER, IP(255, 255, 255, 255), 137, 137, 50);   /* NetBIOS chatter */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = udp(BCAST, RMAC, ROUTER, IP(192, 168, 1, 255), 1900, 1900, 50);  /* subnet broadcast */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    static const uint8_t MCAST[6] = {0x01, 0x00, 0x5e, 0x00, 0x00, 0xfb};
    n = udp(MCAST, RMAC, ROUTER, IP(224, 0, 0, 251), 5353, 5353, 50);    /* mDNS */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    CHECK_EQ_INT(s.to_amiga, 1);
}

static void an_offer_to_an_unknown_address_goes_by_xid(void) {
    pnet_sort_t s = fresh(0);
    size_t n = dhcp(BCAST, MAC, 0, IP(255, 255, 255, 255), 1, 0xA1B2C3D4u, 0, 1);   /* DISCOVER */
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    CHECK_EQ_INT(s.amiga_ip, 0);                                    /* 0.0.0.0 teaches nothing */
    /* The OFFER, unicast to the offered address, to the shared MAC. */
    n = dhcp(MAC, RMAC, ROUTER, IP(192, 168, 1, 57), 2, 0xA1B2C3D4u, IP(192, 168, 1, 57), 2);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    CHECK_EQ_INT(s.amiga_ip, 0);                                    /* an offer is not a lease */
    n = dhcp(MAC, RMAC, ROUTER, IP(192, 168, 1, 57), 2, 0x11111111u, IP(192, 168, 1, 57), 2);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);   /* another xid: the board's */
    n = dhcp(BCAST, RMAC, ROUTER, IP(255, 255, 255, 255), 2, 0xA1B2C3D4u, AMIGA, 5);   /* ACK */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    CHECK_EQ_INT(s.amiga_ip, AMIGA);                                /* the lease is learned */
}

static void an_ack_naming_the_boards_address_is_refused(void) {
    pnet_sort_t s = fresh(0);
    size_t n = dhcp(BCAST, MAC, 0, IP(255, 255, 255, 255), 1, 7u, 0, 3);       /* REQUEST */
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    n = dhcp(MAC, RMAC, ROUTER, BOARD, 2, 7u, BOARD, 5);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_DROP);
    CHECK_EQ_INT(s.clash, 1);
    CHECK_EQ_INT(s.amiga_ip, 0);
    n = dhcp(MAC, RMAC, ROUTER, BOARD, 2, 7u, BOARD, 2);            /* the same, as an OFFER */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);   /* only an ACK is a lease */
}

static void the_boards_own_dhcp_replies_stay_the_boards(void) {
    pnet_sort_t s = fresh(AMIGA);
    size_t n = dhcp(BCAST, MAC, 0, IP(255, 255, 255, 255), 1, 5u, 0, 1);       /* an Amiga xid */
    pnet_sort_tx(&s, F, n, MAC, BOARD);
    n = dhcp(MAC, RMAC, ROUTER, BOARD, 2, 0xB0A4Du, BOARD, 5);      /* the board's renewal ACK */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    CHECK_EQ_INT(s.clash, 0);
    n = dhcp(MAC, RMAC, ROUTER, BOARD, 2, 0xB0A4Du, AMIGA, 5);      /* ...naming the Amiga's address */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    CHECK_EQ_INT(s.clash, 1);
}

static void a_clash_never_steals_the_boards_traffic(void) {
    pnet_sort_t s = fresh(BOARD);                                   /* the two ended up equal */
    size_t n = udp(MAC, RMAC, ROUTER, BOARD, 443, 50000, 40);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = arp(BCAST, RMAC, 1, ROUTER, BOARD);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
}

static void ipv6_short_and_odd_frames_stay_the_boards(void) {
    pnet_sort_t s = fresh(AMIGA);
    size_t n = eth(MAC, RMAC, 0x86DD);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, 60, BOARD), PNET_SORT_BOARD);
    (void)n;
    eth(MAC, RMAC, 0x8100);                                         /* VLAN-tagged */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, 60, BOARD), PNET_SORT_BOARD);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, 10, BOARD), PNET_SORT_BOARD);  /* shorter than a header */
    n = udp(MAC, RMAC, ROUTER, AMIGA, 53, 4000, 40);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, 30, BOARD), PNET_SORT_BOARD);  /* IPv4 header cut short */
    F[14] = 0x4F;                                                   /* IHL 60 bytes, frame shorter */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, 70, BOARD), PNET_SORT_BOARD);
    n = arp(BCAST, RMAC, 1, ROUTER, AMIGA);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, 40, BOARD), PNET_SORT_BOARD);  /* ARP cut short */
    CHECK_EQ_INT(s.to_amiga + s.to_both, 0);
}

static void dhcp_options_are_read_within_bounds(void) {
    pnet_sort_t s = fresh(0);
    size_t n = dhcp(BCAST, MAC, 0, IP(255, 255, 255, 255), 1, 9u, 0, 1);
    pnet_sort_tx(&s, F, n, MAC, BOARD);
    n = dhcp(BCAST, RMAC, ROUTER, IP(255, 255, 255, 255), 2, 9u, AMIGA, 5);
    F[42 + 240] = 0; F[42 + 241] = 0;                               /* two pad bytes, then type 5 */
    F[42 + 242] = 53; F[42 + 243] = 1; F[42 + 244] = 5; F[42 + 245] = 255;
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    CHECK_EQ_INT(s.amiga_ip, AMIGA);                                /* found past the pads */
    s.amiga_ip = 0;
    n = dhcp(BCAST, RMAC, ROUTER, IP(255, 255, 255, 255), 2, 9u, AMIGA, 5);
    F[42 + 240] = 12; F[42 + 241] = 250;                            /* a hostname running off the end */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, 42 + 260, BOARD), PNET_SORT_AMIGA);   /* still its xid */
    CHECK_EQ_INT(s.amiga_ip, 0);                                    /* but no type: not a lease */
    n = dhcp(BCAST, RMAC, ROUTER, IP(255, 255, 255, 255), 2, 9u, AMIGA, 5);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, 42 + 200, BOARD), PNET_SORT_BOARD);   /* BOOTP cut short */
}

static void only_the_last_four_xids_are_kept(void) {
    pnet_sort_t s = fresh(0);
    for (uint32_t x = 1; x <= 5; x++) {
        size_t n = dhcp(BCAST, MAC, 0, IP(255, 255, 255, 255), 1, x, 0, 1);
        pnet_sort_tx(&s, F, n, MAC, BOARD);
        pnet_sort_tx(&s, F, n, MAC, BOARD);                         /* a resend: not a new entry */
    }
    size_t n = dhcp(MAC, RMAC, ROUTER, AMIGA, 2, 1u, AMIGA, 2);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);   /* xid 1 has aged out */
    for (uint32_t x = 2; x <= 5; x++) {
        n = dhcp(MAC, RMAC, ROUTER, AMIGA, 2, x, AMIGA, 2);
        CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    }
}

static void tx_learns_the_amigas_address_and_refuses_what_cannot_go(void) {
    pnet_sort_t s = fresh(0);
    size_t n = arp(BCAST, MAC, 1, AMIGA, ROUTER);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    CHECK_EQ_INT(s.amiga_ip, AMIGA);
    n = arp(BCAST, RMAC, 1, AMIGA, ROUTER);                         /* someone else's MAC */
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_MAC);
    n = arp(BCAST, MAC, 1, BOARD, ROUTER);                          /* the board's address */
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_CLASH);
    n = udp(RMAC, MAC, BOARD, ROUTER, 4000, 53, 40);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_CLASH);
    eth(RMAC, MAC, 0x86DD);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, 60, MAC, BOARD), PNET_TX_TYPE);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, 13, MAC, BOARD), PNET_TX_LEN);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, 1519, MAC, BOARD), PNET_TX_LEN);
    n = udp(RMAC, MAC, IP(192, 168, 1, 58), ROUTER, 4000, 53, 40);  /* a new address: learned */
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    CHECK_EQ_INT(s.amiga_ip, IP(192, 168, 1, 58));
    n = arp(BCAST, MAC, 1, 0, ROUTER);                              /* an ARP probe: sent, teaches nothing */
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, 0), PNET_TX_SEND);
    CHECK_EQ_INT(s.amiga_ip, IP(192, 168, 1, 58));
}

static void client_id_is_appended_only_when_it_fits(void) {
    uint8_t o[68];
    memset(o, 0xEE, sizeof o);
    CHECK_EQ_INT(pnet_dhcp_client_id(o, 10, 67, MAC), 10 + PNET_CLIENT_ID_BYTES);
    static const uint8_t want[11] = {61, 9, 0x00, 'w', 'f', 0x28, 0xcd, 0xc1, 0x01, 0x02, 0x03};
    CHECK(memcmp(o + 10, want, 11) == 0, "61, 9, type 0, wf, MAC");
    CHECK_EQ_INT(o[9], 0xEE);
    CHECK_EQ_INT(o[21], 0xEE);
    CHECK_EQ_INT(pnet_dhcp_client_id(o, 56, 67, MAC), 67);          /* exactly fits */
    CHECK_EQ_INT(pnet_dhcp_client_id(o, 57, 67, MAC), 57);          /* one short: unchanged */
    CHECK_EQ_INT(pnet_dhcp_client_id(o, 70, 67, MAC), 70);          /* already past cap */
}

static void ip_text_is_a_dotted_quad(void) {
    char t[16];
    pnet_ip_text(AMIGA, t);
    CHECK(strcmp(t, "192.168.1.57") == 0, "192.168.1.57");
    pnet_ip_text(0, t);
    CHECK(strcmp(t, "0.0.0.0") == 0, "0.0.0.0");
    pnet_ip_text(0xFFFFFFFFu, t);
    CHECK(strcmp(t, "255.255.255.255") == 0, "15 characters and the NUL fit");
}

// Phase 4 spike (desk study 2026-10-15): the board and the Amiga share one MAC, so a frame between them never comes
// back from the radio. pnet_sort_a2b_local / pnet_sort_b2a_local pick out the frames that must be handed across
// locally instead.
static void a2b_local_is_arp_or_ipv4_for_the_boards_address(void) {
    size_t n = arp(BCAST, MAC, 1, AMIGA, BOARD);                 /* the Amiga asks for the board */
    CHECK(pnet_sort_a2b_local(F, n, BOARD), "ARP request for the board: local");
    n = arp(MAC, MAC, 2, AMIGA, BOARD);                          /* its reply to the board's request */
    CHECK(pnet_sort_a2b_local(F, n, BOARD), "ARP reply to the board: local");
    n = arp(BCAST, MAC, 1, AMIGA, ROUTER);
    CHECK(!pnet_sort_a2b_local(F, n, BOARD), "ARP for the router: the radio");
    n = ipv4(MAC, MAC, 1, AMIGA, BOARD, 64);                     /* ping the board */
    CHECK(pnet_sort_a2b_local(F, n + 64, BOARD), "IPv4 to the board: local");
    n = ipv4(RMAC, MAC, 6, AMIGA, IP(93, 184, 216, 34), 20);
    CHECK(!pnet_sort_a2b_local(F, n + 20, BOARD), "IPv4 to the internet: the radio");
    n = ipv4(MAC, MAC, 1, AMIGA, BOARD, 64);
    CHECK(!pnet_sort_a2b_local(F, n + 64, 0), "the board has no address yet: the radio");
    CHECK(!pnet_sort_a2b_local(F, 10, BOARD), "short: the radio");
}

static void b2a_local_is_arp_or_ipv4_for_the_amigas_address(void) {
    pnet_sort_t s = fresh(AMIGA);
    size_t n = arp(BCAST, MAC, 1, BOARD, AMIGA);                 /* the board asks for the Amiga */
    CHECK(pnet_sort_b2a_local(&s, F, n, BOARD), "ARP request for the Amiga: local");
    n = arp(MAC, MAC, 2, BOARD, AMIGA);                          /* the board answers the Amiga */
    CHECK(pnet_sort_b2a_local(&s, F, n, BOARD), "ARP reply to the Amiga: local");
    n = arp(BCAST, MAC, 1, BOARD, ROUTER);
    CHECK(!pnet_sort_b2a_local(&s, F, n, BOARD), "ARP for the router: the radio");
    n = ipv4(MAC, MAC, 6, BOARD, AMIGA, 20);                     /* a TCP SYN to the Amiga */
    CHECK(pnet_sort_b2a_local(&s, F, n + 20, BOARD), "IPv4 to the Amiga: local");
    n = ipv4(RMAC, MAC, 6, BOARD, IP(76, 76, 21, 21), 20);       /* the board's TLS to the server */
    CHECK(!pnet_sort_b2a_local(&s, F, n + 20, BOARD), "IPv4 elsewhere: the radio");
    pnet_sort_t none = fresh(0);
    n = ipv4(MAC, MAC, 6, BOARD, AMIGA, 20);
    CHECK(!pnet_sort_b2a_local(&none, F, n + 20, BOARD), "no Amiga known: the radio");
    pnet_sort_t same = fresh(BOARD);                             /* a clash is never the Amiga's */
    n = ipv4(MAC, MAC, 6, BOARD, BOARD, 20);
    CHECK(!pnet_sort_b2a_local(&same, F, n + 20, BOARD), "the Amiga's address is never the board's");
}

// Bench 2026-10-15: AmiTCP ignored the board's ARP replies (sender = its own MAC), so the board shows the Amiga a
// local MAC on the local path, and turns it back into the shared one on the way in.
static void the_local_path_disguises_the_boards_mac(void) {
    uint8_t L[6];
    pnet_local_mac(MAC, L);
    CHECK(memcmp(L, MAC, 6) != 0 && (L[0] ^ MAC[0]) == 0x02 && memcmp(L + 1, MAC + 1, 5) == 0, "one bit apart");
    size_t n = arp(MAC, MAC, 2, BOARD, AMIGA);                   /* the board's ARP reply to the Amiga */
    pnet_local_to_amiga(F, n, MAC);
    CHECK(memcmp(F + 6, L, 6) == 0, "Ethernet source -> local");
    CHECK(memcmp(F + 14 + 8, L, 6) == 0, "ARP sender -> local");
    CHECK(memcmp(F, MAC, 6) == 0, "the destination (the Amiga) untouched");
    n = ipv4(MAC, MAC, 1, BOARD, AMIGA, 64);                     /* an echo reply */
    pnet_local_to_amiga(F, n + 64, MAC);
    CHECK(memcmp(F + 6, L, 6) == 0 && memcmp(F, MAC, 6) == 0, "IPv4: source only");
    n = arp(L, MAC, 2, AMIGA, BOARD);                            /* the Amiga answers the board, to the local MAC */
    memcpy(F + 14 + 18, L, 6);                                   /* ARP target hardware address */
    pnet_local_to_board(F, n, MAC);
    CHECK(memcmp(F, MAC, 6) == 0, "Ethernet destination -> shared");
    CHECK(memcmp(F + 14 + 18, MAC, 6) == 0, "ARP target -> shared");
    CHECK(memcmp(F + 6, MAC, 6) == 0, "the Amiga's source untouched");
    n = ipv4(L, MAC, 1, AMIGA, BOARD, 64);                       /* an echo request to the local MAC */
    pnet_local_to_board(F, n + 64, MAC);
    CHECK(memcmp(F, MAC, 6) == 0, "IPv4: destination -> shared");
    n = arp(BCAST, MAC, 1, AMIGA, BOARD);                        /* a broadcast request: nothing to change */
    pnet_local_to_board(F, n, MAC);
    CHECK(memcmp(F, BCAST, 6) == 0 && memcmp(F + 6, MAC, 6) == 0, "broadcast untouched");
    pnet_local_to_amiga(F, 10, MAC);                             /* short: no read past the end (ASan-free run) */
}

int main(void) {
    RUN(arp_for_the_amiga_goes_to_both);
    RUN(ipv4_unicast_to_the_amiga_goes_to_the_amiga_only);
    RUN(an_offer_to_an_unknown_address_goes_by_xid);
    RUN(an_ack_naming_the_boards_address_is_refused);
    RUN(the_boards_own_dhcp_replies_stay_the_boards);
    RUN(a_clash_never_steals_the_boards_traffic);
    RUN(ipv6_short_and_odd_frames_stay_the_boards);
    RUN(dhcp_options_are_read_within_bounds);
    RUN(only_the_last_four_xids_are_kept);
    RUN(tx_learns_the_amigas_address_and_refuses_what_cannot_go);
    RUN(client_id_is_appended_only_when_it_fits);
    RUN(ip_text_is_a_dotted_quad);
    RUN(a2b_local_is_arp_or_ipv4_for_the_boards_address);
    RUN(b2a_local_is_arp_or_ipv4_for_the_amigas_address);
    RUN(the_local_path_disguises_the_boards_mac);
    return REPORT();
}
