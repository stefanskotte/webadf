/* PaulaNET shared-IP mode (pnet_shared.h). */
#include "pnet_shared.h"
#include "pnet_wire.h"
#include <string.h>

#define DHCP_OPTS_MIN  64u                  /* cookie + options in RFC 1542's 300-byte minimum BOOTP message */
_Static_assert(PNET_DHCP_REPLY_MAX == ETH_HDR + 20u + 8u + 236u + 312u, "the longest reply: 312 bytes of options");

void pnet_shared_enter(pnet_sort_t *s, uint32_t board_ip, pnet_shared_why_t why) {
    if (s->sh.on || board_ip == 0u) return;
    s->sh.on = true;
    s->sh.amiga = false;
    s->sh.owe = false;
    s->sh.owe_full = false;
    s->sh.why = (uint8_t)why;
    s->sh.ip = board_ip;
    s->sh.entered++;
    memset(s->sh.frag, 0, sizeof s->sh.frag);
    s->amiga_ip = board_ip;                 /* what the report and the log say the Amiga uses */
}

void pnet_shared_follow(pnet_sort_t *s, uint32_t board_ip) {
    if (!s->sh.on || board_ip == 0u || board_ip == s->sh.ip) return;
    s->sh.on = false;                       /* another lease: the old address is the Amiga's own from now on */
    s->sh.amiga = false;
    s->sh.owe = false;
    s->sh.owe_full = false;
    s->sh.left++;
    /* s->amiga_ip stays the old shared address, which the Amiga still holds (it never renews). */
}

uint32_t pnet_sort_send_ip(const pnet_sort_t *s) {
    if (s->sh.on) return s->sh.amiga ? PNET_SHARED_AMIGA : 0u;
    return s->amiga_ip;
}

/* ---- checksums ---- */

static uint32_t sum16(const uint8_t *p, size_t n, uint32_t acc) {
    for (; n > 1u; p += 2, n -= 2u) acc += be16(p);
    if (n) acc += (uint32_t)p[0] << 8;
    return acc;
}
static uint16_t fold(uint32_t acc) {
    while (acc >> 16) acc = (acc & 0xFFFFu) + (acc >> 16);
    return (uint16_t)~acc;
}
/* RFC 1624 eqn. 3, HC' = ~(~HC + ~m + m'), for a 32-bit word that changed from `from` to `to`. */
static void csum_swap32(uint8_t *field, uint32_t from, uint32_t to) {
    uint32_t acc = (uint16_t)~be16(field);
    acc += (uint16_t)~(from >> 16) + (uint16_t)~(from & 0xFFFFu) + (to >> 16) + (to & 0xFFFFu);
    while (acc >> 16) acc = (acc & 0xFFFFu) + (acc >> 16);
    put16(field, (uint16_t)~acc);
}

/* ---- the DHCP server ---- */

static uint8_t *opt4(uint8_t *o, uint8_t code, uint32_t v) {
    o[0] = code; o[1] = 4u; put32(o + 2, v);
    return o + 6;
}

/* One reply, `type` 2 (OFFER), 5 (ACK) or 6 (NAK), for xid/flags from the Amiga (chaddr = the shared MAC).
 * Review I1: the options are sized BEFORE anything is written. They fill the 300-byte BOOTP minimum's 60 bytes when
 * they fit and grow the message past it when they do not (an echoed client-id longer than 8 bytes with a gateway
 * and two DNS servers): RFC 2131 §2 has a variable options field that every client must accept up to 312 bytes,
 * and AmiTCP_NG's receive buffer holds exactly 312 (struct dhcp_pkt). The longest reply -- every option and a
 * 255-byte client-id -- is 311 bytes of options, so the echo always fits; IPv4, UDP and the checksums follow the
 * real length. Returns 0 (nothing written) when cap is short of that length. */
static size_t build(uint8_t *out, size_t cap, const pnet_lease_t *L, uint32_t xid, uint16_t flags, uint8_t type,
                    const uint8_t *cid, size_t cidlen) {
    const unsigned nd = (L->dns[0] != 0u) + (L->dns[1] != 0u);
    if (!cid || cidlen > 255u) cidlen = 0;
    size_t opts = 4u + 3u + 6u + 1u;                                   /* cookie, 53, 54, END */
    if (type != 6u) opts += 4u * 6u + (L->gw ? 6u : 0u) + (nd ? 2u + 4u * nd : 0u);   /* 51 58 59 1, 3, 6 */
    if (cidlen) opts += 2u + cidlen;                                   /* 61, RFC 6842 */
    const size_t bootp = 236u + (opts > DHCP_OPTS_MIN ? opts : DHCP_OPTS_MIN);
    const size_t total = ETH_HDR + 20u + 8u + bootp;
    if (cap < total) return 0;
    memset(out, 0, total);
    const uint32_t server = L->server ? L->server : L->gw ? L->gw : L->ip;
    const uint32_t yi = type == 6u ? 0u : L->ip;
    const bool bcast = (flags & 0x8000u) != 0u || type == 6u;
    /* Ethernet: to the Amiga, from the local MAC (AmiTCP ignores frames claiming its own MAC as the sender). */
    if (bcast) memset(out, 0xFF, 6); else memcpy(out, L->mac, 6);
    pnet_local_mac(L->mac, out + 6);
    put16(out + 12, 0x0800u);
    /* IPv4 */
    uint8_t *ip = out + ETH_HDR;
    ip[0] = 0x45u;
    put16(ip + 2, (uint16_t)(20u + 8u + bootp));
    ip[8] = 64u;
    ip[9] = 17u;
    put32(ip + 12, server);
    put32(ip + 16, bcast ? 0xFFFFFFFFu : yi);
    put16(ip + 10, fold(sum16(ip, 20u, 0u)));
    /* UDP 67 -> 68 */
    uint8_t *u = ip + 20;
    put16(u, 67u); put16(u + 2, 68u); put16(u + 4, (uint16_t)(8u + bootp));
    /* BOOTP */
    uint8_t *b = u + 8;
    b[0] = 2u; b[1] = 1u; b[2] = 6u;
    put32(b + 4, xid);
    put16(b + 10, flags);
    put32(b + 16, yi);
    memcpy(b + 28, L->mac, 6);
    put32(b + 236, 0x63825363u);
    uint8_t *o = b + 240;
    *o++ = 53u; *o++ = 1u; *o++ = type;
    o = opt4(o, 54u, server);
    if (type != 6u) {
        o = opt4(o, 51u, PNET_SHARED_LEASE_S);
        o = opt4(o, 58u, PNET_SHARED_LEASE_S / 2u);
        o = opt4(o, 59u, PNET_SHARED_LEASE_S * 7u / 8u);
        o = opt4(o, 1u, L->mask);
        if (L->gw) o = opt4(o, 3u, L->gw);
        if (nd) {
            *o++ = 6u; *o++ = (uint8_t)(4u * nd);
            for (unsigned i = 0; i < 2u; i++) if (L->dns[i]) { put32(o, L->dns[i]); o += 4; }
        }
    }
    if (cidlen) {                                    /* RFC 6842: echo the client's identifier */
        *o++ = 61u; *o++ = (uint8_t)cidlen;
        memcpy(o, cid, cidlen); o += cidlen;
    }
    *o = 255u;                                       /* at b + 236 + opts - 1, inside `total` by construction */
    /* UDP checksum over the pseudo header */
    uint32_t acc = sum16(ip + 12, 8u, 0u) + 17u + (uint32_t)(8u + bootp);
    uint16_t c = fold(sum16(u, 8u + bootp, acc));
    put16(u + 6, c ? c : 0xFFFFu);
    return total;
}

bool pnet_shared_is_dhcp(const pnet_sort_t *s, const uint8_t *f, size_t len) {
    if (!s->sh.on) return false;
    ip4_t ip;
    if (!ip4(f, len, &ip)) return false;
    const size_t b = bootp_at(f, len, &ip, 68u, 67u);
    return b != 0u && f[b] == 1u;
}

size_t pnet_shared_dhcp_reply(pnet_sort_t *s, const uint8_t *f, size_t len, const pnet_lease_t *L,
                              uint8_t *out, size_t cap) {
    if (!pnet_shared_is_dhcp(s, f, len) || L->ip == 0u || L->ip != s->sh.ip) return 0;
    ip4_t ip;
    ip4(f, len, &ip);
    const size_t b = bootp_at(f, len, &ip, 68u, 67u);
    const uint32_t xid = be32(f + b + 4u);
    const uint16_t flags = be16(f + b + 10u);
    size_t cidlen = 0;
    const size_t cid = dhcp_opt(f, len, b, 61u, &cidlen);
    const uint8_t *cidp = cid ? f + cid : NULL;
    switch (dhcp_type(f, len, b)) {
    case 1u: {                                                     /* DISCOVER */
        const size_t n = build(out, cap, L, xid, flags, 2u, cidp, cidlen);
        if (n) s->sh.offers++;
        return n;
    }
    case 3u: {                                                     /* REQUEST */
        size_t rl = 0;
        const size_t r = dhcp_opt(f, len, b, 50u, &rl);
        const uint32_t want = r && rl == 4u ? be32(f + r) : be32(f + b + 12u);   /* option 50, else ciaddr */
        const bool ok = want == L->ip;
        const size_t n = build(out, cap, L, xid, flags, ok ? 5u : 6u, cidp, cidlen);
        if (n && ok) { s->sh.acks++; s->sh.amiga = true; }
        if (n && !ok) s->sh.naks++;
        return n;
    }
    default:                                                       /* RELEASE, DECLINE, INFORM: no answer */
        return 0;
    }
}

size_t pnet_shared_owed(pnet_sort_t *s, const pnet_lease_t *L, uint8_t *out, size_t cap) {
    if (!s->sh.on || !s->sh.owe || L->ip == 0u || L->ip != s->sh.ip) return 0;
    const size_t n = build(out, cap, L, s->sh.owe_xid, s->sh.owe_flags, 2u, NULL, 0u);
    if (n) { s->sh.owe = false; s->sh.owe_full = false; s->sh.offers++; }
    return n;
}

/* ---- inbound demux ---- */

static bool board_owns(const pnet_sort_t *s, uint8_t proto, uint16_t lport, uint32_t rip, uint16_t rport) {
    return s->owns != NULL && s->owns(s->owns_ctx, proto, lport, rip, rport);
}

/* Whose is an unfragmented (or first-fragment) IPv4 datagram to the shared address, its L4 header at ip->l4? */
static pnet_sort_to_t owner(const pnet_sort_t *s, const uint8_t *f, size_t len, const ip4_t *ip) {
    const uint8_t *l4 = f + ip->l4;
    if (ip->proto == 6u || ip->proto == 17u) {
        if (len < ip->l4 + 4u) return PNET_SORT_BOARD;
        return board_owns(s, ip->proto, be16(l4 + 2), ip->src, be16(l4)) ? PNET_SORT_BOARD : PNET_SORT_AMIGA;
    }
    if (ip->proto != 1u || len < ip->l4 + 8u) return PNET_SORT_BOARD;
    const uint8_t t = l4[0];
    if (t == 8u) return PNET_SORT_BOARD;                           /* echo request: lwIP answers */
    if (t == 0u) return PNET_SORT_AMIGA;                           /* echo reply: lwIP sends no pings */
    if (t != 3u && t != 4u && t != 5u && t != 11u && t != 12u) return PNET_SORT_BOARD;
    /* An error quoting our datagram: its IPv4 header, then its first 8 bytes. */
    const size_t q = ip->l4 + 8u;
    if (len < q + 20u || (f[q] >> 4) != 4u) return PNET_SORT_BOARD;
    const size_t qihl = (size_t)(f[q] & 0x0Fu) * 4u;
    if (qihl < 20u) return PNET_SORT_BOARD;
    const uint8_t qp = f[q + 9u];
    if (qp == 1u) return PNET_SORT_AMIGA;                          /* about an ICMP query: the Amiga's */
    if ((qp != 6u && qp != 17u) || len < q + qihl + 4u) return PNET_SORT_BOARD;
    const uint8_t *ql4 = f + q + qihl;                             /* we sent it: our port is its source */
    return board_owns(s, qp, be16(ql4), be32(f + q + 16u), be16(ql4 + 2)) ? PNET_SORT_BOARD : PNET_SORT_AMIGA;
}

static pnet_sort_to_t counted(pnet_sort_t *s, pnet_sort_to_t to) {
    if (to == PNET_SORT_AMIGA) s->to_amiga++;
    else if (to == PNET_SORT_BOTH) s->to_both++;
    return to;
}

pnet_sort_to_t pnet_shared_rx(pnet_sort_t *s, const uint8_t *f, size_t len) {
    if (len < ETH_HDR) return PNET_SORT_BOARD;
    const uint32_t me = s->sh.ip;
    arp4_t a;
    if (arp4(f, len, &a)) {
        if (a.spa == me) { s->sh.arp_hidden++; return PNET_SORT_BOARD; }
        if (a.tpa == me && a.op == 2u) return counted(s, PNET_SORT_BOTH);
        return PNET_SORT_BOARD;
    }
    ip4_t ip;
    if (!ip4(f, len, &ip)) return PNET_SORT_BOARD;
    const size_t b = bootp_at(f, len, &ip, 67u, 68u);
    if (b != 0u && f[b] == 2u) {                                   /* a BOOTREPLY */
        if (pnet_sort_is_amiga_xid(s, be32(f + b + 4u))) { s->sh.late++; return PNET_SORT_DROP; }
        return PNET_SORT_BOARD;
    }
    // Review M1: the Paula link is slow, so a broadcast reaches the Amiga only when it may need it: UDP to the
    // broadcast MAC (limited 255.255.255.255 or the subnet's broadcast) and to a port no board pcb owns -- the
    // Amiga's alone then, lwIP would only drop it; a board-owned port is lwIP's alone. First fragments only.
    // Multicast (224.0.0.0/4: mDNS, SSDP) and every other broadcast are the board's, as in normal mode. (ARP and
    // DHCP replies were sorted above.)
    if (f[0] & 1u) {
        static const uint8_t ALL[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
        if (memcmp(f, ALL, 6) != 0 || (ip.dst >> 28) == 0xEu || ip.proto != 17u || !ip.first ||
            len < ip.l4 + 4u)
            return PNET_SORT_BOARD;
        return board_owns(s, 17u, be16(f + ip.l4 + 2), ip.src, be16(f + ip.l4)) ? PNET_SORT_BOARD
                                                                                  : counted(s, PNET_SORT_AMIGA);
    }
    if (ip.dst != me) return PNET_SORT_BOARD;
    const uint8_t *h = f + ETH_HDR;
    const uint16_t frag = be16(h + 6);
    const uint16_t id = be16(h + 4);
    const bool more = (frag & 0x2000u) != 0u;
    if (!ip.first) {                                               /* no L4 header: the first fragment's owner */
        for (unsigned i = 0; i < PNET_SORT_FRAGS; i++) {
            pnet_frag_t *e = &s->sh.frag[i];
            if (e->to != 0u && e->src == ip.src && e->id == id && e->proto == ip.proto) {
                const pnet_sort_to_t to = (pnet_sort_to_t)e->to;
                if (!more) e->to = 0u;                             /* the last fragment: forget the datagram */
                return counted(s, to);
            }
        }
        s->sh.frag_drops++;
        return PNET_SORT_DROP;
    }
    const pnet_sort_to_t to = owner(s, f, len, &ip);
    if (more) {                                                    /* a first fragment: remember its owner */
        pnet_frag_t *e = &s->sh.frag[s->sh.frag_next];
        s->sh.frag_next = (uint8_t)((s->sh.frag_next + 1u) % PNET_SORT_FRAGS);
        e->src = ip.src; e->id = id; e->proto = ip.proto; e->to = (uint8_t)to;
    }
    return counted(s, to);
}

pnet_tx_t pnet_shared_tx(pnet_sort_t *s, const uint8_t *f, size_t len) {
    const uint16_t type = be16(f + 12);
    if (type == 0x0806u) {
        if (len < ETH_HDR + 28u) return PNET_TX_LEN;
        if (be32(f + ETH_HDR + 14u) == s->sh.ip) s->sh.amiga = true;
        return PNET_TX_SEND;
    }
    if (type != 0x0800u) return PNET_TX_TYPE;
    ip4_t ip;
    if (!ip4(f, len, &ip)) return PNET_TX_LEN;
    const size_t b = bootp_at(f, len, &ip, 68u, 67u);
    if (b != 0u && f[b] == 1u) pnet_sort_learn_xid(s, be32(f + b + 4u));   /* answered locally (the glue) */
    else if (ip.src == s->sh.ip) s->sh.amiga = true;
    return PNET_TX_SEND;
}

bool pnet_shared_amiga_left(pnet_sort_t *s, const uint8_t *f, size_t len) {
    if (!s->sh.on || len < ETH_HDR) return false;
    uint32_t src = 0;
    arp4_t a;
    ip4_t ip;
    if (arp4(f, len, &a)) src = a.spa;
    else if (ip4(f, len, &ip)) src = ip.src;
    if (src == 0u || src == s->sh.ip || (src >> 16) == 0xA9FEu) return false;   /* 0, shared, or 169.254/16 */
    s->sh.on = false;
    s->sh.amiga = false;
    s->sh.owe = false;
    s->sh.owe_full = false;
    s->sh.left++;
    s->sh.own_src++;
    s->amiga_ip = 0;                        /* the frame's normal-mode path teaches the Amiga's own address */
    return true;
}

bool pnet_shared_owe_full(pnet_sort_t *s) {
    if (!s->sh.on || !s->sh.owe || s->sh.owe_full) return false;
    s->sh.owe_full = true;
    return true;
}

/* ---- the local path ---- */

static bool to_addr(const uint8_t *f, size_t len, uint32_t want) {
    arp4_t a;
    if (arp4(f, len, &a)) return a.tpa == want;
    ip4_t ip;
    return ip4(f, len, &ip) && ip.dst == want;
}

bool pnet_shared_a2b(const pnet_sort_t *s, const uint8_t *f, size_t len) {
    return s->sh.on && to_addr(f, len, PNET_SHARED_BOARD);
}

bool pnet_shared_b2a(const pnet_sort_t *s, const uint8_t *f, size_t len) {
    return s->sh.on && to_addr(f, len, PNET_SHARED_AMIGA);
}

/* The source sfrom -> sto and the destination dfrom -> dto, each only where it holds that address: an ARP packet's
 * sender/target protocol addresses, or an IPv4 header with its checksum and, in a datagram's first fragment, the
 * TCP or UDP checksum (whose pseudo header holds both addresses). */
static void readdress(uint8_t *f, size_t len, uint32_t sfrom, uint32_t sto, uint32_t dfrom, uint32_t dto) {
    if (len >= ETH_HDR + 28u && be16(f + 12) == 0x0806u) {
        arp4_t a;
        if (!arp4(f, len, &a)) return;
        if (a.spa == sfrom) put32(f + ETH_HDR + 14u, sto);
        if (a.tpa == dfrom) put32(f + ETH_HDR + 24u, dto);
        return;
    }
    ip4_t ip;
    if (!ip4(f, len, &ip)) return;
    uint8_t *h = f + ETH_HDR;
    uint8_t *l4c = NULL;                                           /* the L4 checksum field, when present */
    if (ip.first && ip.proto == 6u && len >= ip.l4 + 18u) l4c = f + ip.l4 + 16u;
    if (ip.first && ip.proto == 17u && len >= ip.l4 + 8u && be16(f + ip.l4 + 6u) != 0u) l4c = f + ip.l4 + 6u;
    if (ip.src == sfrom) {
        put32(h + 12, sto);
        csum_swap32(h + 10, sfrom, sto);
        if (l4c) csum_swap32(l4c, sfrom, sto);
    }
    if (ip.dst == dfrom) {
        put32(h + 16, dto);
        csum_swap32(h + 10, dfrom, dto);
        if (l4c) csum_swap32(l4c, dfrom, dto);
    }
    if (l4c && ip.proto == 17u && be16(l4c) == 0u) put16(l4c, 0xFFFFu);   /* UDP: 0 means "no checksum" */
    // Review M2: an ICMP error quotes the datagram it is about, which crossed the bus the OTHER way and so was
    // rewritten with the inverse pair: its source is restored dfrom -> dto, its destination sfrom -> sto. The quoted
    // header's checksum follows, and the ICMP checksum (which covers the quote) follows both. The quoted TCP/UDP
    // checksum is left alone: only 8 bytes of that header are quoted, and no stack verifies it.
    if (ip.proto != 1u || !ip.first || len < ip.l4 + 8u + 20u) return;
    uint8_t *ic = f + ip.l4;
    const uint8_t t = ic[0];
    if (t != 3u && t != 4u && t != 5u && t != 11u && t != 12u) return;
    uint8_t *q = ic + 8;
    if ((q[0] >> 4) != 4u || (q[0] & 0x0Fu) < 5u) return;
    const uint16_t qc0 = be16(q + 10);
    const uint32_t qs = be32(q + 12), qd = be32(q + 16);
    if (qs == dfrom) { put32(q + 12, dto); csum_swap32(q + 10, dfrom, dto); csum_swap32(ic + 2, dfrom, dto); }
    if (qd == sfrom) { put32(q + 16, sto); csum_swap32(q + 10, sfrom, sto); csum_swap32(ic + 2, sfrom, sto); }
    csum_swap32(ic + 2, qc0, be16(q + 10));          /* the quoted checksum's own change, as a 32-bit word */
}

void pnet_shared_to_board(uint8_t *f, size_t len, uint32_t ip, const uint8_t mac[6]) {
    if (len < ETH_HDR) return;
    memcpy(f, mac, 6);                    /* the Amiga routes 169.254.77.1 via its gateway's MAC, or the local MAC */
    pnet_local_to_board(f, len, mac);     /* the ARP target MAC */
    readdress(f, len, ip, PNET_SHARED_AMIGA, PNET_SHARED_BOARD, ip);
}

void pnet_shared_to_amiga(uint8_t *f, size_t len, uint32_t ip, const uint8_t mac[6]) {
    if (len < ETH_HDR) return;
    pnet_local_to_amiga(f, len, mac);     /* the Ethernet source and ARP sender MAC */
    readdress(f, len, ip, PNET_SHARED_BOARD, PNET_SHARED_AMIGA, ip);
}
