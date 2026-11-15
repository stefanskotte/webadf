#include "harness.h"
#include "../src/pnet_shared.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* Shared-IP mode (pnet_shared.h; operator ruling 2026-11-15, "hybrid, with one IP"). Every frame here is built byte
 * by byte the way the real sender builds it: AmiTCP_NG's DHCP client (api/amiga_roadshow_compat.c ng_dhcp_exchange:
 * a 548-byte BOOTP message, the broadcast flag, client-id 01:<MAC>, a 5-entry parameter list), a phone hotspot's
 * dnsmasq OFFER/ACK with the broadcast flag and its usual options, lwIP's TCP SYNs, and a UDP datagram fragmented
 * at a 1500-byte MTU. Checksums are computed and verified by this file's own routine, not the firmware's. */

#define IP(a, b, c, d) ((uint32_t)(a) << 24 | (uint32_t)(b) << 16 | (uint32_t)(c) << 8 | (uint32_t)(d))
#define BOARD  IP(192, 168, 43, 5)      /* the hotspot's lease for the shared MAC */
#define HOTSPOT IP(192, 168, 43, 1)     /* gateway, DHCP server and DNS */
#define MASK   IP(255, 255, 255, 0)
#define SERVER IP(76, 76, 21, 21)       /* the board's TLS peer */
#define DNS2   IP(8, 8, 8, 8)
static const uint8_t MAC[6]   = {0x28, 0xcd, 0xc1, 0x0a, 0x0b, 0x0c};   /* the board's, shared with the Amiga */
static const uint8_t LMAC[6]  = {0x2a, 0xcd, 0xc1, 0x0a, 0x0b, 0x0c};   /* its local twin (0x02 flipped) */
static const uint8_t HMAC[6]  = {0x9e, 0x1f, 0x22, 0x33, 0x44, 0x55};   /* the hotspot's */
static const uint8_t BCAST[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};
static uint8_t F[3200], R[1600];

static void put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }
static void put32(uint8_t *p, uint32_t v) { put16(p, (uint16_t)(v >> 16)); put16(p + 2, (uint16_t)v); }
static uint16_t get16(const uint8_t *p) { return (uint16_t)(p[0] << 8 | p[1]); }
static uint32_t get32(const uint8_t *p) { return (uint32_t)get16(p) << 16 | get16(p + 2); }

/* ---- an independent Internet checksum (RFC 1071), byte by byte into a 64-bit sum ---- */
static uint64_t add_bytes(uint64_t acc, const uint8_t *p, size_t n) {
    for (size_t i = 0; i < n; i++) acc += (i & 1u) ? p[i] : (uint64_t)p[i] << 8;
    return acc;
}
static uint16_t finish(uint64_t acc) {
    while (acc > 0xFFFFu) acc = (acc & 0xFFFFu) + (acc >> 16);
    return (uint16_t)(~acc & 0xFFFFu);
}
/* The checksum over the header INCLUDING its checksum field: 0 when the stored value is right. */
static uint16_t ip_check(const uint8_t *f) { return finish(add_bytes(0, f + 14, (size_t)(f[14] & 15u) * 4u)); }
/* Same for TCP/UDP over the pseudo header and `l4len` bytes from the L4 header. */
static uint16_t l4_check(const uint8_t *f, size_t l4len) {
    const uint8_t *ip = f + 14;
    const size_t ihl = (size_t)(ip[0] & 15u) * 4u;
    uint64_t acc = add_bytes(0, ip + 12, 8);
    acc += ip[9];
    acc += l4len;
    return finish(add_bytes(acc, ip + ihl, l4len));
}
static void set_ip_csum(uint8_t *f) { put16(f + 24, 0); put16(f + 24, finish(add_bytes(0, f + 14, 20))); }
static void set_l4_csum(uint8_t *f, size_t at, size_t l4len) { put16(f + at, 0); put16(f + at, l4_check(f, l4len)); }

/* ---- frames ---- */
static size_t eth(uint8_t *f, const uint8_t *dst, const uint8_t *src, uint16_t type) {
    memcpy(f, dst, 6); memcpy(f + 6, src, 6); put16(f + 12, type);
    return 14;
}
static size_t arp(const uint8_t *dst, const uint8_t *src, uint16_t op, uint32_t spa, const uint8_t *tha, uint32_t tpa) {
    memset(F, 0, 60);
    uint8_t *a = F + eth(F, dst, src, 0x0806);
    put16(a, 1); put16(a + 2, 0x0800); a[4] = 6; a[5] = 4; put16(a + 6, op);
    memcpy(a + 8, src, 6); put32(a + 14, spa);
    if (tha) memcpy(a + 18, tha, 6);
    put32(a + 24, tpa);
    return 60;                                               /* padded to the Ethernet minimum, as on the wire */
}
/* IPv4 header at 14: total length 20 + l4, id, flags/offset word, checksum set. */
static void ipv4(const uint8_t *dst, const uint8_t *src, uint8_t proto, uint32_t sip, uint32_t dip, size_t l4,
                 uint16_t id, uint16_t frag) {
    eth(F, dst, src, 0x0800);
    uint8_t *ip = F + 14;
    memset(ip, 0, 20);
    ip[0] = 0x45; put16(ip + 2, (uint16_t)(20 + l4)); put16(ip + 4, id); put16(ip + 6, frag);
    ip[8] = 64; ip[9] = proto; put32(ip + 12, sip); put32(ip + 16, dip);
    set_ip_csum(F);
}
static size_t udp(const uint8_t *dst, const uint8_t *src, uint32_t sip, uint32_t dip, uint16_t sp, uint16_t dp,
                  size_t plen) {
    ipv4(dst, src, 17, sip, dip, 8 + plen, 0x1234, 0x4000);
    uint8_t *u = F + 34;
    put16(u, sp); put16(u + 2, dp); put16(u + 4, (uint16_t)(8 + plen));
    for (size_t i = 0; i < plen; i++) u[8 + i] = (uint8_t)(i * 7u + 3u);
    set_l4_csum(F, 40, 8 + plen);
    return 34 + 8 + plen;
}
/* A TCP segment with the MSS option (a SYN, as lwIP sends it) or none. */
static size_t tcp(const uint8_t *dst, const uint8_t *src, uint32_t sip, uint32_t dip, uint16_t sp, uint16_t dp,
                  uint8_t flags, size_t plen) {
    const size_t hl = flags & 0x02u ? 24u : 20u;
    ipv4(dst, src, 6, sip, dip, hl + plen, 0x0101, 0x0000);
    uint8_t *t = F + 34;
    memset(t, 0, hl + plen);
    put16(t, sp); put16(t + 2, dp); put32(t + 4, 0x6000AA01u); put32(t + 8, flags & 0x10u ? 0x00C0FFEEu : 0);
    t[12] = (uint8_t)((hl / 4u) << 4); t[13] = flags; put16(t + 14, 5840);
    if (hl == 24u) { t[20] = 2; t[21] = 4; put16(t + 22, 1460); }
    for (size_t i = 0; i < plen; i++) t[hl + i] = (uint8_t)(0xA0u + i);
    set_l4_csum(F, 50, hl + plen);
    return 34 + hl + plen;
}
static size_t icmp(const uint8_t *dst, const uint8_t *src, uint32_t sip, uint32_t dip, uint8_t type, uint8_t code,
                   const uint8_t *quote, size_t qlen) {
    ipv4(dst, src, 1, sip, dip, 8 + qlen, 0x0202, 0);
    uint8_t *c = F + 34;
    memset(c, 0, 8);
    c[0] = type; c[1] = code;
    if (type == 0 || type == 8) { put16(c + 4, 0x0077); put16(c + 6, 1); }
    if (quote) memcpy(c + 8, quote, qlen);
    put16(c + 2, finish(add_bytes(0, c, 8 + qlen)));
    return 34 + 8 + qlen;
}

/* AmiTCP_NG's DISCOVER or REQUEST (ng_dhcp_exchange): the whole 548-byte struct dhcp_pkt, the broadcast flag, from
 * 0.0.0.0 to 255.255.255.255. REQUEST adds 50 (requested) and 54 (server id). */
static size_t amitcp_dhcp(uint8_t type, uint32_t xid, uint32_t want, uint32_t sid) {
    memset(F, 0, sizeof F);
    const size_t blen = 548;
    ipv4(BCAST, MAC, 17, 0, 0xFFFFFFFFu, 8 + blen, 0, 0);
    uint8_t *u = F + 34;
    put16(u, 68); put16(u + 2, 67); put16(u + 4, (uint16_t)(8 + blen));
    uint8_t *b = u + 8;
    b[0] = 1; b[1] = 1; b[2] = 6;
    put32(b + 4, xid); put16(b + 10, 0x8000);
    memcpy(b + 28, MAC, 6);
    uint8_t *o = b + 236;
    put32(o, 0x63825363u); o += 4;
    *o++ = 53; *o++ = 1; *o++ = type;
    *o++ = 61; *o++ = 7; *o++ = 1; memcpy(o, MAC, 6); o += 6;          /* HTYPE_ETHER + the MAC */
    if (type == 3) { *o++ = 50; *o++ = 4; put32(o, want); o += 4; *o++ = 54; *o++ = 4; put32(o, sid); o += 4; }
    *o++ = 55; *o++ = 5; *o++ = 1; *o++ = 3; *o++ = 6; *o++ = 15; *o++ = 12;
    *o++ = 255;
    set_l4_csum(F, 40, 8 + blen);
    return 34 + 8 + blen;
}

/* The hotspot's (dnsmasq-style) OFFER or ACK: the broadcast flag honoured, 300-byte BOOTP, its usual options. */
static size_t hotspot_reply(uint8_t type, uint32_t xid, uint32_t yi) {
    memset(F, 0, sizeof F);
    const size_t blen = 300;
    ipv4(BCAST, HMAC, 17, HOTSPOT, 0xFFFFFFFFu, 8 + blen, 0, 0x4000);
    uint8_t *u = F + 34;
    put16(u, 67); put16(u + 2, 68); put16(u + 4, (uint16_t)(8 + blen));
    uint8_t *b = u + 8;
    b[0] = 2; b[1] = 1; b[2] = 6;
    put32(b + 4, xid); put16(b + 10, 0x8000);
    put32(b + 16, yi); put32(b + 20, HOTSPOT);
    memcpy(b + 28, MAC, 6);
    uint8_t *o = b + 236;
    put32(o, 0x63825363u); o += 4;
    *o++ = 53; *o++ = 1; *o++ = type;
    *o++ = 54; *o++ = 4; put32(o, HOTSPOT); o += 4;
    *o++ = 51; *o++ = 4; put32(o, 3600); o += 4;
    *o++ = 58; *o++ = 4; put32(o, 1800); o += 4;
    *o++ = 59; *o++ = 4; put32(o, 3150); o += 4;
    *o++ = 1;  *o++ = 4; put32(o, MASK); o += 4;
    *o++ = 28; *o++ = 4; put32(o, IP(192, 168, 43, 255)); o += 4;
    *o++ = 3;  *o++ = 4; put32(o, HOTSPOT); o += 4;
    *o++ = 6;  *o++ = 4; put32(o, HOTSPOT); o += 4;
    *o++ = 255;
    set_l4_csum(F, 40, 8 + blen);
    return 34 + 8 + blen;
}

/* What the glue hands the builder: the board's lease on the hotspot. */
static pnet_lease_t lease(void) {
    pnet_lease_t L = { .ip = BOARD, .mask = MASK, .gw = HOTSPOT, .dns = {HOTSPOT, DNS2}, .server = HOTSPOT };
    memcpy(L.mac, MAC, 6);
    return L;
}

/* lwIP's pcbs, faked: a TLS connection to the server, a DNS query port, the DHCP client, a TEST listener. */
typedef struct { uint8_t proto; uint16_t lport; uint32_t rip; uint16_t rport; } tuple_t;
static const tuple_t PCBS[] = {
    {6, 0x8123, SERVER, 443},        /* tcp_active_pcbs: the board's TLS (lwIP's new range) */
    {6, 6801, 0, 0},                 /* tcp_listen_pcbs: TEST builds' discard service */
    {6, 0x8200, SERVER, 443},        /* tcp_tw_pcbs: a closed one in TIME_WAIT */
    {17, 0x9ABC, 0, 0},              /* a DNS query pcb, bound, unconnected */
    {17, 68, 0, 0},                  /* the DHCP client */
};
static int owns_calls;
static bool fake_owns(void *ctx, uint8_t proto, uint16_t lport, uint32_t rip, uint16_t rport) {
    (void)ctx;
    owns_calls++;
    for (size_t i = 0; i < sizeof PCBS / sizeof PCBS[0]; i++) {
        const tuple_t *t = &PCBS[i];
        if (t->proto != proto || t->lport != lport) continue;
        if (t->rip == 0 || (t->rip == rip && t->rport == rport)) return true;
    }
    return false;
}

static pnet_sort_t fresh(void) {
    pnet_sort_t s;
    pnet_sort_init(&s);
    s.owns = fake_owns;
    return s;
}
/* Shared mode the way a hotspot turns it on: the Amiga's DISCOVER goes out, the OFFER names the board's address. */
static pnet_sort_t shared_by_offer(uint32_t xid) {
    pnet_sort_t s = fresh();
    size_t n = amitcp_dhcp(1, xid, 0, 0);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);   /* not shared yet: to the radio */
    n = hotspot_reply(2, xid, BOARD);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_DROP);
    return s;
}

/* A DHCP option in a reply this test reads (its own scanner, not the firmware's): offset of the value, or 0. */
static size_t opt_at(const uint8_t *f, size_t len, uint8_t code, size_t *olen) {
    size_t i = 42 + 240;
    while (i + 1 < len && f[i] != 255) {
        if (f[i] == 0) { i++; continue; }
        if (f[i] == code) { *olen = f[i + 1]; return i + 2; }
        i += 2u + f[i + 1];
    }
    return 0;
}
/* The options run, TLV by TLV, from the cookie to an END inside the frame, as AmiTCP_NG's dhcp_find reads them
 * (and within its 312-byte buffer). */
static bool options_end_inside(const uint8_t *f, size_t n) {
    size_t i = 42 + 240;
    while (i < n) {
        if (f[i] == 255) return i - (42 + 236) < 312;
        if (f[i] == 0) { i++; continue; }
        if (i + 1 >= n) return false;
        i += 2u + f[i + 1];
    }
    return false;
}
static void check_reply(const uint8_t *r, size_t n, uint8_t type, uint32_t xid, uint32_t yi, const char *what) {
    printf("  (%s)\n", what);
    CHECK(n >= PNET_DHCP_REPLY_MIN && n <= PNET_DHCP_REPLY_MAX, "a reply's length");
    CHECK(memcmp(r, BCAST, 6) == 0, "to the broadcast MAC (AmiTCP_NG sets the broadcast flag)");
    CHECK(memcmp(r + 6, LMAC, 6) == 0, "from the local MAC twin, never the shared one");
    CHECK_EQ_INT(get16(r + 12), 0x0800);
    CHECK_EQ_INT(r[14], 0x45);
    CHECK_EQ_INT(get16(r + 16), n - 14);                    /* IPv4 total length: the whole frame */
    CHECK_EQ_INT(r[23], 17);
    CHECK_EQ_INT(ip_check(r), 0);                           /* IPv4 header checksum, independently */
    CHECK_EQ_INT(get32(r + 26), HOTSPOT);                   /* from the network's DHCP server id */
    CHECK_EQ_INT(get32(r + 30), 0xFFFFFFFFu);
    CHECK_EQ_INT(get16(r + 34), 67); CHECK_EQ_INT(get16(r + 36), 68); CHECK_EQ_INT(get16(r + 38), n - 34);
    CHECK(get16(r + 40) != 0, "a UDP checksum is sent");
    CHECK_EQ_INT(l4_check(r, n - 34), 0);                   /* UDP checksum, independently */
    CHECK(options_end_inside(r, n), "the options end with END inside the frame");
    const uint8_t *b = r + 42;
    CHECK_EQ_INT(b[0], 2); CHECK_EQ_INT(b[1], 1); CHECK_EQ_INT(b[2], 6);
    CHECK_EQ_INT(get32(b + 4), xid);
    CHECK_EQ_INT(get16(b + 10), 0x8000);
    CHECK_EQ_INT(get32(b + 12), 0);
    CHECK_EQ_INT(get32(b + 16), yi);
    CHECK(memcmp(b + 28, MAC, 6) == 0, "chaddr: the shared MAC");
    CHECK_EQ_INT(get32(b + 236), 0x63825363u);
    size_t ol = 0, at = opt_at(r, n, 53, &ol);
    CHECK(at && ol == 1 && r[at] == type, "option 53: the type");
    at = opt_at(r, n, 54, &ol);
    CHECK(at && ol == 4 && get32(r + at) == HOTSPOT, "option 54: the server id AmiTCP_NG keeps");
}

/* ---- the DHCP server ---- */

static void a_hotspot_offer_of_the_boards_address_is_answered_by_the_board(void) {
    pnet_sort_t s = shared_by_offer(0x414d4954u ^ 0x00C01234u);   /* 'AMIT' ^ ctx, as AmiTCP_NG makes it */
    const uint32_t xid = 0x414d4954u ^ 0x00C01234u;
    CHECK(s.sh.on && s.sh.why == PNET_SHARED_OFFER, "the OFFER turned shared mode on");
    CHECK(!s.sh.amiga, "the Amiga does not use the address yet");
    CHECK_EQ_INT(pnet_sort_send_ip(&s), 0);                 /* nothing to connect to yet */
    const pnet_lease_t L = lease();
    memset(R, 0xEE, sizeof R);
    size_t n = pnet_shared_owed(&s, &L, R, sizeof R);
    check_reply(R, n, 2, xid, BOARD, "the owed OFFER");
    size_t ol = 0, at = opt_at(R, n, 51, &ol);
    CHECK(at && ol == 4 && get32(R + at) == PNET_SHARED_LEASE_S, "option 51: a short lease");
    at = opt_at(R, n, 1, &ol);
    CHECK(at && get32(R + at) == MASK, "option 1: the mask");
    at = opt_at(R, n, 3, &ol);
    CHECK(at && get32(R + at) == HOTSPOT, "option 3: the gateway");
    at = opt_at(R, n, 6, &ol);
    CHECK(at && ol == 8 && get32(R + at) == HOTSPOT && get32(R + at + 4) == DNS2, "option 6: both DNS servers");
    CHECK_EQ_INT(R[n], 0xEE);             /* nothing written past the reply */
    CHECK_EQ_INT(pnet_shared_owed(&s, &L, R, sizeof R), 0); /* owed once */
    CHECK_EQ_INT(s.sh.offers, 1);

    /* The Amiga's REQUEST (option 50 the board's address, 54 the server id it kept): never to the radio, ACKed. */
    n = amitcp_dhcp(3, xid, BOARD, HOTSPOT);
    CHECK_EQ_INT(l4_check(F, n - 34), 0);                   /* the fixture itself is a valid datagram */
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    CHECK(pnet_shared_is_dhcp(&s, F, n), "a BOOTREQUEST in shared mode is the board's to answer");
    size_t m = pnet_shared_dhcp_reply(&s, F, n, &L, R, sizeof R);
    check_reply(R, m, 5, xid, BOARD, "the ACK");
    at = opt_at(R, m, 61, &ol);
    CHECK(at && ol == 7 && R[at] == 1 && memcmp(R + at + 1, MAC, 6) == 0, "the client-id echoed (RFC 6842)");
    CHECK(s.sh.amiga, "ACKed: the Amiga uses the shared address");
    CHECK_EQ_INT(pnet_sort_send_ip(&s), PNET_SHARED_AMIGA);
    CHECK_EQ_INT(s.sh.acks, 1);

    /* A REQUEST for an address that is not the board's: NAK, so AmiTCP_NG restarts at DISCOVER. */
    n = amitcp_dhcp(3, xid, IP(192, 168, 43, 77), HOTSPOT);
    m = pnet_shared_dhcp_reply(&s, F, n, &L, R, sizeof R);
    check_reply(R, m, 6, xid, 0, "the NAK");
    CHECK(opt_at(R, m, 51, &ol) == 0, "a NAK carries no lease");
    CHECK_EQ_INT(s.sh.naks, 1);

    /* A fresh DISCOVER (the Amiga rebooted): OFFER at once. */
    n = amitcp_dhcp(1, 0x1111u, 0, 0);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    m = pnet_shared_dhcp_reply(&s, F, n, &L, R, sizeof R);
    check_reply(R, m, 2, 0x1111u, BOARD, "a new DISCOVER's OFFER");
    /* RELEASE: no answer. */
    n = amitcp_dhcp(7, 0x1111u, 0, 0);
    CHECK_EQ_INT(pnet_shared_dhcp_reply(&s, F, n, &L, R, sizeof R), 0);
    CHECK_EQ_INT(pnet_shared_dhcp_reply(&s, F, n, &L, R, 100), 0);   /* and never past a short buffer */
    n = amitcp_dhcp(1, 0x2222u, 0, 0);
    CHECK_EQ_INT(pnet_shared_dhcp_reply(&s, F, n, &L, R, PNET_DHCP_REPLY_MIN - 1), 0);
    /* The hotspot's late ACK to the Amiga's earlier REQUEST: dropped, the board answered it. */
    n = hotspot_reply(5, xid, BOARD);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_DROP);
    CHECK(s.sh.late >= 1, "counted");
}

static void a_unicast_reply_without_the_broadcast_flag_goes_to_the_amigas_mac(void) {
    pnet_sort_t s = shared_by_offer(5u);
    const pnet_lease_t L = lease();
    size_t n = amitcp_dhcp(1, 6u, 0, 0);
    put16(F + 42 + 10, 0);                                  /* a client without the broadcast flag */
    set_l4_csum(F, 40, n - 34);
    pnet_sort_tx(&s, F, n, MAC, BOARD);
    size_t m = pnet_shared_dhcp_reply(&s, F, n, &L, R, sizeof R);
    CHECK_EQ_INT(m, PNET_DHCP_REPLY_MIN);
    CHECK(memcmp(R, MAC, 6) == 0, "to chaddr");
    CHECK_EQ_INT(get32(R + 30), BOARD);                     /* to yiaddr */
    CHECK_EQ_INT(ip_check(R), 0);
    CHECK_EQ_INT(l4_check(R, m - 34), 0);
    pnet_lease_t lone = L;                                  /* no DHCP server id known: the gateway stands in */
    lone.server = 0; lone.dns[1] = 0;
    m = pnet_shared_dhcp_reply(&s, F, n, &lone, R, sizeof R);
    size_t ol = 0, at = opt_at(R, m, 54, &ol);
    CHECK(at && get32(R + at) == HOTSPOT, "server id: the gateway");
    at = opt_at(R, m, 6, &ol);
    CHECK(at && ol == 4, "one DNS server");
}

static void no_reply_without_the_boards_address(void) {
    pnet_sort_t s = shared_by_offer(5u);
    pnet_lease_t L = lease();
    L.ip = 0;                                               /* the link is down */
    size_t n = amitcp_dhcp(1, 6u, 0, 0);
    CHECK_EQ_INT(pnet_shared_dhcp_reply(&s, F, n, &L, R, sizeof R), 0);
    CHECK_EQ_INT(pnet_shared_owed(&s, &L, R, sizeof R), 0);
    CHECK(s.sh.owe, "still owed while the board has no address");
    pnet_shared_follow(&s, 0);
    CHECK(s.sh.on, "an address of 0 does not end shared mode");
}

/* ---- inbound demux ---- */

static pnet_sort_t shared_and_acked(void) {
    pnet_sort_t s = shared_by_offer(5u);
    const pnet_lease_t L = lease();
    size_t n = amitcp_dhcp(3, 5u, BOARD, HOTSPOT);
    pnet_sort_tx(&s, F, n, MAC, BOARD);
    CHECK(pnet_shared_dhcp_reply(&s, F, n, &L, R, sizeof R) != 0, "ACKed");
    return s;
}

static void tcp_and_udp_go_to_whoever_holds_the_pcb(void) {
    pnet_sort_t s = shared_and_acked();
    size_t n = tcp(MAC, HMAC, SERVER, BOARD, 443, 0x8123, 0x18, 100);   /* the board's TLS */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = tcp(MAC, HMAC, SERVER, BOARD, 443, 0xC123, 0x18, 100);           /* the Amiga's (AmiTCP_NG's range) */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    n = tcp(MAC, HMAC, IP(1, 2, 3, 4), BOARD, 443, 0x8123, 0x18, 10);   /* the board's port, another peer */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    n = tcp(MAC, HMAC, SERVER, BOARD, 443, 0x8200, 0x11, 0);            /* a FIN for a TIME_WAIT pcb */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = tcp(MAC, HMAC, IP(192, 168, 43, 9), BOARD, 40000, 6801, 0x02, 0);   /* a SYN to the board's listener */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = tcp(MAC, HMAC, IP(192, 168, 43, 9), BOARD, 40000, 6800, 0x02, 0);   /* to Transfer, from the LAN */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    n = udp(MAC, HMAC, HOTSPOT, BOARD, 53, 0x9ABC, 60);                 /* lwIP's DNS answer */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = udp(MAC, HMAC, HOTSPOT, BOARD, 53, 50123, 60);                  /* AmiTCP_NG's DNS answer */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    n = hotspot_reply(5, 0xB0A4Du, BOARD);                               /* the board's own renewal ACK */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = udp(MAC, HMAC, SERVER, IP(192, 168, 43, 6), 443, 0xC123, 20);   /* unicast, not ours */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    pnet_sort_t none = shared_and_acked();
    none.owns = NULL;                                      /* no callback: nothing is the board's */
    n = tcp(MAC, HMAC, SERVER, BOARD, 443, 0x8123, 0x18, 10);
    CHECK_EQ_INT(pnet_sort_rx(&none, F, n, BOARD), PNET_SORT_AMIGA);
    n = tcp(MAC, HMAC, SERVER, BOARD, 443, 0x8123, 0x18, 10);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, 37, BOARD), PNET_SORT_BOARD);      /* L4 header cut short: the board's */
}

static void icmp_by_type_and_errors_by_their_quote(void) {
    pnet_sort_t s = shared_and_acked();
    size_t n = icmp(MAC, HMAC, HOTSPOT, BOARD, 8, 0, (const uint8_t *)"ping-payload-32-bytes-0123456789", 32);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);       /* echo request: lwIP answers */
    n = icmp(MAC, HMAC, IP(8, 8, 8, 8), BOARD, 0, 0, (const uint8_t *)"ping-payload-32-bytes-0123456789", 32);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);       /* echo reply: the Amiga pinged */
    /* Port unreachable quoting the Amiga's UDP (its port 50123 to 9.9.9.9:53). */
    static uint8_t q[28];
    tcp(HMAC, MAC, BOARD, IP(9, 9, 9, 9), 50123, 53, 0x18, 0);
    memcpy(q, F + 14, 20); q[9] = 17; put16(q + 20, 50123); put16(q + 22, 53); put16(q + 24, 8); put16(q + 26, 0);
    n = icmp(MAC, HMAC, IP(9, 9, 9, 9), BOARD, 3, 3, q, sizeof q);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    /* Fragmentation needed quoting the board's TLS segment. */
    q[9] = 6; put16(q + 20, 0x8123); put16(q + 22, 443); put32(q + 24, 0x6000AA01u);
    put32(q + 16, SERVER);
    n = icmp(MAC, HMAC, HOTSPOT, BOARD, 3, 4, q, sizeof q);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    q[9] = 1;                                              /* time exceeded for an ICMP query: the Amiga's */
    n = icmp(MAC, HMAC, HOTSPOT, BOARD, 11, 0, q, sizeof q);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    q[9] = 6;
    n = icmp(MAC, HMAC, HOTSPOT, BOARD, 3, 4, q, 20);       /* the quote cut before the ports */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = icmp(MAC, HMAC, HOTSPOT, BOARD, 13, 0, NULL, 12);   /* a timestamp request: lwIP's to ignore */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
}

static void arp_for_the_shared_address_is_the_boards_unless_it_is_a_reply(void) {
    pnet_sort_t s = shared_and_acked();
    size_t n = arp(BCAST, HMAC, 1, HOTSPOT, NULL, BOARD);  /* who has the shared address? lwIP answers, once */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = arp(MAC, HMAC, 2, HOTSPOT, MAC, BOARD);            /* the gateway's reply: both resolve their next hop */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOTH);
    static const uint8_t OTHER[6] = {0x00, 0x16, 0x3e, 0x01, 0x02, 0x03};
    n = arp(BCAST, OTHER, 1, BOARD, NULL, BOARD);          /* another host claims the shared address */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);       /* AmiTCP would log "duplicate IP" */
    n = arp(MAC, OTHER, 2, BOARD, MAC, BOARD);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    CHECK_EQ_INT(s.sh.arp_hidden, 2);
    n = arp(BCAST, HMAC, 1, HOTSPOT, NULL, IP(192, 168, 43, 9));
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
}

/* Review M1: the slow Paula link gets only the broadcasts the Amiga may need. */
static void only_udp_broadcasts_to_ports_lwip_does_not_own_reach_the_amiga(void) {
    pnet_sort_t s = shared_and_acked();
    const uint32_t to0 = s.to_amiga, both0 = s.to_both;
    size_t n = udp(BCAST, HMAC, IP(192, 168, 43, 9), 0xFFFFFFFFu, 137, 137, 50);            /* limited */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    n = udp(BCAST, HMAC, IP(192, 168, 43, 9), IP(192, 168, 43, 255), 9, 4000, 50);           /* subnet-directed */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    n = udp(BCAST, HMAC, IP(192, 168, 43, 9), 0xFFFFFFFFu, 4000, 0x9ABC, 50);               /* a board-owned port */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    static const uint8_t MCAST[6] = {0x01, 0x00, 0x5e, 0x00, 0x00, 0xfb};
    n = udp(MCAST, HMAC, IP(192, 168, 43, 9), IP(224, 0, 0, 251), 5353, 5353, 50);           /* mDNS */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    static const uint8_t SSDP[6] = {0x01, 0x00, 0x5e, 0x7f, 0xff, 0xfa};
    n = udp(SSDP, HMAC, IP(192, 168, 43, 9), IP(239, 255, 255, 250), 1900, 1900, 50);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = udp(BCAST, HMAC, IP(192, 168, 43, 9), IP(224, 0, 0, 1), 5000, 5000, 50);            /* multicast IP */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = icmp(BCAST, HMAC, IP(192, 168, 43, 9), 0xFFFFFFFFu, 8, 0, NULL, 8);                 /* not UDP */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = udp(BCAST, HMAC, IP(192, 168, 43, 9), 0xFFFFFFFFu, 137, 137, 50);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, 37, BOARD), PNET_SORT_BOARD);                          /* ports cut off */
    CHECK_EQ_INT(s.to_amiga - to0, 2);
    CHECK_EQ_INT(s.to_both - both0, 0);
}

/* A 3000-byte UDP datagram at a 1500-byte MTU: three fragments of 1480, 1480 and 48 bytes, built from one datagram
 * whose UDP checksum covers it whole. Returns the length of fragment k (0, 1, 2) left in F. */
static size_t fragment(uint32_t src, uint16_t sport, uint16_t dport, uint16_t id, int k) {
    static uint8_t dgram[3008];
    put16(dgram, sport); put16(dgram + 2, dport); put16(dgram + 4, 3008); put16(dgram + 6, 0);
    for (size_t i = 8; i < sizeof dgram; i++) dgram[i] = (uint8_t)(i ^ 0x5Au);
    uint64_t acc = 0;                                       /* the whole datagram's checksum, pseudo header first */
    uint8_t ph[8]; put32(ph, src); put32(ph + 4, BOARD);
    acc = add_bytes(acc, ph, 8); acc += 17; acc += sizeof dgram;
    put16(dgram + 6, finish(add_bytes(acc, dgram, sizeof dgram)));
    const size_t off = (size_t)k * 1480u, len = k < 2 ? 1480u : sizeof dgram - 2u * 1480u;
    ipv4(MAC, HMAC, 17, src, BOARD, len, id, (uint16_t)((k < 2 ? 0x2000u : 0u) | (off / 8u)));
    memcpy(F + 34, dgram + off, len);
    return 34 + len;
}

static void fragments_follow_their_first(void) {
    pnet_sort_t s = shared_and_acked();
    size_t n = fragment(HOTSPOT, 53, 50123, 0x7001, 0);    /* a big DNS answer to the Amiga */
    CHECK_EQ_INT(ip_check(F), 0);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    n = fragment(HOTSPOT, 53, 50123, 0x7002, 0);           /* ...and one to lwIP's DNS port, interleaved */
    put16(F + 34 + 2, 0x9ABC);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = fragment(HOTSPOT, 53, 50123, 0x7001, 1);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    n = fragment(HOTSPOT, 53, 50123, 0x7002, 1);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = fragment(HOTSPOT, 53, 50123, 0x7001, 2);           /* the last: the datagram is forgotten */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    n = fragment(HOTSPOT, 53, 50123, 0x7002, 2);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = fragment(HOTSPOT, 53, 50123, 0x7001, 1);           /* a duplicate after the last: no owner */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_DROP);
    n = fragment(IP(9, 9, 9, 9), 53, 50123, 0x7001, 1);    /* same id, another source: never confused */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_DROP);
    CHECK_EQ_INT(s.sh.frag_drops, 2);
    for (uint16_t id = 0x100; id < 0x100 + PNET_SORT_FRAGS + 1u; id++) {   /* the table holds the last four */
        n = fragment(HOTSPOT, 53, 50123, id, 0);
        pnet_sort_rx(&s, F, n, BOARD);
    }
    n = fragment(HOTSPOT, 53, 50123, 0x100, 1);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_DROP);   /* aged out */
    n = fragment(HOTSPOT, 53, 50123, 0x100 + PNET_SORT_FRAGS, 1);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
}

/* ---- outbound ---- */

static void the_amiga_may_send_from_the_shared_address(void) {
    pnet_sort_t s = shared_by_offer(5u);
    size_t n = arp(BCAST, MAC, 1, BOARD, NULL, HOTSPOT);   /* the Amiga resolves its gateway */
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    CHECK(s.sh.amiga, "seen using the shared address");
    n = tcp(HMAC, MAC, BOARD, SERVER, 0xC001, 80, 0x02, 0);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    CHECK(!pnet_shared_is_dhcp(&s, F, n), "not DHCP");
    CHECK(!pnet_shared_a2b(&s, F, n), "not for the board");
    eth(F, HMAC, MAC, 0x86DD);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, 60, MAC, BOARD), PNET_TX_TYPE);
    n = arp(BCAST, HMAC, 1, BOARD, NULL, HOTSPOT);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_MAC);   /* never another MAC */
}

/* ---- the local path ---- */

static void the_local_path_gives_the_bus_a_private_pair(void) {
    pnet_sort_t s = shared_and_acked();
    /* lwIP ARPs for 169.254.77.2 (link-local: directly, never via the gateway). */
    size_t n = arp(BCAST, MAC, 1, BOARD, NULL, PNET_SHARED_AMIGA);
    CHECK(pnet_shared_b2a(&s, F, n), "the board's ARP for the Amiga's bus address: local");
    CHECK(!pnet_sort_b2a_local(&s, F, n, BOARD), "the normal-mode rule does not take it");
    pnet_shared_to_amiga(F, n, BOARD, MAC);
    CHECK(memcmp(F + 6, LMAC, 6) == 0 && memcmp(F + 22, LMAC, 6) == 0, "Ethernet source and ARP sender: local MAC");
    CHECK_EQ_INT(get32(F + 28), PNET_SHARED_BOARD);          /* who asks: 169.254.77.1 */
    CHECK_EQ_INT(get32(F + 38), BOARD);                      /* for: the Amiga's own address */
    /* The Amiga answers 169.254.77.1 at the local MAC. */
    n = arp(LMAC, MAC, 2, BOARD, LMAC, PNET_SHARED_BOARD);
    CHECK(pnet_shared_a2b(&s, F, n), "its ARP reply: local");
    pnet_shared_to_board(F, n, BOARD, MAC);
    CHECK(memcmp(F, MAC, 6) == 0 && memcmp(F + 32, MAC, 6) == 0, "Ethernet destination and ARP target: shared");
    CHECK_EQ_INT(get32(F + 28), PNET_SHARED_AMIGA);
    CHECK_EQ_INT(get32(F + 38), BOARD);
    /* The board's SYN to Transfer, rewritten; both checksums verified independently. */
    n = tcp(MAC, MAC, BOARD, PNET_SHARED_AMIGA, 0x8044, 6800, 0x02, 0);
    CHECK_EQ_INT(l4_check(F, n - 34), 0);
    CHECK(pnet_shared_b2a(&s, F, n), "the SYN: local");
    pnet_shared_to_amiga(F, n, BOARD, MAC);
    CHECK_EQ_INT(get32(F + 26), PNET_SHARED_BOARD);
    CHECK_EQ_INT(get32(F + 30), BOARD);
    CHECK_EQ_INT(ip_check(F), 0);
    CHECK_EQ_INT(l4_check(F, n - 34), 0);
    CHECK(memcmp(F + 6, LMAC, 6) == 0, "from the local MAC");
    /* The Amiga's SYN-ACK: it routes 169.254.77.1 via its gateway, so the Ethernet destination is the hotspot's. */
    n = tcp(HMAC, MAC, BOARD, PNET_SHARED_BOARD, 6800, 0x8044, 0x12, 0);
    CHECK(pnet_shared_a2b(&s, F, n), "the SYN-ACK: local, whatever its Ethernet destination");
    CHECK(!pnet_sort_a2b_local(F, n, BOARD), "the normal-mode rule does not take it");
    pnet_shared_to_board(F, n, BOARD, MAC);
    CHECK(memcmp(F, MAC, 6) == 0, "to the shared MAC, so lwIP takes it");
    CHECK_EQ_INT(get32(F + 26), PNET_SHARED_AMIGA);
    CHECK_EQ_INT(get32(F + 30), BOARD);
    CHECK_EQ_INT(ip_check(F), 0);
    CHECK_EQ_INT(l4_check(F, n - 34), 0);
    /* Transfer's reply line, 300 bytes of payload. */
    n = tcp(HMAC, MAC, BOARD, PNET_SHARED_BOARD, 6800, 0x8044, 0x18, 300);
    pnet_shared_to_board(F, n, BOARD, MAC);
    CHECK_EQ_INT(ip_check(F), 0);
    CHECK_EQ_INT(l4_check(F, n - 34), 0);
    /* UDP: a checksum is kept valid; 0 ("none") stays 0. */
    n = udp(MAC, MAC, BOARD, PNET_SHARED_AMIGA, 0x8100, 6801, 33);
    pnet_shared_to_amiga(F, n, BOARD, MAC);
    CHECK_EQ_INT(ip_check(F), 0);
    CHECK_EQ_INT(l4_check(F, n - 34), 0);
    n = udp(MAC, MAC, BOARD, PNET_SHARED_AMIGA, 0x8100, 6801, 33);
    put16(F + 40, 0);
    pnet_shared_to_amiga(F, n, BOARD, MAC);
    CHECK_EQ_INT(get16(F + 40), 0);
    CHECK_EQ_INT(ip_check(F), 0);
    /* An echo request from the Amiga to the board: ICMP has no pseudo header, only the IP checksum moves. */
    n = icmp(HMAC, MAC, BOARD, PNET_SHARED_BOARD, 8, 0, (const uint8_t *)"abcdefgh", 8);
    const uint16_t ic = get16(F + 36);
    pnet_shared_to_board(F, n, BOARD, MAC);
    CHECK_EQ_INT(ip_check(F), 0);
    CHECK_EQ_INT(get16(F + 36), ic);
    /* Short frames: nothing read or written past them (ASan-free run). */
    pnet_shared_to_board(F, 10, BOARD, MAC);
    pnet_shared_to_amiga(F, 20, BOARD, MAC);
    CHECK(!pnet_shared_a2b(&s, F, 10) && !pnet_shared_b2a(&s, F, 10), "short: not local");
}

static void the_local_pair_is_off_outside_shared_mode(void) {
    pnet_sort_t s = fresh();
    size_t n = tcp(HMAC, MAC, IP(192, 168, 1, 57), PNET_SHARED_BOARD, 6800, 0x8044, 0x12, 0);
    CHECK(!pnet_shared_a2b(&s, F, n), "a2b: off");
    n = arp(BCAST, MAC, 1, IP(192, 168, 1, 40), NULL, PNET_SHARED_AMIGA);
    CHECK(!pnet_shared_b2a(&s, F, n), "b2a: off");
    n = amitcp_dhcp(1, 1u, 0, 0);
    CHECK(!pnet_shared_is_dhcp(&s, F, n), "DHCP: the network's, as before");
    const pnet_lease_t L = lease();
    CHECK_EQ_INT(pnet_shared_dhcp_reply(&s, F, n, &L, R, sizeof R), 0);
}

/* ---- the end of shared mode ---- */

static void a_new_board_address_ends_shared_mode(void) {
    pnet_sort_t s = shared_and_acked();
    CHECK_EQ_INT(s.amiga_ip, BOARD);
    size_t n = udp(MAC, HMAC, HOTSPOT, BOARD, 53, 50123, 60);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, 0), PNET_SORT_AMIGA);  /* the link down (0): still shared */
    CHECK(s.sh.on, "on");
    const uint32_t moved = IP(192, 168, 43, 23);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, moved), PNET_SORT_AMIGA);  /* normal mode: the old address is the Amiga's */
    CHECK(!s.sh.on && s.sh.left == 1, "the board's new lease ended shared mode");
    CHECK_EQ_INT(s.amiga_ip, BOARD);                        /* the Amiga keeps it (AmiTCP_NG never renews) */
    CHECK_EQ_INT(pnet_sort_send_ip(&s), BOARD);
    n = amitcp_dhcp(1, 0x3333u, 0, 0);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, moved), PNET_TX_SEND);
    CHECK(!pnet_shared_is_dhcp(&s, F, n), "its next DHCP goes to the network again");
    n = hotspot_reply(2, 0x3333u, moved);                   /* ...and the clash, if it recurs, shares again */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, moved), PNET_SORT_DROP);
    CHECK(s.sh.on && s.sh.ip == moved && s.sh.entered == 2, "shared again, on the new address");
}

/* ---- normal mode is unchanged ---- */

static void a_network_that_leases_the_amiga_its_own_address_never_shares(void) {
    pnet_sort_t s = fresh();
    const uint32_t own = IP(192, 168, 43, 77);
    size_t n = amitcp_dhcp(1, 0xABCDu, 0, 0);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    CHECK(!pnet_shared_is_dhcp(&s, F, n), "to the radio");
    n = hotspot_reply(2, 0xABCDu, own);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    n = amitcp_dhcp(3, 0xABCDu, own, HOTSPOT);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    n = hotspot_reply(5, 0xABCDu, own);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    CHECK_EQ_INT(s.amiga_ip, own);
    CHECK_EQ_INT(pnet_sort_send_ip(&s), own);
    owns_calls = 0;
    n = tcp(MAC, HMAC, SERVER, BOARD, 443, 0xC123, 0x18, 10);   /* to the board's address: the board's, no lookup */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = udp(BCAST, HMAC, IP(192, 168, 43, 9), 0xFFFFFFFFu, 137, 137, 50);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);   /* broadcasts stay the board's */
    n = fragment(HOTSPOT, 53, 50123, 0x7001, 1);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);   /* a fragment to the board: the board's */
    CHECK_EQ_INT(owns_calls, 0);
    CHECK(!s.sh.on && s.sh.entered == 0, "never shared");
}

/* ---- review fixes 2026-11-15 ---- */

/* A DISCOVER or REQUEST like AmiTCP_NG's, but with a client-id of `cidlen` bytes (0: none); REQUEST asks for BOARD. */
static size_t dhcp_with_cid(uint8_t type, uint32_t xid, size_t cidlen) {
    memset(F, 0, sizeof F);
    const size_t blen = 548;
    ipv4(BCAST, MAC, 17, 0, 0xFFFFFFFFu, 8 + blen, 0, 0);
    uint8_t *u = F + 34;
    put16(u, 68); put16(u + 2, 67); put16(u + 4, (uint16_t)(8 + blen));
    uint8_t *b = u + 8;
    b[0] = 1; b[1] = 1; b[2] = 6;
    put32(b + 4, xid); put16(b + 10, 0x8000);
    memcpy(b + 28, MAC, 6);
    uint8_t *o = b + 236;
    put32(o, 0x63825363u); o += 4;
    *o++ = 53; *o++ = 1; *o++ = type;
    if (cidlen) { *o++ = 61; *o++ = (uint8_t)cidlen; for (size_t i = 0; i < cidlen; i++) *o++ = (uint8_t)(0xC0 + i); }
    if (type == 3) { *o++ = 50; *o++ = 4; put32(o, BOARD); o += 4; }
    *o++ = 255;
    set_l4_csum(F, 40, 8 + blen);
    return 34 + 8 + blen;
}

/* Review I1: the options are sized before they are written; a long client-id grows the reply (RFC 2131 lets the
 * options run to 312 bytes, AmiTCP_NG reads 312), never past the buffer, never without END. Every length is built
 * into a heap block of exactly the reply's length (ASan), then refused one byte short with nothing written. */
static void a_long_client_id_grows_the_reply_and_never_overflows(void) {
    static const size_t lens[] = {0, 7, 8, 9, 20, 254, 255};
    const pnet_lease_t L = lease();
    for (size_t k = 0; k < sizeof lens / sizeof lens[0]; k++) {
        for (uint8_t type = 1; type <= 3; type += 2) {     /* DISCOVER -> OFFER, REQUEST -> ACK */
            pnet_sort_t s = shared_by_offer(5u);
            const size_t cl = lens[k];
            const size_t n = dhcp_with_cid(type, 0x77u, cl);
            const size_t m = pnet_shared_dhcp_reply(&s, F, n, &L, R, sizeof R);
            char what[48];
            snprintf(what, sizeof what, "%s, client-id %zu", type == 1 ? "OFFER" : "ACK", cl);
            check_reply(R, m, type == 1 ? 2 : 5, 0x77u, BOARD, what);
            size_t ol = 0;
            size_t at = opt_at(R, m, 61, &ol);
            if (cl) CHECK(at && ol == cl && R[at] == 0xC0 && R[at + cl - 1] == (uint8_t)(0xC0 + cl - 1),
                          "the whole client-id echoed");
            else CHECK(at == 0, "no client-id, none echoed");
            at = opt_at(R, m, 6, &ol);
            CHECK(at && ol == 8, "and the DNS servers still there");
            /* 300-byte BOOTP while the options fit its 64 bytes (cookie + 49 + 61's 2 + END + the id <= 64) */
            CHECK_EQ_INT(m, cl + 2u + 54u <= 64u ? PNET_DHCP_REPLY_MIN : 14u + 20u + 8u + 236u + 54u + (cl ? cl + 2u : 0u));
            uint8_t *exact = malloc(m);
            CHECK_EQ_INT(pnet_shared_dhcp_reply(&s, F, n, &L, exact, m), m);
            CHECK(memcmp(exact, R, m) == 0, "the same reply in a block of exactly its length");
            free(exact);
            uint8_t *shorter = malloc(m - 1);
            memset(shorter, 0xAB, m - 1);
            CHECK_EQ_INT(pnet_shared_dhcp_reply(&s, F, n, &L, shorter, m - 1), 0);
            CHECK(shorter[0] == 0xAB && shorter[m - 2] == 0xAB, "refused, nothing written");
            free(shorter);
        }
    }
    /* The longest possible reply is PNET_DHCP_REPLY_MAX or less. */
    pnet_sort_t s = shared_by_offer(5u);
    const size_t n = dhcp_with_cid(3, 0x78u, 255);
    CHECK(pnet_shared_dhcp_reply(&s, F, n, &L, R, sizeof R) <= PNET_DHCP_REPLY_MAX, "within the maximum");
}

/* Review I2, the reported scenario end to end: at home the router gave the board the address the Amiga used to have
 * (the server's netAmigaIpLast), the board rebooted, and the Amiga runs on a lease of its own, .77. */
#define HOME   IP(192, 168, 1, 40)
#define HOME77 IP(192, 168, 1, 77)
#define HOMEGW IP(192, 168, 1, 1)
static void a_stale_seed_shares_until_the_amigas_first_frame_from_its_own_lease(void) {
    pnet_sort_t s = fresh();
    CHECK(pnet_sort_seed(&s, HOME, HOME), "the seed is the board's own address: shared mode");
    CHECK(s.sh.on && s.sh.why == PNET_SHARED_SEED && s.sh.amiga, "on, the Amiga assumed to share it");
    CHECK_EQ_INT(pnet_sort_send_ip(&s), PNET_SHARED_AMIGA);
    size_t n = arp(BCAST, MAC, 1, HOME77, NULL, HOMEGW);    /* the Amiga's first frame, from its own lease */
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, HOME), PNET_TX_SEND);
    CHECK(!s.sh.on && s.sh.own_src == 1, "that frame ended shared mode");
    CHECK_EQ_INT(s.amiga_ip, HOME77);
    n = arp(BCAST, HMAC, 1, HOMEGW, NULL, HOME77);          /* the router asks for .77: the Amiga answers */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, HOME), PNET_SORT_BOTH);
    n = tcp(MAC, HMAC, SERVER, HOME77, 80, 0xC001, 0x12, 0);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, HOME), PNET_SORT_AMIGA);
    n = tcp(MAC, HMAC, SERVER, HOME, 443, 0xC001, 0x12, 0); /* the board's address is the board's again */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, HOME), PNET_SORT_BOARD);
    CHECK_EQ_INT(pnet_sort_send_ip(&s), HOME77);            /* Transfer targets .77 */
    CHECK(!pnet_sort_seed(&s, HOME, HOME), "a repeat of the seed changes nothing now");
    CHECK(!s.sh.on, "still off");
}

/* The reason SEED exists: the board reboots (OTA, say) under an idle Amiga that shares its address. Without it the
 * board would know no Amiga, Transfer could not start, and lwIP would RST the Amiga's open connections. */
static void a_board_reboot_under_an_idle_sharing_amiga_shares_at_once(void) {
    pnet_sort_t s = fresh();                                /* after the reboot: nothing learned */
    CHECK(pnet_sort_seed(&s, BOARD, BOARD), "the server's last-known address is the board's");
    CHECK(s.sh.on && s.sh.amiga, "shared at once, the Amiga known");
    CHECK_EQ_INT(pnet_sort_send_ip(&s), PNET_SHARED_AMIGA);
    /* Inbound for the Amiga's open connection (its port 0xC123 to the server): the Amiga's, not an lwIP RST. */
    size_t n = tcp(MAC, HMAC, SERVER, BOARD, 443, 0xC123, 0x18, 40);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    n = udp(MAC, HMAC, HOTSPOT, BOARD, 53, 50123, 60);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    n = tcp(MAC, HMAC, SERVER, BOARD, 443, 0x8123, 0x18, 40);   /* the board's new TLS: the board's */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    /* Transfer's connect to 169.254.77.2: lwIP's ARP and SYN go to the Amiga, rewritten; its SYN-ACK comes back. */
    n = arp(BCAST, MAC, 1, BOARD, NULL, PNET_SHARED_AMIGA);
    CHECK(pnet_shared_b2a(&s, F, n), "the board's ARP for the Amiga: local");
    n = tcp(MAC, MAC, BOARD, PNET_SHARED_AMIGA, 0x8044, 6800, 0x02, 0);
    CHECK(pnet_shared_b2a(&s, F, n), "the SYN: local");
    pnet_shared_to_amiga(F, n, BOARD, MAC);
    CHECK_EQ_INT(get32(F + 26), PNET_SHARED_BOARD);
    CHECK_EQ_INT(get32(F + 30), BOARD);
    CHECK_EQ_INT(l4_check(F, n - 34), 0);
    n = tcp(HMAC, MAC, BOARD, PNET_SHARED_BOARD, 6800, 0x8044, 0x12, 0);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    CHECK(s.sh.on, "the Amiga's own (shared) source keeps shared mode");
    CHECK(pnet_shared_a2b(&s, F, n), "its SYN-ACK: local");
    pnet_shared_to_board(F, n, BOARD, MAC);
    CHECK_EQ_INT(get32(F + 26), PNET_SHARED_AMIGA);
    CHECK_EQ_INT(get32(F + 30), BOARD);
    CHECK_EQ_INT(l4_check(F, n - 34), 0);
}

/* Review I2 (b): already shared (here by a real clash), an Amiga that transmits from an address of its own leaves
 * shared mode, and that address is its own from then on. Neither 0 (a probe) nor 169.254/16 (its fallback) does. */
static void an_amiga_with_its_own_address_ends_shared_mode(void) {
    pnet_sort_t s = shared_and_acked();
    size_t n = arp(BCAST, MAC, 1, 0, NULL, BOARD);          /* an ARP probe: sender 0 */
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    CHECK(s.sh.on, "a probe keeps it");
    n = arp(BCAST, MAC, 1, IP(169, 254, 12, 34), NULL, HOTSPOT);
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    CHECK(s.sh.on, "a link-local sender keeps it");
    n = tcp(HMAC, MAC, BOARD, SERVER, 0xC002, 80, 0x02, 0);
    pnet_sort_tx(&s, F, n, MAC, BOARD);
    CHECK(s.sh.on, "the shared address keeps it");
    const uint32_t own = IP(192, 168, 43, 77);
    n = udp(HMAC, MAC, own, HOTSPOT, 0xC003, 53, 30);       /* the Amiga's DNS query from its own lease */
    CHECK_EQ_INT(pnet_sort_tx(&s, F, n, MAC, BOARD), PNET_TX_SEND);
    CHECK(!s.sh.on && s.sh.left == 1 && s.sh.own_src == 1, "left shared mode");
    CHECK_EQ_INT(s.amiga_ip, own);                          /* taught by that frame, in normal mode */
    CHECK_EQ_INT(pnet_sort_send_ip(&s), own);
    n = udp(MAC, HMAC, HOTSPOT, own, 53, 0xC003, 60);
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_AMIGA);
    n = udp(MAC, HMAC, HOTSPOT, BOARD, 53, 0xC003, 60);     /* the board's address is the board's again */
    CHECK_EQ_INT(pnet_sort_rx(&s, F, n, BOARD), PNET_SORT_BOARD);
    n = arp(BCAST, MAC, 1, IP(192, 168, 43, 78), NULL, HOTSPOT);   /* off: nothing more to leave */
    CHECK(!pnet_shared_amiga_left(&s, F, n), "off: false");
}

/* Review M2: an ICMP error on the local path quotes a datagram that crossed the bus the other way; its addresses
 * are restored for the receiver, and every checksum (outer IPv4, ICMP, quoted IPv4) verifies independently. */
static void local_icmp_errors_carry_a_rewritten_quote(void) {
    pnet_sort_t s = shared_and_acked();
    /* lwIP's port unreachable for a UDP datagram the Amiga sent to 169.254.77.1 (lwIP saw it from .77.2). */
    static uint8_t q[28];
    memset(q, 0, sizeof q);
    q[0] = 0x45; put16(q + 2, 41); q[8] = 64; q[9] = 17; put32(q + 12, PNET_SHARED_AMIGA); put32(q + 16, BOARD);
    put16(q + 10, finish(add_bytes(0, q, 20)));
    put16(q + 20, 0xC004); put16(q + 22, 7); put16(q + 24, 21);
    size_t n = icmp(MAC, MAC, BOARD, PNET_SHARED_AMIGA, 3, 3, q, sizeof q);
    CHECK(pnet_shared_b2a(&s, F, n), "local");
    pnet_shared_to_amiga(F, n, BOARD, MAC);
    CHECK_EQ_INT(get32(F + 26), PNET_SHARED_BOARD);
    CHECK_EQ_INT(get32(F + 30), BOARD);
    const uint8_t *iq = F + 42;
    CHECK_EQ_INT(get32(iq + 12), BOARD);                    /* as the Amiga sent it: from its own address */
    CHECK_EQ_INT(get32(iq + 16), PNET_SHARED_BOARD);        /* ...to 169.254.77.1 */
    CHECK_EQ_INT(ip_check(F), 0);
    CHECK_EQ_INT(finish(add_bytes(0, F + 34, 8 + sizeof q)), 0);   /* ICMP checksum */
    CHECK_EQ_INT(finish(add_bytes(0, iq, 20)), 0);                 /* the quoted header's checksum */
    CHECK_EQ_INT(get16(iq + 20), 0xC004);                   /* the quoted ports untouched */
    /* The Amiga's port unreachable for the board's datagram to 169.254.77.2 (the Amiga saw it from .77.1). */
    put32(q + 12, PNET_SHARED_BOARD); put32(q + 16, BOARD); put16(q + 10, 0); put16(q + 10, finish(add_bytes(0, q, 20)));
    n = icmp(HMAC, MAC, BOARD, PNET_SHARED_BOARD, 3, 3, q, sizeof q);
    CHECK(pnet_shared_a2b(&s, F, n), "local");
    pnet_shared_to_board(F, n, BOARD, MAC);
    CHECK_EQ_INT(get32(F + 42 + 12), BOARD);                /* as lwIP sent it: from the board's address */
    CHECK_EQ_INT(get32(F + 42 + 16), PNET_SHARED_AMIGA);    /* ...to 169.254.77.2 */
    CHECK_EQ_INT(ip_check(F), 0);
    CHECK_EQ_INT(finish(add_bytes(0, F + 34, 8 + sizeof q)), 0);
    CHECK_EQ_INT(finish(add_bytes(0, F + 42, 20)), 0);
    /* An echo request is not an error: nothing past its 8-byte header is touched. */
    n = icmp(HMAC, MAC, BOARD, PNET_SHARED_BOARD, 8, 0, q, sizeof q);
    pnet_shared_to_board(F, n, BOARD, MAC);
    CHECK_EQ_INT(get32(F + 42 + 12), PNET_SHARED_BOARD);
    CHECK_EQ_INT(finish(add_bytes(0, F + 34, 8 + sizeof q)), 0);
}

/* Review M4: the owed OFFER is counted against a full ring once, not on every 2 ms tick. */
static void a_full_ring_counts_the_owed_offer_once(void) {
    pnet_sort_t s = shared_by_offer(5u);
    CHECK(s.sh.owe, "owed");
    CHECK(pnet_shared_owe_full(&s), "the first full tick counts");
    for (int i = 0; i < 100; i++) CHECK(!pnet_shared_owe_full(&s), "later ticks do not");
    const pnet_lease_t L = lease();
    CHECK(pnet_shared_owed(&s, &L, R, sizeof R) != 0, "a slot freed: sent");
    CHECK(!pnet_shared_owe_full(&s), "nothing owed: nothing to count");
    pnet_sort_t t = shared_by_offer(6u);                    /* a new owed OFFER counts afresh */
    CHECK(pnet_shared_owe_full(&t), "counts");
    pnet_sort_t u = fresh();
    CHECK(!pnet_shared_owe_full(&u), "not shared: false");
}

/* Every prefix of every kind of frame, each in a heap block of exactly its length (ASan: a read or a write past the
 * frame's end is a report, not a quiet look at the next bytes of F). */
static void every_prefix_stays_inside_the_frame(void) {
    static uint8_t keep[3200];
    const pnet_lease_t L = lease();
    const pnet_sort_t base = shared_and_acked();
    for (int kind = 0; kind < 11; kind++) {
        size_t n = 0;
        switch (kind) {
        case 0: n = amitcp_dhcp(1, 5u, 0, 0); break;
        case 1: n = amitcp_dhcp(3, 5u, BOARD, HOTSPOT); break;
        case 2: n = hotspot_reply(5, 5u, BOARD); break;
        case 3: n = tcp(MAC, HMAC, BOARD, PNET_SHARED_BOARD, 6800, 0x8044, 0x12, 40); break;
        case 4: n = udp(MAC, MAC, BOARD, PNET_SHARED_AMIGA, 0x8100, 6801, 33); break;
        case 5: n = arp(LMAC, MAC, 2, BOARD, LMAC, PNET_SHARED_BOARD); break;
        case 6: n = fragment(HOTSPOT, 53, 50123, 0x7001, 0); break;
        case 7: n = fragment(HOTSPOT, 53, 50123, 0x7001, 1); break;
        case 8: {
            static uint8_t q[28];
            memset(q, 0, sizeof q); q[0] = 0x45; q[9] = 6; put32(q + 12, BOARD);
            n = icmp(MAC, HMAC, HOTSPOT, BOARD, 3, 4, q, sizeof q);
            break;
        }
        case 9: {                                           /* a local-path ICMP error: the quote is rewritten */
            static uint8_t q[28];
            memset(q, 0, sizeof q); q[0] = 0x45; q[9] = 17; put32(q + 12, PNET_SHARED_AMIGA); put32(q + 16, BOARD);
            n = icmp(MAC, MAC, BOARD, PNET_SHARED_AMIGA, 3, 3, q, sizeof q);
            break;
        }
        default: n = dhcp_with_cid(1, 5u, 255); break;
        }
        memcpy(keep, F, n);
        for (size_t len = 0; len <= n; len++) {
            pnet_sort_t s = base;
            uint8_t *f = malloc(len ? len : 1);
            memcpy(f, keep, len);
            (void)pnet_sort_rx(&s, f, len, BOARD);
            if (len >= 14 && len <= 1518) (void)pnet_shared_tx(&s, f, len);
            uint8_t *out = malloc(PNET_DHCP_REPLY_MAX);     /* exactly the longest reply */
            (void)pnet_shared_dhcp_reply(&s, f, len, &L, out, PNET_DHCP_REPLY_MAX);
            free(out);
            (void)pnet_shared_a2b(&s, f, len);
            (void)pnet_shared_b2a(&s, f, len);
            pnet_shared_to_board(f, len, BOARD, MAC);
            pnet_shared_to_amiga(f, len, BOARD, MAC);
            free(f);
        }
    }
    CHECK(1, "no report from the sanitizers");
}

/* lwipopts.h (the real one): lwIP's ephemeral TCP/UDP ports and DNS source ports never meet AmiTCP_NG's 49152-65535,
 * whatever LWIP_RAND hands the ENSURE macros. */
typedef uint16_t u16_t;
#undef WF_PNET_L2
#define WF_PNET_L2 1
#include "../lwipopts.h"
static void lwips_ephemeral_ports_stay_below_amitcps(void) {
    CHECK_EQ_INT(TCP_LOCAL_PORT_RANGE_START, 0x8000);
    CHECK_EQ_INT(TCP_LOCAL_PORT_RANGE_END, 0xBFFF);
    CHECK_EQ_INT(UDP_LOCAL_PORT_RANGE_START, 0x8000);
    CHECK_EQ_INT(UDP_LOCAL_PORT_RANGE_END, 0xBFFF);
    unsigned bad = 0, dns = 0;
    for (uint32_t r = 0; r <= 0xFFFFu; r++) {
        const u16_t t = TCP_ENSURE_LOCAL_PORT_RANGE((u16_t)r), u = UDP_ENSURE_LOCAL_PORT_RANGE((u16_t)r);
        if (t < 0x8000u || t > 0xBFFFu || u < 0x8000u || u > 0xBFFFu) bad++;
        if (DNS_PORT_ALLOWED(r)) { dns++; if (r < 0x8000u || r >= 49152u) bad++; }
    }
    CHECK_EQ_INT(bad, 0);
    CHECK_EQ_INT(dns, 0x4000);                              /* a quarter of random draws: dns.c retries the rest */
}

int main(void) {
    RUN(lwips_ephemeral_ports_stay_below_amitcps);
    RUN(a_hotspot_offer_of_the_boards_address_is_answered_by_the_board);
    RUN(a_unicast_reply_without_the_broadcast_flag_goes_to_the_amigas_mac);
    RUN(no_reply_without_the_boards_address);
    RUN(tcp_and_udp_go_to_whoever_holds_the_pcb);
    RUN(icmp_by_type_and_errors_by_their_quote);
    RUN(arp_for_the_shared_address_is_the_boards_unless_it_is_a_reply);
    RUN(only_udp_broadcasts_to_ports_lwip_does_not_own_reach_the_amiga);
    RUN(fragments_follow_their_first);
    RUN(the_amiga_may_send_from_the_shared_address);
    RUN(the_local_path_gives_the_bus_a_private_pair);
    RUN(the_local_pair_is_off_outside_shared_mode);
    RUN(a_new_board_address_ends_shared_mode);
    RUN(a_network_that_leases_the_amiga_its_own_address_never_shares);
    RUN(a_long_client_id_grows_the_reply_and_never_overflows);
    RUN(a_stale_seed_shares_until_the_amigas_first_frame_from_its_own_lease);
    RUN(a_board_reboot_under_an_idle_sharing_amiga_shares_at_once);
    RUN(an_amiga_with_its_own_address_ends_shared_mode);
    RUN(local_icmp_errors_carry_a_rewritten_quote);
    RUN(a_full_ring_counts_the_owed_offer_once);
    RUN(every_prefix_stays_inside_the_frame);
    return REPORT();
}
