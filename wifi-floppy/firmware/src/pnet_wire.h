#ifndef PNET_WIRE_H
#define PNET_WIRE_H
/* The frame readers pnet_sort.c and pnet_shared.c share (private to those two). Pure; host order out. */
#include "pnet_sort.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define ETH_HDR 14u

static inline uint16_t be16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }
static inline uint32_t be32(const uint8_t *p) {
    return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | (uint32_t)p[3];
}
static inline void put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }
static inline void put32(uint8_t *p, uint32_t v) { put16(p, (uint16_t)(v >> 16)); put16(p + 2, (uint16_t)v); }

typedef struct { uint32_t src, dst; uint8_t proto; size_t l4; bool first; } ip4_t;

/* The IPv4 facts the sorter reads; false when f does not hold a whole IPv4 header. */
static inline bool ip4(const uint8_t *f, size_t len, ip4_t *o) {
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
static inline size_t bootp_at(const uint8_t *f, size_t len, const ip4_t *ip, uint16_t sport, uint16_t dport) {
    if (ip->proto != 17u || !ip->first || len < ip->l4 + 8u) return 0;
    const uint8_t *u = f + ip->l4;
    if (be16(u) != sport || be16(u + 2) != dport) return 0;
    const size_t b = ip->l4 + 8u;
    if (len < b + 240u || be32(f + b + 236u) != 0x63825363u) return 0;
    return b;
}

/* Option `code` of the DHCP message at b: its offset (the first value byte) and *olen, or 0 when it is absent or
 * the options run past len. Pads skipped; the scan stops at END. */
static inline size_t dhcp_opt(const uint8_t *f, size_t len, size_t b, uint8_t want, size_t *olen) {
    size_t i = b + 240u;
    while (i < len) {
        const uint8_t code = f[i];
        if (code == 0u) { i++; continue; }
        if (code == 255u || len - i < 2u) return 0;
        const size_t n = f[i + 1u];
        if (len - i - 2u < n) return 0;
        if (code == want) { *olen = n; return i + 2u; }
        i += 2u + n;
    }
    return 0;
}

/* Option 53 of the message at b, or 0 when it is absent or the options run past len. */
static inline uint8_t dhcp_type(const uint8_t *f, size_t len, size_t b) {
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

/* An Ethernet/IPv4 ARP packet: its opcode, sender and target protocol addresses. False when it is not one. */
typedef struct { uint16_t op; uint32_t spa, tpa; } arp4_t;
static inline bool arp4(const uint8_t *f, size_t len, arp4_t *o) {
    if (len < ETH_HDR + 28u || be16(f + 12) != 0x0806u) return false;
    const uint8_t *a = f + ETH_HDR;
    if (be16(a) != 1u || be16(a + 2) != 0x0800u || a[4] != 6u || a[5] != 4u) return false;
    o->op = be16(a + 6);
    o->spa = be32(a + 14);
    o->tpa = be32(a + 24);
    return true;
}

bool pnet_sort_is_amiga_xid(const pnet_sort_t *s, uint32_t xid);
void pnet_sort_learn_xid(pnet_sort_t *s, uint32_t xid);
#endif
