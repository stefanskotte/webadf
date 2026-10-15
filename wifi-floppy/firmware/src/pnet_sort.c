/* The layer-2 sharing sorter (pnet_sort.h). */
#include "pnet_sort.h"
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#define ETH_HDR 14u

static uint16_t be16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }
static uint32_t be32(const uint8_t *p) {
    return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | (uint32_t)p[3];
}

typedef struct { uint32_t src, dst; uint8_t proto; size_t l4; bool first; } ip4_t;

/* The IPv4 facts the sorter reads; false when f does not hold a whole IPv4 header. */
static bool ip4(const uint8_t *f, size_t len, ip4_t *o) {
    if (len < ETH_HDR + 20u || be16(f + 12) != 0x0800u) return false;
    const uint8_t *ip = f + ETH_HDR;
    const size_t ihl = (size_t)(ip[0] & 0x0Fu) * 4u;
    if ((ip[0] >> 4) != 4u || ihl < 20u || len < ETH_HDR + ihl) return false;
    o->proto = ip[9];
    o->src = be32(ip + 12);
    o->dst = be32(ip + 16);
    o->l4 = ETH_HDR + ihl;
    o->first = (be16(ip + 6) & 0x1FFFu) == 0u;            /* fragment offset 0 */
    return true;
}

/* The BOOTP message's offset for UDP sport -> dport with the magic cookie, else 0. */
static size_t bootp_at(const uint8_t *f, size_t len, const ip4_t *ip, uint16_t sport, uint16_t dport) {
    if (ip->proto != 17u || !ip->first || len < ip->l4 + 8u) return 0;
    const uint8_t *u = f + ip->l4;
    if (be16(u) != sport || be16(u + 2) != dport) return 0;
    const size_t b = ip->l4 + 8u;
    if (len < b + 240u || be32(f + b + 236u) != 0x63825363u) return 0;
    return b;
}

/* Option 53 of the message at b, or 0 when it is absent or the options run past len. */
static uint8_t dhcp_type(const uint8_t *f, size_t len, size_t b) {
    size_t i = b + 240u;
    while (i < len) {
        const uint8_t code = f[i];
        if (code == 0u) { i++; continue; }
        if (code == 255u || len - i < 2u) return 0;
        const size_t olen = f[i + 1u];
        if (len - i - 2u < olen) return 0;
        if (code == 53u && olen == 1u) return f[i + 2u];
        i += 2u + olen;
    }
    return 0;
}

static bool is_amiga_xid(const pnet_sort_t *s, uint32_t xid) {
    for (unsigned i = 0; i < s->nxid; i++)
        if (s->xid[i] == xid) return true;
    return false;
}

void pnet_sort_init(pnet_sort_t *s) { memset(s, 0, sizeof *s); }

pnet_sort_to_t pnet_sort_rx(pnet_sort_t *s, const uint8_t *f, size_t len, uint32_t board_ip) {
    if (len < ETH_HDR) return PNET_SORT_BOARD;
    const uint32_t amiga = s->amiga_ip != board_ip ? s->amiga_ip : 0u;   /* never the board's */
    if (be16(f + 12) == 0x0806u) {
        if (amiga == 0u || len < ETH_HDR + 28u) return PNET_SORT_BOARD;
        const uint8_t *a = f + ETH_HDR;
        if (be16(a) != 1u || be16(a + 2) != 0x0800u || a[4] != 6u || a[5] != 4u) return PNET_SORT_BOARD;
        if (be32(a + 24) != amiga) return PNET_SORT_BOARD;             /* target protocol address */
        s->to_both++;
        return PNET_SORT_BOTH;
    }
    ip4_t ip;
    if (!ip4(f, len, &ip)) return PNET_SORT_BOARD;
    const size_t b = bootp_at(f, len, &ip, 67u, 68u);
    if (b != 0u && f[b] == 2u) {                                       /* a BOOTREPLY */
        const uint32_t xid = be32(f + b + 4u), yi = be32(f + b + 16u);
        const uint8_t type = dhcp_type(f, len, b);
        if (is_amiga_xid(s, xid)) {
            if (type == 5u && board_ip != 0u && yi == board_ip) { s->clash++; return PNET_SORT_DROP; }
            if (type == 5u && yi != 0u) s->amiga_ip = yi;
            s->to_amiga++;
            return PNET_SORT_AMIGA;
        }
        if (type == 5u && amiga != 0u && yi == amiga) s->clash++;    /* the board's lease, logged */
        return PNET_SORT_BOARD;
    }
    if (amiga != 0u && ip.dst == amiga) { s->to_amiga++; return PNET_SORT_AMIGA; }
    return PNET_SORT_BOARD;
}

static void learn_xid(pnet_sort_t *s, uint32_t xid) {
    if (is_amiga_xid(s, xid)) return;
    s->xid[s->xid_next] = xid;
    s->xid_next = (uint8_t)((s->xid_next + 1u) % PNET_SORT_XIDS);
    if (s->nxid < PNET_SORT_XIDS) s->nxid++;
}

pnet_tx_t pnet_sort_tx(pnet_sort_t *s, const uint8_t *f, size_t len, const uint8_t mac[6], uint32_t board_ip) {
    if (len < ETH_HDR || len > PNET_SORT_MTU) return PNET_TX_LEN;
    if (memcmp(f + 6, mac, 6) != 0) return PNET_TX_MAC;
    const uint16_t type = be16(f + 12);
    if (type == 0x0806u) {
        if (len < ETH_HDR + 28u) return PNET_TX_LEN;
        const uint32_t spa = be32(f + ETH_HDR + 14u);
        if (spa != 0u && spa == board_ip) return PNET_TX_CLASH;
        if (spa != 0u) s->amiga_ip = spa;
        return PNET_TX_SEND;
    }
    if (type != 0x0800u) return PNET_TX_TYPE;
    ip4_t ip;
    if (!ip4(f, len, &ip)) return PNET_TX_LEN;
    if (ip.src != 0u && ip.src == board_ip) return PNET_TX_CLASH;
    const size_t b = bootp_at(f, len, &ip, 68u, 67u);
    if (b != 0u && f[b] == 1u) learn_xid(s, be32(f + b + 4u));
    else if (ip.src != 0u) s->amiga_ip = ip.src;
    return PNET_TX_SEND;
}

/* ARP (Ethernet/IPv4) whose target protocol address is `tpa`, or IPv4 whose destination is `tpa`. */
static bool addressed_to(const uint8_t *f, size_t len, uint32_t tpa) {
    if (tpa == 0u || len < ETH_HDR) return false;
    if (be16(f + 12) == 0x0806u) {
        if (len < ETH_HDR + 28u) return false;
        const uint8_t *a = f + ETH_HDR;
        if (be16(a) != 1u || be16(a + 2) != 0x0800u || a[4] != 6u || a[5] != 4u) return false;
        return be32(a + 24) == tpa;
    }
    ip4_t ip;
    return ip4(f, len, &ip) && ip.dst == tpa;
}

bool pnet_sort_a2b_local(const uint8_t *f, size_t len, uint32_t board_ip) {
    return addressed_to(f, len, board_ip);
}

bool pnet_sort_b2a_local(const pnet_sort_t *s, const uint8_t *f, size_t len, uint32_t board_ip) {
    const uint32_t amiga = s->amiga_ip != board_ip ? s->amiga_ip : 0u;   /* never the board's */
    return addressed_to(f, len, amiga);
}

void pnet_local_mac(const uint8_t mac[6], uint8_t out[6]) {
    memcpy(out, mac, 6);
    out[0] ^= 0x02u;
}

/* Replaces `from` with `to` at the Ethernet address at `eth` (0 dest, 6 source) and, for ARP, at the ARP hardware
 * address at `arp` (8 sender, 18 target) -- each only where it holds `from`. */
static void swap_mac(uint8_t *f, size_t len, size_t eth, size_t arp, const uint8_t from[6], const uint8_t to[6]) {
    if (len < ETH_HDR) return;
    if (memcmp(f + eth, from, 6) == 0) memcpy(f + eth, to, 6);
    if (be16(f + 12) == 0x0806u && len >= ETH_HDR + 28u && memcmp(f + ETH_HDR + arp, from, 6) == 0)
        memcpy(f + ETH_HDR + arp, to, 6);
}

void pnet_local_to_amiga(uint8_t *f, size_t len, const uint8_t mac[6]) {
    uint8_t l[6];
    pnet_local_mac(mac, l);
    swap_mac(f, len, 6u, 8u, mac, l);
}

void pnet_local_to_board(uint8_t *f, size_t len, const uint8_t mac[6]) {
    uint8_t l[6];
    pnet_local_mac(mac, l);
    swap_mac(f, len, 0u, 18u, l, mac);
}

size_t pnet_dhcp_client_id(uint8_t *opts, size_t used, size_t cap, const uint8_t mac[6]) {
    static const uint8_t pre[5] = {61u, 9u, 0x00u, 'w', 'f'};
    if (used > cap || cap - used < PNET_CLIENT_ID_BYTES) return used;
    memcpy(opts + used, pre, sizeof pre);
    memcpy(opts + used + sizeof pre, mac, 6);
    return used + PNET_CLIENT_ID_BYTES;
}

void pnet_ip_text(uint32_t ip, char out[16]) {
    snprintf(out, 16, "%u.%u.%u.%u", (unsigned)(ip >> 24), (unsigned)(ip >> 16 & 255u),
             (unsigned)(ip >> 8 & 255u), (unsigned)(ip & 255u));
}
