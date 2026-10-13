#ifndef PNET_LWIP_HOOKS_H
#define PNET_LWIP_HOOKS_H
// lwIP's hook file (LWIP_HOOK_FILENAME, lwipopts.h), WF_PNET_L2 builds (every release since 1.11.0,
// every DF1 mode: plan 2026-10-12 ruling 4). Every lwIP source includes it; only dhcp.c uses the hook.
//
// The board and the Amiga share one MAC (PaulaNET Phase 1), so both stacks put it in chaddr. The
// Amiga's AmiTCP_NG sends client-id 01:<MAC>; lwIP sends none, and a router that matches a lease
// by client-id falling back to chaddr would then hand both the same address. So the board sends a
// client-id of its own, in every DHCP message lwIP builds (dhcp.c calls this hook for DISCOVER,
// REQUEST, REBIND, DECLINE, INFORM and RELEASE). The trailer needs one byte: hence the - 1.
#include "pnet_sort.h"
#define LWIP_HOOK_DHCP_APPEND_OPTIONS(netif, dhcp, state, msg, msg_type, options_len_ptr)      \
    do {                                                                                      \
        *(options_len_ptr) = (u16_t)pnet_dhcp_client_id((msg)->options, *(options_len_ptr),   \
                                                        DHCP_OPTIONS_LEN - 1u, (netif)->hwaddr); \
    } while (0)
#endif
