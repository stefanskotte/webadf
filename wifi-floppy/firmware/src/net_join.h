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
//      mark the link down, forget the address and restart DHCP), and
//   2. accepts "up" only after this attempt has itself seen the join in
//      progress (JOIN or NOIP) -- a stale "up" can never be the answer, even
//      if a drop did not take effect, and
//   3. drops again on every result but success, so the next attempt -- on
//      another network, or the same one -- starts from nothing.
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
    void       (*drop)(void *ctx);       // see 1. above
    bool       (*time_up)(void *ctx);    // the attempt's deadline has passed
    void       (*wait)(void *ctx);       // service the driver, wait for work (bounded by the deadline)
} net_join_ops_t;

net_join_t net_join_run(const net_join_ops_t *ops);

#endif
