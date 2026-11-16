#ifndef PNET_SHARED_H
#define PNET_SHARED_H
/*
 * PaulaNET SHARED-IP MODE -- THE DEFAULT. Pure: board (core1's network context, the lwIP lock held) and host. The
 * state lives in pnet_sort_t.sh (pnet_sort.h).
 *
 * WHY. Operator ruling 2026-11-16: "make one-ip the default, so board only ever requires one DHCP address -- it's a
 * non standard set up to require two ip's". The board and the Amiga share one MAC; the board takes the only lease
 * and the Amiga always shares it. (2026-11-15 this mode was entered only on a trigger -- a network OFFER/ACK of the
 * board's address to the Amiga, the Amiga sending from it, or the server's seed -- and otherwise the Amiga got a
 * lease of its own. On an iPhone hotspot 2026-11-16 none fired and the Amiga took a second lease, .3 beside the
 * board's .2. The triggers, the owed OFFER and the seed are gone: nothing is left for them to decide.)
 *
 * ON whenever DF1 is in Network mode and the board has a non-zero address (pnet_shared_follow, from both sorter
 * entry points), from the first frame. An address of 0 (the link down) leaves it as it is. Before the board's first
 * address the Amiga's BOOTREQUESTs are HELD (pnet_sort.h), so the network never leases it a second address; AmiTCP_NG
 * retries every ~4 s.
 *
 * THE BOARD'S ADDRESS CHANGES (a switch of network -- wayfart to a hotspot -- or a new lease). AmiTCP_NG never
 * renews (no T1/T2), so the Amiga keeps the old address, and with it the old network's mask, gateway and DNS.
 * Decision 2026-11-16: the board makes the Amiga ask again, by telling its driver once that the link is DOWN
 * (pnet_status.h pnet_down_t; the request is the cursor sh.down_req, so a repeat and a withdrawal are both
 * expressible). Rob's PaulaNET.device (device.c:735-750) reads the status cylinder every 5 s; DOWN makes it reject
 * its pending reads (S2ERR_OUTOFSERVICE) and send S2EVENT_OFFLINE, the next UP sends S2EVENT_ONLINE. AmiTCP_NG
 * (net/if_sana.c S2ERR_OUTOFSERVICE -> sana_offline_cleanup; sana_online -> sana_back_online ->
 * ng_reconfigure_interface) then reads DEVS:NetInterfaces/eth0 again and, configure=dhcp, sends a DISCOVER -- which
 * this board answers with its NEW address, mask, gateway and DNS. Until the pulse is over (pnet_down_t: one DOWN
 * record, then UP, then PNET_DOWN_GRACE_MS) the Amiga's frames from the old address are held, never sent: they would
 * carry another network's address onto this one. A REQUEST for the old address is NAKed (as any other).
 *   REJECTED, translation (rewrite the old address to the new one both ways with the RFC 1624 helpers below): it is
 *   right only while the new address is on the same subnet behind the same gateway. A move between networks -- the
 *   case that happens -- leaves the Amiga's gateway, its ARP entry for that gateway's MAC, its mask and its DNS
 *   server all on the old network; translating that means rewriting next-hop MACs and DNAT-ing DNS, i.e. a router.
 *   A fresh lease from the board fixes every field at once, in the Amiga's own stack.
 *   COST: the DOWN drops the Amiga's connections (they are dead on a new network anyway, and the board's own link
 *   to Transfer reconnects as after a board reboot). A Wi-Fi drop that comes back on the SAME address changes
 *   nothing (fw 1.21.1: never DOWN for a rejoin).
 *
 * THE ESCAPE: an Amiga with a STATIC address of its own (pnet_shared_foreign). A frame from the Amiga whose source
 * is non-zero and not the shared address:
 *   - inside the board's subnet (sh.mask), with no re-address pending: a static address that can work here. Shared
 *     mode ends at once and the Amiga keeps that address in normal two-address mode (sh.own; the frame teaches it,
 *     exactly as before shared mode existed). This is also what an Amiga that held the board's previous address
 *     across a board REBOOT looks like when the network gave the board another one on the same subnet: it keeps that
 *     address as its own (rare: the board's client-id keeps its lease).
 *   - outside it (another network's address, 169.254/16 link-local fallback, or a mask not known): it cannot work
 *     here. Held, and one re-address asked; if the Amiga still sends from it once the pulse is over (its stack did not
 *     ask again: a static setup, or a stack that does not reconfigure when its device comes back online), it is left
 *     on it in two-address mode too.
 *   A re-address is tried PNET_READDRESS_TRIES times (one DOWN each) before giving up: nothing confirms the driver
 *   read a DOWN record (review minor 3).
 * FORMER ADDRESSES (review I1, 2026-11-16). AmiTCP_NG's offline only sets ENETDOWN on its pcbs (if_sana.c
 * sana_offline_cleanup -> in_ifdown_notify), so connections on the old address keep retransmitting and FINing for
 * minutes after the Amiga took the new lease. Every address the Amiga is moved off -- the board's previous address
 * at a move, and a foreign address it is asked to leave -- is remembered (two, round-robin, with when): once the
 * Amiga is on the shared address, frames from one are dropped and counted (sh.stale), never a new ask, never the
 * escape, for PNET_FORMER_MS. A former address is never "here" either, so it is asked about rather than taken as
 * static. (The clock is sh.now, set by the glue.)
 *   Two-address mode ends when the Amiga sends a BOOTREQUEST (it is on DHCP again: answered here) or sends from the
 *   board's own address, and at a reboot (RAM only).
 *
 * THE SEED (the server's last-known Amiga address, xfer.ip, plan 2026-10-17 R17) no longer decides anything: in
 * shared mode the Amiga's address on the network is the board's by definition, and Transfer goes to
 * PNET_SHARED_AMIGA (pnet_sort_send_ip). A seed from another network (bench 2026-11-16: 172.16.10.214 from home while
 * the board was on the hotspot) is ignored. What that gives up: a STATIC Amiga left idle across a board reboot is
 * not reachable for Transfer until it sends a frame (the escape needs one).
 *
 * KNOWN (review minor 4, unchanged): a board connection open to PNET_SHARED_AMIGA when shared mode ends (the escape)
 * is not reset; it times out (lwIP's retransmits, then amiga_send's own limits) and the next connect goes to the
 * Amiga's own address.
 *
 * WHILE ON:
 *   DHCP   every BOOTREQUEST from the Amiga is answered here, never sent to the radio: DISCOVER -> OFFER, REQUEST
 *          for the board's address -> ACK, REQUEST for any other -> NAK (the Amiga restarts at DISCOVER), others
 *          dropped. The lease: the board's address, mask, gateway and DNS, PNET_SHARED_LEASE_S, server id = the
 *          network's DHCP server (so a unicast renewal goes out and is still answered here). The network's own
 *          replies to an Amiga xid are dropped (sh.late): none should exist, the Amiga's DHCP never goes out.
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
 *          board's Transfer connection goes to PNET_SHARED_AMIGA (pnet_sort_send_ip), always in shared mode.
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
#define PNET_FORMER_MS      (20u * 60u * 1000u)   /* a former address's late frames are dropped this long: past
                                                     * AmiTCP_NG's TCP give-up and FIN_WAIT timers (minutes) */
#define PNET_READDRESS_TRIES 3u                   /* DOWN pulses per episode before the Amiga is left on its own */
#define PNET_DHCP_REPLY_MIN 342u          /* Ethernet 14 + IPv4 20 + UDP 8 + a 300-byte BOOTP message */
#define PNET_DHCP_REPLY_MAX 590u          /* ...+ 236 + 312 bytes of options (a long echoed client-id: review I1) */

/* What the board hands the Amiga: its own lease (glue: lwIP's netif, dns_getserver, the DHCP server id). */
typedef struct { uint32_t ip, mask, gw, dns[2], server; uint8_t mac[6]; } pnet_lease_t;

/* Default-on: enters shared mode when the board's address is non-zero (unless the Amiga is on an address of its own,
 * sh.own); when that address CHANGES under shared mode, follows it and, if the Amiga was known to hold the old one,
 * asks for a re-address (sh.down_req). 0 changes nothing. */
void pnet_shared_follow(pnet_sort_t *s, uint32_t board_ip);
pnet_sort_to_t pnet_shared_rx(pnet_sort_t *s, const uint8_t *f, size_t len);
/* A frame from the Amiga with the shared MAC as its source and a sane length (pnet_sort_tx checked both), and not
 * foreign (pnet_shared_foreign said NO). */
pnet_tx_t pnet_shared_tx(pnet_sort_t *s, const uint8_t *f, size_t len);
/* A frame from the Amiga whose ARP sender / IPv4 source is non-zero and not the shared address (the escape, above).
 * NO: not foreign (or shared mode is off). HOLD: held back (a re-address is pending or was just asked). OWN: shared
 * mode ended, the Amiga keeps that address in two-address mode (amiga_ip 0, for the frame to teach). */
typedef enum { PNET_FOREIGN_NO = 0, PNET_FOREIGN_HOLD, PNET_FOREIGN_OWN } pnet_foreign_t;
pnet_foreign_t pnet_shared_foreign(pnet_sort_t *s, const uint8_t *f, size_t len);

/* In shared mode: a BOOTREQUEST from the Amiga, which never goes to the radio. */
bool pnet_shared_is_dhcp(const pnet_sort_t *s, const uint8_t *f, size_t len);
/* The reply to that request, written to out: its length (PNET_DHCP_REPLY_MIN..MAX), or 0 for none -- also when cap
 * is short of that length, in which case nothing is written. */
size_t pnet_shared_dhcp_reply(pnet_sort_t *s, const uint8_t *req, size_t len, const pnet_lease_t *L,
                              uint8_t *out, size_t cap);

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

/* The address the board's Transfer connection goes to: PNET_SHARED_AMIGA in shared mode (the Amiga's address on the
 * network is the board's by definition), the learned amiga_ip in two-address mode. */
uint32_t pnet_sort_send_ip(const pnet_sort_t *s);
#endif
