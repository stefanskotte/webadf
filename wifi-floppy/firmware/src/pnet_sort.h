#ifndef PNET_SORT_H
#define PNET_SORT_H
/*
 * PaulaNET Phase 1 (plan docs/superpowers/plans/2026-10-11-paulanet-phase1-l2-sharing.md): the
 * board and the Amiga share the board's Wi-Fi MAC (research 2026-10-09 §2.2, option A). This
 * decides, per frame, whose it is. Pure: board (core1's network context) and host.
 *
 * ONE IP BY DEFAULT (operator ruling 2026-11-16, "make one-ip the default, so board only ever requires one DHCP
 * address"): while DF1 is in Network mode and the board has an address, the Amiga SHARES it (pnet_shared.h) -- the
 * board answers the Amiga's DHCP itself and both functions below hand over to pnet_shared_rx / pnet_shared_tx. The
 * normal (two-address) sorting below is what is left for an Amiga with a static address of its own (sh.own), and
 * for the time before the board's first address:
 *
 * Inbound (pnet_sort_rx), the board loses nothing it had before except two kinds of frame:
 *   - IPv4 unicast to the Amiga's address          -> the Amiga only
 *   - a DHCP reply (UDP 67 -> 68) to an Amiga xid  -> dropped (the board answers the Amiga's DHCP)
 *   - ARP whose target address is the Amiga's      -> both
 *   - everything else                              -> the board, exactly as before
 * The Amiga's address is never the board's outside shared mode: if they ever match, the Amiga is treated as
 * having none, so the board's own traffic stays the board's.
 *
 * Outbound (pnet_sort_tx): a frame from the Amiga goes out only with the board's MAC as its
 * source, as ARP or IPv4. Its ARP sender and IPv4 source teach the Amiga's address. Before the board has an
 * address a BOOTREQUEST is held (PNET_TX_HOLD): the network must never lease the Amiga a second address. A
 * BOOTREQUEST, or a frame from the board's own address, ends two-address mode (the Amiga is on DHCP again).
 *
 * Addresses are host-order uint32_t (192.168.1.57 = 0xC0A80139); 0 is "unknown".
 */
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>

#define PNET_SORT_MTU        1518u   /* the largest frame either way, VLAN tag included */
#define PNET_SORT_XIDS       4u
#define PNET_CLIENT_ID_BYTES 11u     /* option 61: code, length 9, type 0, 'w', 'f', MAC */

typedef enum { PNET_SORT_DROP = 0, PNET_SORT_BOARD = 1, PNET_SORT_AMIGA = 2, PNET_SORT_BOTH = 3 } pnet_sort_to_t;
/* PNET_TX_HOLD: the frame is held back, never sent (pnet_shared.h): a BOOTREQUEST before the board has an address,
 * or a frame from an address that is not the shared one while the Amiga is being moved onto it. */
typedef enum { PNET_TX_SEND = 0, PNET_TX_LEN, PNET_TX_MAC, PNET_TX_TYPE, PNET_TX_HOLD, PNET_TX_N } pnet_tx_t;

/* SHARED-IP MODE, the default (pnet_shared.h has the design). */
#define PNET_SORT_FRAGS 4u
typedef struct { uint32_t src; uint16_t id; uint8_t proto, to; } pnet_frag_t;   /* a fragmented datagram's owner */
#define PNET_SHARED_FORMER 2u
typedef struct { uint32_t ip, t; } pnet_former_t;   /* an address the Amiga was moved off, and when (ms) */
typedef struct {
    bool     on;         /* shared: Network mode with a board address, and the Amiga not on an address of its own */
    bool     own;        /* two-address mode: the Amiga keeps a (static) address of its own -- the escape */
    bool     amiga;      /* the Amiga is known to hold the shared address (ACKed, or seen sending from it) */
    bool     spent;      /* a re-address (down_req) was asked since the Amiga was last seen on the shared address */
    bool     down_want;  /* ...and is still wanted (false: withdrawn, the Amiga came back by itself) */
    uint32_t ip;         /* the board's address, which the Amiga shares */
    uint32_t mask;       /* the board's netmask (pnet_sort_set_mask); 0 = not known */
    uint32_t old;        /* the shared address before the board's last move (the log's reading; 0 = none) */
    uint32_t down_req;   /* re-addresses asked: a CURSOR, core0 tells the driver the link is down once per value */
    uint32_t down_done;  /* the last one core0 finished (pnet_down_t.done, copied in by the glue) */
    uint32_t entered;    /* times shared mode began (boot, or the Amiga back on DHCP after two-address mode) */
    uint32_t moved;      /* the board's address changed under shared mode */
    uint32_t own_n;      /* times the Amiga was left on an address of its own (two-address mode) */
    uint32_t held;       /* frames from the Amiga held back (PNET_TX_HOLD) */
    uint32_t offers, acks, naks;   /* replies built for the Amiga */
    uint32_t late;       /* the network's DHCP replies to an Amiga xid, dropped */
    uint32_t frag_drops; /* non-first fragments whose first fragment was not seen */
    uint32_t stale;      /* frames from a FORMER address after the Amiga moved on, dropped (review 2026-11-16) */
    uint32_t now;        /* ms, set by the glue before every call (pnet_sort_set_clock): the formers' age */
    uint8_t  asks;       /* re-addresses asked in this episode (PNET_READDRESS_TRIES at most) */
    uint8_t  former_next;
    pnet_former_t former[PNET_SHARED_FORMER];
    uint32_t arp_hidden; /* ARP from the radio claiming the shared address, kept from the Amiga */
    uint8_t  frag_next;
    pnet_frag_t frag[PNET_SORT_FRAGS];
} pnet_shared_t;
/* Shared mode's inbound demux: true when lwIP holds a live pcb for this tuple (proto 6 or 17; host order). */
typedef bool (*pnet_owns_fn)(void *ctx, uint8_t proto, uint16_t lport, uint32_t rip, uint16_t rport);

typedef struct {
    uint32_t amiga_ip;
    uint32_t xid[PNET_SORT_XIDS];
    uint8_t  nxid, xid_next;
    uint32_t clash;
    uint32_t to_amiga, to_both;
    pnet_shared_t sh;
    pnet_owns_fn  owns;    /* NULL: no pcb is the board's */
    void         *owns_ctx;
} pnet_sort_t;

void pnet_sort_init(pnet_sort_t *s);
/* `f` is the frame's first `len` bytes (the whole frame, or its first pbuf). */
pnet_sort_to_t pnet_sort_rx(pnet_sort_t *s, const uint8_t *f, size_t len, uint32_t board_ip);
/* A frame from the Amiga: PNET_TX_SEND, or why not. Learns from what it lets through. */
pnet_tx_t pnet_sort_tx(pnet_sort_t *s, const uint8_t *f, size_t len, const uint8_t mac[6], uint32_t board_ip);

/* The board's netmask, for the static-address escape (pnet_shared.h): the glue sets it with the address. */
void pnet_sort_set_mask(pnet_sort_t *s, uint32_t mask);
/* The clock (ms, wrapping) the former addresses age by (pnet_shared.h): the glue sets it with the mask. */
void pnet_sort_set_clock(pnet_sort_t *s, uint32_t now_ms);
/* Phase 4 (local reachability): the board and the Amiga share one MAC, so a frame between them never comes back
 * from the radio, and must be handed across here. a2b: a frame from the Amiga (already PNET_TX_SEND) that is ARP
 * whose target address is the board's, or IPv4 to the board's address -> the board's lwIP, not the radio. b2a: a
 * frame from the board's lwIP that is ARP whose target is the Amiga's address, or IPv4 to it -> the Amiga's RX ring,
 * not the radio. False whenever an address is unknown (0), or the Amiga's would be the board's. */
bool pnet_sort_a2b_local(const uint8_t *f, size_t len, uint32_t board_ip);
bool pnet_sort_b2a_local(const pnet_sort_t *s, const uint8_t *f, size_t len, uint32_t board_ip);
/* The board's LOCAL MAC: the shared MAC with the locally-administered bit (0x02 of the first byte) flipped. A BSD
 * stack (AmiTCP) ignores any ARP whose sender is its own MAC (bench 2026-10-15: the board's IP stayed "incomplete"),
 * so on the local path the board shows the Amiga this MAC instead. to_amiga: a board frame for the Amiga -- its
 * Ethernet source and ARP sender, when they are the shared MAC, become the local MAC. to_board: an Amiga frame for
 * the board -- its Ethernet destination and ARP target, when they are the local MAC, become the shared MAC again. */
void pnet_local_mac(const uint8_t mac[6], uint8_t out[6]);
void pnet_local_to_amiga(uint8_t *f, size_t len, const uint8_t mac[6]);
void pnet_local_to_board(uint8_t *f, size_t len, const uint8_t mac[6]);
/* Appends the board's DHCP client-id (option 61, type 0, "wf" + MAC) at opts[used] if it fits in
 * cap; returns the new length, or `used` unchanged when it does not. */
size_t pnet_dhcp_client_id(uint8_t *opts, size_t used, size_t cap, const uint8_t mac[6]);
/* Dotted quad, NUL-terminated. */
void pnet_ip_text(uint32_t ip, char out[16]);
#endif
