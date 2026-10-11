/*
 * PaulaNET protocol: Copyright (C) 2026 RobSmithDev, https://github.com/RobSmithDev/PaulaNET.
 * Used with the author's permission (2026-10-09).
 */
// PaulaNET Phase 1, core1 (pnet_bridge.h). Device-only: excluded from the host build by run.sh;
// every decision it acts on is pnet_sort.c / pnet_ring.c, which are tested.
//
// RECEIVE. The radio driver copies each received frame into a PBUF_POOL pbuf -- one pbuf for
// anything up to PBUF_POOL_BUFSIZE (1516 bytes here), a chain beyond -- and calls the station
// netif's input (the driver's lwIP glue, its process-ethernet callback). We sit there: an
// Amiga-only frame is copied into the PSRAM RX ring and its pbuf freed at once, so the pool the
// TLS receive window depends on (lwipopts.h) is never held by the Amiga; a board frame goes on to
// lwIP's own input, unchanged. This runs in the network context, the lwIP lock held.
//
// SEND. A 2 ms worker in the same context (net_radio_every_ms) hands up to PNET_TX_PER_TICK frames
// from the TX ring to the radio. Not core1's loop: that blocks for seconds inside the long poll.
#include "pnet_bridge.h"
#include "pnet_frame.h"        // PNET_MAX_FRAMES
#include "net_radio.h"
#include "wf_log.h"
#include "lwip/netif.h"
#include "lwip/pbuf.h"
#include "lwip/def.h"          // lwip_ntohl
#include "hardware/psram.h"    // psram_check_address
#include "pico/stdlib.h"

#define PNET_RX_SLOTS    64u
#define PNET_TX_SLOTS    32u
#define PNET_TX_TICK_MS  2u
#define PNET_TX_PER_TICK 8u
#define PNET_ETH_HDR     14u   // the shortest frame the Amiga's ring may carry
_Static_assert(PNET_TX_SLOTS >= PNET_MAX_FRAMES, "one whole batch always fits an empty TX ring");

static __uninitialized_psram("pnetrx") uint8_t s_rx_mem[PNET_RX_SLOTS * PNET_RING_SLOT];
static __uninitialized_psram("pnettx") uint8_t s_tx_mem[PNET_TX_SLOTS * PNET_RING_SLOT];
pnet_ring_t g_pnet_rx, g_pnet_tx;

static pnet_sort_t s_sort;           // the network context only
static netif_input_fn s_next;        // lwIP's own input, taken over by the hook
static volatile uint32_t s_in_amiga, s_in_both, s_big, s_chained, s_hooks, s_tx_sent, s_tx_err;
static volatile uint32_t s_tx_no[PNET_TX_N], s_board_ip;

void pnet_bridge_init(void) {
    pnet_ring_init(&g_pnet_rx, s_rx_mem, PNET_RX_SLOTS);
    pnet_ring_init(&g_pnet_tx, s_tx_mem, PNET_TX_SLOTS);
    if (!psram_check_address(&s_rx_mem[sizeof s_rx_mem - 1]) ||
        !psram_check_address(&s_tx_mem[sizeof s_tx_mem - 1]))
        wf_logf(WF_ERR, "pnet: the frame rings are not backed by PSRAM -- L2 sharing will fail");
}

static uint32_t board_ip_of(struct netif *nif) { return lwip_ntohl(ip4_addr_get_u32(netif_ip4_addr(nif))); }

static err_t pnet_input(struct pbuf *p, struct netif *nif) {
    if (p->len != p->tot_len) s_chained++;            // sorted on the first pbuf's bytes
    const pnet_sort_to_t to = pnet_sort_rx(&s_sort, (const uint8_t *)p->payload, p->len, board_ip_of(nif));
    if (to & PNET_SORT_AMIGA) {
        // pnet_ring_commit does not check the length: 14..PNET_RING_MTU is enforced here. (The
        // sorter never says AMIGA below 14 bytes; the lower bound states the contract, not a case.)
        if (p->tot_len > PNET_RING_MTU || p->tot_len < PNET_ETH_HDR) {
            s_big++;
        } else {
            uint8_t *d = pnet_ring_claim(&g_pnet_rx);   // NULL when full: counted in drops
            if (d) {
                pbuf_copy_partial(p, d, p->tot_len, 0);
                pnet_ring_commit(&g_pnet_rx, p->tot_len);
                if (to == PNET_SORT_BOTH) s_in_both++; else s_in_amiga++;
            }
        }
    }
    if (to & PNET_SORT_BOARD) return s_next(p, nif);  // lwIP's input owns p from here
    pbuf_free(p);
    return ERR_OK;
}

static void pnet_tx_tick(void) {
    struct netif *nif = net_radio_sta_netif();
    const uint32_t board_ip = board_ip_of(nif);
    s_board_ip = board_ip;
    for (unsigned k = 0; k < PNET_TX_PER_TICK; k++) {
        uint16_t len;
        const uint8_t *f = pnet_ring_peek(&g_pnet_tx, 0, &len);
        if (!f) break;
        const pnet_tx_t v = pnet_sort_tx(&s_sort, f, len, nif->hwaddr, board_ip);
        if (v != PNET_TX_SEND) s_tx_no[v]++;
        else if (net_radio_send_ethernet(f, len) == 0) s_tx_sent++;
        else s_tx_err++;
        pnet_ring_drop(&g_pnet_tx, 1);
    }
}

void pnet_bridge_check(void) {
    net_radio_lock();
    struct netif *nif = net_radio_sta_netif();
    if (nif->input != NULL && nif->input != pnet_input) {
        s_next = nif->input;
        nif->input = pnet_input;
        s_hooks++;
    }
    net_radio_unlock();
}

void pnet_bridge_start(void) {
    pnet_sort_init(&s_sort);                           // before the hook can run
    pnet_bridge_check();
    if (!net_radio_every_ms(PNET_TX_TICK_MS, pnet_tx_tick))
        wf_logf(WF_ERR, "pnet: no send worker -- the Amiga's frames will not go out");
    uint8_t m[6];
    net_radio_mac(m);
    wf_logf(WF_WARN, "pnet: L2 sharing on (TEST build), MAC %02x:%02x:%02x:%02x:%02x:%02x",
            m[0], m[1], m[2], m[3], m[4], m[5]);
}

void pnet_bridge_stats(pnet_bridge_stats_t *o) {
    o->in_amiga = s_in_amiga;
    o->in_both = s_in_both;
    o->rx_drops = g_pnet_rx.drops + s_big;
    o->chained = s_chained;
    o->hooks = s_hooks;
    o->tx_sent = s_tx_sent;
    o->tx_err = s_tx_err;
    for (unsigned i = 0; i < PNET_TX_N; i++) o->tx_no[i] = s_tx_no[i];
    o->clash = *(volatile uint32_t *)&s_sort.clash;    // written in the network context; a log reading
    o->amiga_ip = *(volatile uint32_t *)&s_sort.amiga_ip;
    o->board_ip = s_board_ip;
}
