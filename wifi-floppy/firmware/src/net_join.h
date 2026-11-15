#ifndef NET_JOIN_H
#define NET_JOIN_H
// One join attempt's decisions, apart from the radio (review of
// feat/wifi-networks, I1). net_radio_cyw43.c supplies the operations below;
// test/test_net_join.c supplies a fake that models the driver's link states,
// including the case this file exists for:
//
// The driver's link status reads "up" whenever the station netif has its UP
// and LINK_UP flags and a non-zero address -- and starting a new join clears
// neither. So an attempt on network A that timed out after it had already
// associated (its DHCP lease landing after the 15 s), followed by an attempt
// on B, read "up" on B's very first status check: B was recorded as joined,
// although the board was still on A. In the portal a wrong password could
// "verify" the same way.
//
// So, every attempt:
//   1. starts by dropping whatever the station holds (`drop`: disassociate,
//      mark the link down, forget the address and restart DHCP) -- but ONLY
//      if it holds something (`held`). Bench 2026-11-15 (1.25.0 TEST, seq
//      134): dropping a station that held nothing broke the very first join
//      after power-on, three rounds running; see net_radio_cyw43.c's j_held.
//      With nothing held, an attempt is exactly the SDK's join (pico-sdk
//      cyw43_arch_wifi_connect_async + polling), as 1.24.2 did it, and
//   2. accepts "up" only after this attempt has itself seen the join in
//      progress (JOIN or NOIP) -- a stale "up" can never be the answer, even
//      if a drop did not take effect, and
//   3. drops again on every result but success (if anything is held), so
//      the next attempt -- on another network, or the same one -- starts
//      from nothing.
//
// Pure C, no SDK include (test/run.sh's radio rule: only net_radio_cyw43.c
// names the chip).
#include <stdbool.h>
#include "net_radio.h"   // net_join_t

// The link states, as the driver reports them (net_radio_cyw43.c maps its own).
typedef enum {
    NET_LINK_DOWN,
    NET_LINK_JOIN,     // joining, or associated at the 802.11 level
    NET_LINK_NOIP,     // associated, no address yet
    NET_LINK_UP,       // associated with an address
    NET_LINK_FAIL,
    NET_LINK_NONET,    // the join scan matched no network
    NET_LINK_BADAUTH,
} net_link_t;

typedef struct {
    void       *ctx;
    net_link_t (*status)(void *ctx);
    int        (*join)(void *ctx);       // start the join; 0 = started
    bool       (*held)(void *ctx);       // associated (at 802.11 or link level) or an address: see 1. above
    void       (*drop)(void *ctx);       // see 1. above; called only when held()
    bool       (*time_up)(void *ctx);    // the attempt's deadline has passed
    void       (*wait)(void *ctx);       // service the driver, wait for work (bounded by the deadline)
    // After a failed attempt that holds nothing: if the driver still has a disassociation on its way (a wrong
    // password: the AP's deauth makes the driver send SET_DISASSOC on its next poll), wait -- bounded -- for its
    // EV_DISASSOC to land. Landing during the NEXT attempt it would zero that join's state: the bench's 1.25.0
    // failure, reached this time by the online page's "check, then go back" (review of 3bf330b2, I2). NULL: none.
    void       (*settle)(void *ctx);
} net_join_ops_t;

net_join_t net_join_run(const net_join_ops_t *ops);

#endif
