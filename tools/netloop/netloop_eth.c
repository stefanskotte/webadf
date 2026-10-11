/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
/* NetLoop's hand-made Ethernet (netloop_eth.h). */
#include "netloop_eth.h"
#include <stdio.h>
#include <string.h>

static void put16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)(v >> 8); p[1] = (uint8_t)v; }
static void put32(uint8_t *p, uint32_t v) { put16(p, (uint16_t)(v >> 16)); put16(p + 2, (uint16_t)v); }
static uint16_t get16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }
static uint32_t get32(const uint8_t *p) { return (uint32_t)get16(p) << 16 | get16(p + 2); }
static const uint8_t BCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

static int hex(char c) {
    return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10
         : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
}

int nl_parse_mac(const char *s, uint8_t mac[6]) {
    for (int i = 0; i < 6; i++) {
        const int h = hex(s[0]), l = hex(s[1]);
        if (h < 0 || l < 0) return 0;
        mac[i] = (uint8_t)(h * 16 + l);
        s += 2;
        if (i < 5) { if (*s != ':' && *s != '-') return 0; s++; }
    }
    return *s == '\0';
}

int nl_arg_fits(const char *s, size_t cap) { return strlen(s) < cap; }

int nl_parse_ip(const char *s, uint32_t *ip) {
    uint32_t v = 0;
    for (int i = 0; i < 4; i++) {
        unsigned n = 0;
        int d = 0;
        while (*s >= '0' && *s <= '9' && d < 3) { n = n * 10u + (unsigned)(*s - '0'); s++; d++; }
        if (d == 0 || n > 255u) return 0;
        v = v << 8 | n;
        if (i < 3) { if (*s != '.') return 0; s++; }
    }
    if (*s != '\0') return 0;
    *ip = v;
    return 1;
}

void nl_ip_text(uint32_t ip, char out[16]) {
    sprintf(out, "%u.%u.%u.%u", (unsigned)(ip >> 24), (unsigned)(ip >> 16 & 255u),
            (unsigned)(ip >> 8 & 255u), (unsigned)(ip & 255u));
}

static size_t eth(uint8_t *f, const uint8_t *dst, const uint8_t *src, uint16_t type) {
    memcpy(f, dst, 6);
    memcpy(f + 6, src, 6);
    put16(f + 12, type);
    return 14;
}

size_t nl_arp_request(uint8_t *f, const uint8_t mac[6], uint32_t spa, uint32_t tpa) {
    memset(f, 0, NL_ETH_MIN);
    uint8_t *a = f + eth(f, BCAST, mac, 0x0806u);
    put16(a, 1); put16(a + 2, 0x0800u); a[4] = 6; a[5] = 4; put16(a + 6, 1);
    memcpy(a + 8, mac, 6); put32(a + 14, spa); put32(a + 24, tpa);
    return NL_ETH_MIN;
}

int nl_arp_reply_from(const uint8_t *f, size_t len, uint32_t asked, uint8_t mac_out[6]) {
    if (len < 42u || get16(f + 12) != 0x0806u) return 0;
    const uint8_t *a = f + 14;
    if (get16(a + 6) != 2u || get32(a + 14) != asked) return 0;
    memcpy(mac_out, a + 8, 6);
    return 1;
}

static uint16_t ip_csum(const uint8_t *h) {
    uint32_t s = 0;
    for (int i = 0; i < 20; i += 2) s += get16(h + i);
    while (s >> 16) s = (s & 0xFFFFu) + (s >> 16);
    return (uint16_t)~s;
}

static size_t dhcp_frame(uint8_t *f, size_t cap, const uint8_t mac[6], uint32_t xid, uint8_t type,
                         uint32_t want, uint32_t server) {
    if (cap < NL_DHCP_FRAME_BYTES) return 0;
    memset(f, 0, NL_DHCP_FRAME_BYTES);
    uint8_t *ip = f + eth(f, BCAST, mac, 0x0800u);
    ip[0] = 0x45; put16(ip + 2, (uint16_t)(NL_DHCP_FRAME_BYTES - 14u)); ip[8] = 64; ip[9] = 17;
    put32(ip + 16, 0xFFFFFFFFu);                               /* from 0.0.0.0 */
    put16(ip + 10, ip_csum(ip));
    uint8_t *u = ip + 20;
    put16(u, 68); put16(u + 2, 67); put16(u + 4, (uint16_t)(8u + NL_BOOTP_BYTES));   /* checksum 0: none */
    uint8_t *b = u + 8;
    b[0] = 1; b[1] = 1; b[2] = 6;
    put32(b + 4, xid);
    memcpy(b + 28, mac, 6);
    put32(b + 236, 0x63825363u);
    uint8_t *o = b + 240;
    *o++ = 53; *o++ = 1; *o++ = type;
    *o++ = 61; *o++ = 7; *o++ = 1; memcpy(o, mac, 6); o += 6;
    if (want) { *o++ = 50; *o++ = 4; put32(o, want); o += 4; }
    if (server) { *o++ = 54; *o++ = 4; put32(o, server); o += 4; }
    *o++ = 55; *o++ = 4; *o++ = 1; *o++ = 3; *o++ = 6; *o++ = 51;
    *o = 255;
    return NL_DHCP_FRAME_BYTES;
}

size_t nl_dhcp_discover(uint8_t *f, size_t cap, const uint8_t mac[6], uint32_t xid) {
    return dhcp_frame(f, cap, mac, xid, 1, 0, 0);
}

size_t nl_dhcp_request(uint8_t *f, size_t cap, const uint8_t mac[6], uint32_t xid, uint32_t yiaddr, uint32_t server) {
    return dhcp_frame(f, cap, mac, xid, 3, yiaddr, server);
}

int nl_dhcp_parse(const uint8_t *f, size_t len, uint32_t xid, nl_dhcp_t *out) {
    memset(out, 0, sizeof *out);
    if (len < 14u + 20u + 8u + 240u || get16(f + 12) != 0x0800u) return 0;
    const uint8_t *ip = f + 14;
    const size_t ihl = (size_t)(ip[0] & 15u) * 4u;
    if ((ip[0] >> 4) != 4u || ihl < 20u || ip[9] != 17u || len < 14u + ihl + 8u + 240u) return 0;
    const size_t u = 14u + ihl, b = u + 8u;
    if (get16(f + u) != 67u || get16(f + u + 2) != 68u) return 0;
    if (f[b] != 2u || get32(f + b + 4) != xid || get32(f + b + 236) != 0x63825363u) return 0;
    out->yiaddr = get32(f + b + 16);
    size_t i = b + 240u;
    while (i < len && f[i] != 255u) {
        if (f[i] == 0u) { i++; continue; }
        if (len - i < 2u || len - i - 2u < f[i + 1]) break;
        const uint8_t code = f[i], n = f[i + 1];
        const uint8_t *v = f + i + 2;
        if (code == 53u && n == 1u) out->type = v[0];
        else if (n >= 4u) {
            if (code == 54u) out->server = get32(v);
            else if (code == 3u) out->router = get32(v);
            else if (code == 6u) out->dns = get32(v);
            else if (code == 1u) out->mask = get32(v);
            else if (code == 51u) out->lease = get32(v);
        }
        i += 2u + n;
    }
    return out->type != 0u;
}

uint8_t nl_l2_start_ack(uint8_t served) { return (uint8_t)(served - 1u); }

const char *nl_eth_selftest(void) {
    static uint8_t f[NL_DHCP_FRAME_BYTES];
    static const uint8_t mac[6] = {0x02, 0, 0, 0, 0, 0x01};
    uint8_t got[6];
    uint32_t ip;
    nl_dhcp_t d;
    char t[16];
    if (!nl_parse_mac("02:00:00:00:00:01", got) || memcmp(got, mac, 6) != 0) return "parse mac";
    if (nl_parse_mac("02:00:00:00:00", got) || nl_parse_mac("02:00:00:00:00:01x", got)) return "bad mac taken";
    if (!nl_parse_ip("192.168.1.57", &ip) || ip != 0xC0A80139u) return "parse ip";
    if (nl_parse_ip("192.168.1.256", &ip) || nl_parse_ip("192.168.1", &ip)) return "bad ip taken";
    nl_ip_text(0xC0A80139u, t);
    if (strcmp(t, "192.168.1.57") != 0) return "ip text";
    if (!nl_arg_fits("192.168.100.100", 16) || nl_arg_fits("192.168.100.1000", 16)) return "arg length";
    if (nl_l2_start_ack(0x40) != 0x3F || nl_l2_start_ack(0) != 0xFF) return "l2 start ack";
    /* The request, turned into the router's reply. */
    if (nl_arp_request(f, mac, 0xC0A80139u, 0xC0A80101u) != NL_ETH_MIN) return "arp size";
    f[14 + 7] = 2;
    memcpy(f + 14 + 8, "\x00\x11\x22\x33\x44\x55", 6);
    put32(f + 14 + 14, 0xC0A80101u);
    if (!nl_arp_reply_from(f, NL_ETH_MIN, 0xC0A80101u, got) || got[5] != 0x55) return "arp reply";
    if (nl_arp_reply_from(f, NL_ETH_MIN, 0xC0A80102u, got)) return "arp reply from another";
    /* The DISCOVER, checked, then turned into an OFFER. */
    if (nl_dhcp_discover(f, sizeof f, mac, 0x12345678u) != NL_DHCP_FRAME_BYTES) return "discover size";
    if (ip_csum(f + 14) != 0) return "ip checksum";
    if (nl_dhcp_parse(f, sizeof f, 0x12345678u, &d)) return "a request parsed as a reply";
    const size_t u = 34, b = 42;
    put16(f + u, 67); put16(f + u + 2, 68);
    f[b] = 2;
    put32(f + b + 16, 0xC0A80139u);
    uint8_t *o = f + b + 240;
    *o++ = 53; *o++ = 1; *o++ = 2;
    *o++ = 54; *o++ = 4; put32(o, 0xC0A80101u); o += 4;
    *o++ = 3; *o++ = 4; put32(o, 0xC0A80101u); o += 4;
    *o++ = 51; *o++ = 4; put32(o, 86400u); o += 4;
    *o = 255;
    if (!nl_dhcp_parse(f, sizeof f, 0x12345678u, &d)) return "offer";
    if (d.type != 2 || d.yiaddr != 0xC0A80139u || d.server != 0xC0A80101u || d.router != 0xC0A80101u ||
        d.lease != 86400u) return "offer fields";
    if (nl_dhcp_parse(f, sizeof f, 0x12345679u, &d)) return "another xid";
    if (nl_dhcp_parse(f, 100, 0x12345678u, &d)) return "short frame";
    return NULL;
}
