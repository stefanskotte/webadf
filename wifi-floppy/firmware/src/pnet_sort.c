/* The layer-2 sharing sorter (pnet_sort.h). */
#include "pnet_sort.h"
#include "pnet_shared.h"
#include "pnet_wire.h"         /* be16, be32, ip4, bootp_at, dhcp_type (moved there unchanged for pnet_shared.c) */
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

bool pnet_sort_is_amiga_xid(const pnet_sort_t *s, uint32_t xid) {
    for (unsigned i = 0; i < s->nxid; i++)
        if (s->xid[i] == xid) return true;
    return false;
}
#define is_amiga_xid pnet_sort_is_amiga_xid

void pnet_sort_init(pnet_sort_t *s) { memset(s, 0, sizeof *s); }

pnet_sort_to_t pnet_sort_rx(pnet_sort_t *s, const uint8_t *f, size_t len, uint32_t board_ip) {
    pnet_shared_follow(s, board_ip);                                   /* ends shared mode if the address moved */
    if (s->sh.on) return pnet_shared_rx(s, f, len);
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
            if ((type == 5u || type == 2u) && board_ip != 0u && yi == board_ip) {
                // The network leases by MAC alone and offers the Amiga the board's own address: shared-IP mode. An
                // OFFER is the earliest signal; the board answers it at once with its own (pnet_shared_owed).
                s->clash++;
                pnet_shared_enter(s, board_ip, type == 2u ? PNET_SHARED_OFFER : PNET_SHARED_ACK);
                if (type == 2u) { s->sh.owe = true; s->sh.owe_xid = xid; s->sh.owe_flags = be16(f + b + 10u); }
                return PNET_SORT_DROP;
            }
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

void pnet_sort_learn_xid(pnet_sort_t *s, uint32_t xid) {
    if (is_amiga_xid(s, xid)) return;
    s->xid[s->xid_next] = xid;
    s->xid_next = (uint8_t)((s->xid_next + 1u) % PNET_SORT_XIDS);
    if (s->nxid < PNET_SORT_XIDS) s->nxid++;
}

pnet_tx_t pnet_sort_tx(pnet_sort_t *s, const uint8_t *f, size_t len, const uint8_t mac[6], uint32_t board_ip) {
    if (len < ETH_HDR || len > PNET_SORT_MTU) return PNET_TX_LEN;
    if (memcmp(f + 6, mac, 6) != 0) return PNET_TX_MAC;
    pnet_shared_follow(s, board_ip);
    // Review I2: an Amiga transmitting from an address of its own ends shared mode; the frame then teaches that
    // address below, exactly as in normal mode.
    if (s->sh.on && !pnet_shared_amiga_left(s, f, len)) return pnet_shared_tx(s, f, len);
    const uint16_t type = be16(f + 12);
    if (type == 0x0806u) {
        if (len < ETH_HDR + 28u) return PNET_TX_LEN;
        const uint32_t spa = be32(f + ETH_HDR + 14u);
        if (spa != 0u && spa == board_ip) {                   /* the Amiga holds the board's address: shared */
            s->clash++;
            pnet_shared_enter(s, board_ip, PNET_SHARED_SRC);
            return pnet_shared_tx(s, f, len);
        }
        if (spa != 0u) s->amiga_ip = spa;
        return PNET_TX_SEND;
    }
    if (type != 0x0800u) return PNET_TX_TYPE;
    ip4_t ip;
    if (!ip4(f, len, &ip)) return PNET_TX_LEN;
    if (ip.src != 0u && ip.src == board_ip) {
        s->clash++;
        pnet_shared_enter(s, board_ip, PNET_SHARED_SRC);
        return pnet_shared_tx(s, f, len);
    }
    const size_t b = bootp_at(f, len, &ip, 68u, 67u);
    if (b != 0u && f[b] == 1u) pnet_sort_learn_xid(s, be32(f + b + 4u));
    else if (ip.src != 0u) s->amiga_ip = ip.src;
    return PNET_TX_SEND;
}

bool pnet_sort_seed(pnet_sort_t *s, uint32_t ip, uint32_t board_ip) {
    // board_ip 0: not decidable yet (is the seed the board's own?) -- refused, the caller retries (pnet_bridge.c).
    if (s->amiga_ip != 0u || ip == 0u || board_ip == 0u) return false;
    if (ip == board_ip) {        /* shared before a reboot (or a stale record: pnet_shared_amiga_left corrects it) */
        s->sh.seed_hint = true;
        pnet_shared_enter(s, board_ip, PNET_SHARED_SEED);
        s->sh.amiga = true;
        return true;
    }
    s->amiga_ip = ip;
    return true;
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
