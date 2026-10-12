/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
#ifndef NETLOOP_ETH_H
#define NETLOOP_ETH_H
/*
 * NetLoop's hand-made Ethernet (PaulaNET Phase 1): an ARP request, a DHCP DISCOVER and REQUEST,
 * and the parsers for their replies. Byte access only (the 68000 faults on an odd word access).
 * Addresses are host-order uint32_t, as the board's pnet_sort.h has them. Host-tested by
 * test_netloop_eth.c, against the board's own sorter.
 */
#include <stdint.h>
#include <stddef.h>

#define NL_ETH_MIN          60u
#define NL_BOOTP_BYTES      300u
#define NL_DHCP_FRAME_BYTES (14u + 20u + 8u + NL_BOOTP_BYTES)

typedef struct { uint8_t type; uint32_t yiaddr, server, router, dns, mask, lease; } nl_dhcp_t;

int    nl_parse_mac(const char *s, uint8_t mac[6]);      /* "aa:bb:cc:dd:ee:ff" (or '-'): 1 = ok */
/* 1 when s (with its NUL) fits in cap bytes: arguments are rejected, never cut. */
int    nl_arg_fits(const char *s, size_t cap);
int    nl_parse_ip(const char *s, uint32_t *ip);         /* "a.b.c.d": 1 = ok */
void   nl_ip_text(uint32_t ip, char out[16]);
/* Broadcast "who has tpa, tell spa" from mac: NL_ETH_MIN bytes. */
size_t nl_arp_request(uint8_t *f, const uint8_t mac[6], uint32_t spa, uint32_t tpa);
/* 1 when f is an ARP reply from `asked`; its MAC into mac_out. */
int    nl_arp_reply_from(const uint8_t *f, size_t len, uint32_t asked, uint8_t mac_out[6]);
/* BOOTREQUESTs from 0.0.0.0:68 to 255.255.255.255:67 with client-id 01:<mac> (as AmiTCP_NG sends
 * it): NL_DHCP_FRAME_BYTES, or 0 when cap is smaller. */
size_t nl_dhcp_discover(uint8_t *f, size_t cap, const uint8_t mac[6], uint32_t xid);
size_t nl_dhcp_request(uint8_t *f, size_t cap, const uint8_t mac[6], uint32_t xid, uint32_t yiaddr, uint32_t server);
/* 1 when f is a BOOTREPLY (UDP 67 -> 68) to xid with a DHCP message type; fills out. */
int    nl_dhcp_parse(const uint8_t *f, size_t len, uint32_t xid, nl_dhcp_t *out);
/* The "last pico counter" an L2 mode starts from after resync, given the counter the board is
 * serving: one less, so the first write acknowledges nothing and a batch the board has out is
 * read before it is freed (the board frees a batch only when a write echoes its counter). */
uint8_t nl_l2_start_ack(uint8_t served);
/* The L2 drain after resync: exchanges with no frames and no matcher until the board has nothing
 * new for us, so the batch resync left out is read unmatched and the next write acknowledges it.
 * `r` is l2_exchange's result (1 = acknowledged, 2 = not), `frames` the frames that exchange read,
 * `done` the exchanges so far (including this one), `max` the bound. 1 = stop draining. */
int nl_drain_done(int r, unsigned frames, unsigned done, unsigned max);
/* 1 when an ARP run passes: every round answered. (How many replies were found on the send exchange
 * or after a re-send is printed, never gated: a fast genuine reply is legitimate.) */
int nl_arp_pass(unsigned long ok, unsigned long rounds);
/* The above on this CPU: NULL = pass, else the step that failed. NetLoop SELFTEST runs it. */
const char *nl_eth_selftest(void);
/* Phase 2: the board's status record (cylinder 76, its 156 decoded bytes). NULL when it is what
 * PaulaNET's driver needs -- lengths 142 and 14, flags 3, a batch budget of 8,192, the board's `mac`,
 * link up -- else what is wrong. */
const char *nl_status_problem(const uint8_t *st, size_t n, const uint8_t mac[6]);
/* A big-endian 16-bit word at p (the record's fields). */
uint16_t nl_get16(const uint8_t *p);
#endif
