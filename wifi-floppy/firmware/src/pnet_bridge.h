#ifndef PNET_BRIDGE_H
#define PNET_BRIDGE_H
// PaulaNET Phase 1 (WF_PNET_L2 TEST builds): the radio side of layer-2 sharing, on core1.
// Plan docs/superpowers/plans/2026-10-11-paulanet-phase1-l2-sharing.md, rulings 3-9.
#include <stdint.h>
#include "pnet_ring.h"
#include "pnet_sort.h"

extern pnet_ring_t g_pnet_rx;   // core1's input hook produces; core0 consumes
extern pnet_ring_t g_pnet_tx;   // core0 produces; core1's send worker consumes

typedef struct {
    uint32_t in_amiga, in_both;   // frames queued for the Amiga: its only / shared with the board
    uint32_t rx_drops;            // ...refused: the RX ring full, or too long
    uint32_t chained;             // frames whose first pbuf was not the whole frame (sorted on it)
    uint32_t hooks;               // times the input hook was (re)installed
    uint32_t tx_sent, tx_err;     // the Amiga's frames handed to the radio / refused by it
    uint32_t tx_no[PNET_TX_N];    // ...not sent, by pnet_tx_t reason ([PNET_TX_SEND] unused)
    uint32_t clash;               // pnet_sort_t.clash
    uint32_t amiga_ip, board_ip;  // as last seen by core1 (host order; 0 = unknown)
} pnet_bridge_stats_t;

void pnet_bridge_init(void);      // core0, before core1 launches: the rings over PSRAM
void pnet_bridge_start(void);     // core1, after net_radio_sta_enable(): the hook and the send worker
void pnet_bridge_check(void);     // core1, every loop pass: re-install the hook if the netif was re-added
void pnet_bridge_stats(pnet_bridge_stats_t *out);
#endif
