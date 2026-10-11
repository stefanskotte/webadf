#ifndef PNET_SORT_H
#define PNET_SORT_H
/*
 * PaulaNET Phase 1 (plan docs/superpowers/plans/2026-10-11-paulanet-phase1-l2-sharing.md): the
 * board and the Amiga share the board's Wi-Fi MAC (research 2026-10-09 §2.2, option A). This
 * decides, per frame, whose it is. Pure: board (core1's network context) and host.
 *
 * Inbound (pnet_sort_rx), the board loses nothing it had before except two kinds of frame:
 *   - IPv4 unicast to the Amiga's address          -> the Amiga only
 *   - a DHCP reply (UDP 67 -> 68) to an Amiga xid  -> the Amiga only (lwIP drops a foreign xid anyway)
 *   - ARP whose target address is the Amiga's      -> both
 *   - everything else                              -> the board, exactly as before
 * An Amiga ACK whose yiaddr is the board's own address is DROPPED (a router that keys leases on
 * the MAC alone; §2.2 mitigation 2). The Amiga's address is never the board's: if they ever match,
 * the Amiga is treated as having none, so the board's own traffic stays the board's.
 *
 * Outbound (pnet_sort_tx): a frame from the Amiga goes out only with the board's MAC as its
 * source, as ARP or IPv4, and never from the board's address. Its ARP sender and IPv4 source
 * teach the Amiga's address; its BOOTREQUESTs teach its DHCP xids (the last PNET_SORT_XIDS).
 *
 * Addresses are host-order uint32_t (192.168.1.57 = 0xC0A80139); 0 is "unknown".
 */
#include <stdint.h>
#include <stddef.h>

#define PNET_SORT_MTU        1518u   /* the largest frame either way, VLAN tag included */
#define PNET_SORT_XIDS       4u
#define PNET_CLIENT_ID_BYTES 11u     /* option 61: code, length 9, type 0, 'w', 'f', MAC */

typedef enum { PNET_SORT_DROP = 0, PNET_SORT_BOARD = 1, PNET_SORT_AMIGA = 2, PNET_SORT_BOTH = 3 } pnet_sort_to_t;
typedef enum { PNET_TX_SEND = 0, PNET_TX_LEN, PNET_TX_MAC, PNET_TX_TYPE, PNET_TX_CLASH, PNET_TX_N } pnet_tx_t;

typedef struct {
    uint32_t amiga_ip;
    uint32_t xid[PNET_SORT_XIDS];
    uint8_t  nxid, xid_next;
    uint32_t clash;
    uint32_t to_amiga, to_both;
} pnet_sort_t;

void pnet_sort_init(pnet_sort_t *s);
/* `f` is the frame's first `len` bytes (the whole frame, or its first pbuf). */
pnet_sort_to_t pnet_sort_rx(pnet_sort_t *s, const uint8_t *f, size_t len, uint32_t board_ip);
/* A frame from the Amiga: PNET_TX_SEND, or why not. Learns from what it lets through. */
pnet_tx_t pnet_sort_tx(pnet_sort_t *s, const uint8_t *f, size_t len, const uint8_t mac[6], uint32_t board_ip);
/* Appends the board's DHCP client-id (option 61, type 0, "wf" + MAC) at opts[used] if it fits in
 * cap; returns the new length, or `used` unchanged when it does not. */
size_t pnet_dhcp_client_id(uint8_t *opts, size_t used, size_t cap, const uint8_t mac[6]);
/* Dotted quad, NUL-terminated. */
void pnet_ip_text(uint32_t ip, char out[16]);
#endif
