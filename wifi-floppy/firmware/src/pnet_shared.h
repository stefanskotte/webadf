#ifndef PNET_SHARED_H
#define PNET_SHARED_H
/*
 * PaulaNET SHARED-IP MODE (operator ruling 2026-11-15: "hybrid, with one IP"). Pure: board (core1's network
 * context, the lwIP lock held) and host. The state lives in pnet_sort_t.sh (pnet_sort.h).
 *
 * WHY. The board and the Amiga share one MAC. A network that leases by chaddr alone (a phone hotspot, field report
 * 2026-11-15) ignores the two client-ids and offers the Amiga the board's own address. Before this mode the sorter
 * dropped that ACK, AmiTCP_NG retried REQUEST every ~4 s and fell back to 169.254 after ~30 s.
 *
 * ENTERED (pnet_sort.c; pnet_shared_why_t), never before one of:
 *   OFFER  the network OFFERs an Amiga xid the board's address -- the earliest signal. That OFFER is dropped and
 *          the board's own OFFER goes to the Amiga at once (pnet_shared_owed), so the Amiga does not wait 4 s.
 *   ACK    ...or ACKs it (the OFFER was missed). Dropped; the Amiga's next REQUEST is answered locally.
 *   SRC    the Amiga transmits from the board's address: it holds it from before a board reboot (AmiTCP_NG never
 *          renews), and the network still leases that address to the shared MAC.
 *   SEED   the server's last-known Amiga address (xfer.ip) is the board's own: an idle sharing Amiga after a board
 *          reboot, reachable at once (sh.amiga; Transfer goes to PNET_SHARED_AMIGA, inbound for its ports is its).
 *          The record can be stale -- a router gave the board the Amiga's old address while the Amiga runs on a
 *          lease of its own (review I2) -- and then the Amiga's first frame from that lease ends shared mode
 *          (below). Until it transmits, frames for its own lease reach the board only.
 * ENDS at a reboot (RAM only); when the board's address changes to another non-zero one (pnet_shared_follow): the
 * board is on another lease, maybe another network, and the Amiga keeps the old address (AmiTCP_NG has no T1/T2),
 * which from then on is simply its own in normal mode; or when the Amiga transmits from a non-zero address that is
 * neither the shared one nor 169.254/16 (pnet_shared_amiga_left, review I2): it holds a lease of its own, which
 * that frame teaches in normal mode. Its next DHCP re-enters shared mode if the clash recurs.
 * KNOWN (review minor 4, left as is): a board connection open to PNET_SHARED_AMIGA when shared mode ends (Transfer)
 * is not reset; its frames for 169.254.77.2 go to the radio, so it times out (lwIP's retransmits, then amiga_send's
 * own PONG/idle limits) and the next connect goes to the Amiga's new address. Likewise 169.254/16 senders never end
 * shared mode (review minor 2): an Amiga on link-local fallback is not on a lease of its own.
 * A board address of 0 (the link down) leaves it on. Network mode off/on does not end it (the Amiga keeps its address).
 *
 * WHILE ON:
 *   DHCP   every BOOTREQUEST from the Amiga is answered here, never sent to the radio: DISCOVER -> OFFER, REQUEST
 *          for the board's address -> ACK, REQUEST for any other -> NAK (the Amiga restarts at DISCOVER), others
 *          dropped. The lease: the board's address, mask, gateway and DNS, PNET_SHARED_LEASE_S, server id = the
 *          network's DHCP server (so a unicast renewal goes out and is still answered here). The network's own
 *          replies to an Amiga xid are dropped (sh.late).
 *   IN     (pnet_shared_rx) a frame from the radio:
 *            ARP claiming the shared address (sender = it)     -> the board only (AmiTCP would log "duplicate IP"
 *                                                                 and defend it: sana2arp.c)       [sh.arp_hidden]
 *            ARP reply to the shared address                   -> both (each resolves its own next hops)
 *            any other ARP (a request for it included)         -> the board (lwIP answers; one reply, not two)
 *            DHCP reply to an Amiga xid                        -> dropped                          [sh.late]
 *            UDP to the broadcast MAC, not multicast, to a port no board pcb owns -> the Amiga (review M1)
 *            any other broadcast / multicast (mDNS, SSDP, ...) -> the board, as in normal mode
 *            IPv4 to the shared address:
 *              TCP / UDP: a live lwIP pcb (active, listen, TIME_WAIT; UDP incl. DHCP 68, DNS) -> the board,
 *                         anything else -> the Amiga
 *              ICMP echo request -> the board only; echo reply -> the Amiga (lwIP sends no pings: LWIP_RAW off);
 *              ICMP errors (3, 4, 5, 11, 12) by the quoted header's tuple, quoted ICMP -> the Amiga
 *              non-first fragments: the owner of the first fragment by (source, IP id, protocol), PNET_SORT_FRAGS
 *                         remembered; a fragment whose first was not seen is DROPPED            [sh.frag_drops]
 *            everything else                                   -> the board
 *   OUT    lwIP's ephemeral ports are 0x8000-0xBFFF (lwipopts.h), AmiTCP_NG's 49152-65535, so the two never pick
 *          the same tuple. Verified in AmiTCP_NG's source (review M3): netinclude/netinet/in.h:122 IPPORT_ANONMIN
 *          49152; netinet/in_pcb.c:294-297 and :315-316 keep every ephemeral pick in 49152..65535 (random step,
 *          then a bounded scan that wraps back to 49152); TCP connect, UDP sendto/connect and its resolver
 *          (api/res_send.c:199/339 connect, no bind) all reach that pick through in_pcbconnect (:493). Only an
 *          explicit bind() leaves it (Transfer's 6800). The Amiga may send from the shared address.
 *   LOCAL  board <-> Amiga cannot use one address both ways, so on the bus the board is PNET_SHARED_BOARD to the
 *          Amiga and the Amiga is PNET_SHARED_AMIGA to the board (169.254/16: lwIP ARPs for it directly, never via
 *          the gateway). pnet_shared_b2a/a2b pick the frames; pnet_shared_to_amiga/to_board rewrite the addresses
 *          (IPv4 header + TCP/UDP checksums, RFC 1624; ARP; an ICMP error's quoted header with its checksum and
 *          the ICMP checksum, review M2) and the MACs (the local MAC twin, pnet_sort.h). The
 *          board's Transfer connection goes to PNET_SHARED_AMIGA (pnet_sort_send_ip).
 *
 * Addresses are host order; 0 is "unknown".
 */
#include "pnet_sort.h"
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PNET_SHARED_BOARD   0xA9FE4D01u   /* 169.254.77.1: the board, as the Amiga sees it on the bus */
#define PNET_SHARED_AMIGA   0xA9FE4D02u   /* 169.254.77.2: the Amiga, as the board addresses it */
#define PNET_SHARED_LEASE_S 300u
#define PNET_DHCP_REPLY_MIN 342u          /* Ethernet 14 + IPv4 20 + UDP 8 + a 300-byte BOOTP message */
#define PNET_DHCP_REPLY_MAX 590u          /* ...+ 236 + 312 bytes of options (a long echoed client-id: review I1) */

/* What the board hands the Amiga: its own lease (glue: lwIP's netif, dns_getserver, the DHCP server id). */
typedef struct { uint32_t ip, mask, gw, dns[2], server; uint8_t mac[6]; } pnet_lease_t;

void pnet_shared_enter(pnet_sort_t *s, uint32_t board_ip, pnet_shared_why_t why);
/* Ends shared mode when the board's address is non-zero and no longer the shared one. */
void pnet_shared_follow(pnet_sort_t *s, uint32_t board_ip);
pnet_sort_to_t pnet_shared_rx(pnet_sort_t *s, const uint8_t *f, size_t len);
/* A frame from the Amiga with the shared MAC as its source and a sane length (pnet_sort_tx checked both). */
pnet_tx_t pnet_shared_tx(pnet_sort_t *s, const uint8_t *f, size_t len);
/* Review I2: a frame from the Amiga whose ARP sender / IPv4 source is non-zero, not the shared address and not
 * 169.254/16 -- the Amiga holds a lease of its own. Ends shared mode (amiga_ip 0, for the frame to teach) and
 * returns true; false (nothing changed) otherwise or when shared mode is off. */
bool pnet_shared_amiga_left(pnet_sort_t *s, const uint8_t *f, size_t len);
/* Review M4: the owed OFFER found the RX ring full. True once per owed OFFER (count the drop then), false after. */
bool pnet_shared_owe_full(pnet_sort_t *s);

/* In shared mode: a BOOTREQUEST from the Amiga, which never goes to the radio. */
bool pnet_shared_is_dhcp(const pnet_sort_t *s, const uint8_t *f, size_t len);
/* The reply to that request, written to out: its length (PNET_DHCP_REPLY_MIN..MAX), or 0 for none -- also when cap
 * is short of that length, in which case nothing is written. */
size_t pnet_shared_dhcp_reply(pnet_sort_t *s, const uint8_t *req, size_t len, const pnet_lease_t *L,
                              uint8_t *out, size_t cap);
/* The OFFER owed for the network OFFER that turned shared mode on: its length, or 0 (none owed). Clears the debt. */
size_t pnet_shared_owed(pnet_sort_t *s, const pnet_lease_t *L, uint8_t *out, size_t cap);

/* The local path in shared mode. a2b: a frame from the Amiga for PNET_SHARED_BOARD (ARP target or IPv4 dest).
 * b2a: a frame from the board for PNET_SHARED_AMIGA. Both false when shared mode is off. */
bool pnet_shared_a2b(const pnet_sort_t *s, const uint8_t *f, size_t len);
bool pnet_shared_b2a(const pnet_sort_t *s, const uint8_t *f, size_t len);
/* In place. to_board: PNET_SHARED_BOARD -> ip as the destination, ip -> PNET_SHARED_AMIGA as the source, the
 * Ethernet destination -> mac (the Amiga may have addressed its gateway), an ARP target MAC that is the local MAC ->
 * mac. to_amiga: ip -> PNET_SHARED_BOARD as the source, PNET_SHARED_AMIGA -> ip as the destination, and the
 * shared MAC -> the local MAC as the Ethernet source and ARP sender. Checksums follow. */
void pnet_shared_to_board(uint8_t *f, size_t len, uint32_t ip, const uint8_t mac[6]);
void pnet_shared_to_amiga(uint8_t *f, size_t len, uint32_t ip, const uint8_t mac[6]);

/* The address the board's Transfer connection goes to: PNET_SHARED_AMIGA in shared mode once the Amiga is known
 * to use the shared address (else 0), the learned amiga_ip otherwise (unchanged). */
uint32_t pnet_sort_send_ip(const pnet_sort_t *s);
#endif
