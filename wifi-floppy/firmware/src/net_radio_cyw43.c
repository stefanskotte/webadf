// The CYW43439 (RM2 on the PIM726) behind net_radio.h. Each function is the
// call it replaced in P1, unchanged -- except net_radio_sta_connect, which
// since 2026-11-15 runs net_join.c's loop over the driver. Device-only.
#include "net_radio.h"
#include "pico/cyw43_arch.h"
#include "pico/time.h"
#include "lwip/netif.h"
#include "lwip/dhcp.h"
#include "net_join.h"
#include <string.h>

int  net_radio_init(void)       { return cyw43_arch_init(); }
void net_radio_sta_enable(void) { cyw43_arch_enable_sta_mode(); }

// The join itself (field report 2026-11-14; review I1, 2026-11-15). The
// decisions are net_join.c's, host-tested against a fake of these states; this
// file only maps the driver's link status onto them and supplies the steps:
//
//   CYW43_LINK_UP       -> NET_LINK_UP      (accepted only after this attempt saw JOIN/NOIP)
//   CYW43_LINK_BADAUTH  -> NET_LINK_BADAUTH (an auth or PSK-supplicant failure event)
//   CYW43_LINK_FAIL     -> NET_LINK_FAIL    (SET_SSID failed, but not with "no networks")
//   CYW43_LINK_NONET    -> NET_LINK_NONET   (SET_SSID "no networks": no BSS matched)
//   CYW43_LINK_NOIP / JOIN / DOWN -> the same
//
// Whether a WPA3-only network shows as NONET or FAIL against a WPA2 join is the
// chip firmware's choice and has not been measured on this board, so the setup
// page names WPA3-only under both. A wrong WPA2 password often ends as a
// timeout, not BADAUTH: the driver treats PSK-supplicant status 4/8/10 reason
// 15 (no key message) as edge-of-cell and rejoins (cyw43_ctrl.c).
typedef struct {
    const char     *ssid, *pass;
    absolute_time_t until;
} join_ctx_t;

static net_link_t j_status(void *vc) {
    (void)vc;
    switch (cyw43_tcpip_link_status(&cyw43_state, CYW43_ITF_STA)) {
    case CYW43_LINK_UP:      return NET_LINK_UP;
    case CYW43_LINK_NOIP:    return NET_LINK_NOIP;
    case CYW43_LINK_JOIN:    return NET_LINK_JOIN;
    case CYW43_LINK_FAIL:    return NET_LINK_FAIL;
    case CYW43_LINK_NONET:   return NET_LINK_NONET;
    case CYW43_LINK_BADAUTH: return NET_LINK_BADAUTH;
    default:                 return NET_LINK_DOWN;
    }
}

static int j_join(void *vc) {
    join_ctx_t *c = vc;
    return cyw43_arch_wifi_connect_async(c->ssid, c->pass, CYW43_AUTH_WPA2_AES_PSK);
}

// Drop whatever the station holds. The driver's link status reads UP from the
// netif's flags and address alone (cyw43_tcpip_link_status), and neither a
// disassociation nor a new join clears them: the netif only goes link-down on
// the chip's link-down event, and lwIP keeps the address across a link change
// (DHCP "reboots" to it). So, besides the disassociation, mark the link down
// here and give the address back -- dhcp_release_and_stop() zeroes it -- and
// restart DHCP, so the next association starts a fresh DISCOVER rather than
// asking the next network for the last one's address. Both idempotent: the
// chip's own link-down event, if it comes, does the first again.
//
// Review M-2: the leave's own CYW43_EV_DISASSOC arrives later and sets the
// join state to 0 (cyw43_ctrl.c) -- if it landed after the next join had set
// it ACTIVE, that join would read DOWN and time out for nothing. So while the
// join state still reads JOIN (ACTIVE: associated, or a join under way), wait
// for that event, bounded at DROP_WAIT_MS, servicing the driver meanwhile. A
// failed attempt (FAIL/NONET/BADAUTH) or a never-joined station is not ACTIVE
// and waits not at all. Residual risk: an event later than the bound (not
// expected; it follows the ioctl within a poll or two) still costs that one
// attempt a spurious timeout, which the round simply counts as a failure.
//
// Review M-1: dhcp_release_and_stop() zeroes the address only when DHCP was
// BOUND/RENEWING/REBINDING; in REBOOTING (after a link change) the old one
// stayed, and the next link-up read UP before any lease. So zero it here too.
#define DROP_WAIT_MS 500
static void j_drop(void *vc) {
    (void)vc;
    cyw43_wifi_leave(&cyw43_state, CYW43_ITF_STA);
    for (int waited = 0; waited < DROP_WAIT_MS &&
         cyw43_wifi_link_status(&cyw43_state, CYW43_ITF_STA) == CYW43_LINK_JOIN; waited += 10) {
        cyw43_arch_poll();
        sleep_ms(10);
    }
    cyw43_arch_lwip_begin();
    struct netif *n = &cyw43_state.netif[CYW43_ITF_STA];
    netif_set_link_down(n);
    dhcp_release_and_stop(n);
    netif_set_addr(n, IP4_ADDR_ANY4, IP4_ADDR_ANY4, IP4_ADDR_ANY4);
    dhcp_start(n);
    cyw43_arch_lwip_end();
}

static bool j_time_up(void *vc) {
    return time_reached(((join_ctx_t *)vc)->until);
}

static void j_wait(void *vc) {
    cyw43_arch_poll();
    cyw43_arch_wait_for_work_until(((join_ctx_t *)vc)->until);
}

net_join_t net_radio_sta_connect(const char *ssid, const char *pass, uint32_t timeout_ms) {
    join_ctx_t c = { ssid, pass, make_timeout_time_ms(timeout_ms) };
    const net_join_ops_t ops = { &c, j_status, j_join, j_drop, j_time_up, j_wait };
    return net_join_run(&ops);
}

void net_radio_ap_start(const char *ssid, const char *pass) {
    cyw43_arch_enable_ap_mode(ssid, pass, CYW43_AUTH_WPA2_AES_PSK);
}
void net_radio_ap_stop(void) { cyw43_arch_disable_ap_mode(); }

struct netif *net_radio_sta_netif(void) { return &cyw43_state.netif[CYW43_ITF_STA]; }

void net_radio_mac(uint8_t mac[6]) { cyw43_wifi_get_mac(&cyw43_state, CYW43_ITF_STA, mac); }

int32_t net_radio_rssi(void) {
    int32_t rssi = 0;
    cyw43_wifi_get_rssi(&cyw43_state, &rssi);
    return rssi;
}

void net_radio_lock(void)   { cyw43_arch_lwip_begin(); }
void net_radio_unlock(void) { cyw43_arch_lwip_end(); }

// DIAGNOSTIC (portal re-join, HANDOFF 2026-10-09): read-only queries.
int net_radio_ap_stas(uint8_t (*macs)[6], int max) {
    // The low-level call, under the driver lock (cyw43_arch_lwip_begin is
    // the same recursive lock cyw43_wifi_ap_get_stas would take): the
    // wrapper returns void and, on a failed ioctl, leaves the count as the
    // capacity passed in -- indistinguishable from a full AP.
    static uint8_t buf[8 * 6];
    if (max > 8) max = 8;
    int n = max;
    cyw43_arch_lwip_begin();
    int err = cyw43_ll_wifi_ap_get_stas(&cyw43_state.cyw43_ll, &n, buf);
    cyw43_arch_lwip_end();
    if (err) return err < 0 ? err : -err;
    if (n < 0) n = 0;
    if (n > max) n = max;
    memcpy(macs, buf, (size_t)n * 6);
    return n;
}

int net_radio_ap_authorized(uint8_t (*macs)[6], int max) {
    // WLC_GET_VAR "autho_sta_list" on the AP interface: the reply is a
    // maclist_t { uint32 count; ether_addr ea[] } written over the request.
    static uint8_t buf[4 + 8 * 6];
    if (max > 8) max = 8;
    memset(buf, 0, sizeof buf);
    memcpy(buf, "autho_sta_list", 15);
    int err = cyw43_ioctl(&cyw43_state, CYW43_IOCTL_GET_VAR, sizeof buf, buf, CYW43_ITF_AP);
    if (err) return err < 0 ? err : -err;
    uint32_t n = (uint32_t)buf[0] | (uint32_t)buf[1] << 8 | (uint32_t)buf[2] << 16 |
                 (uint32_t)buf[3] << 24;
    if (n > 8) return -1000 - (int)(n > 9999 ? 9999 : n);   // not a maclist: say so
    if ((int)n > max) n = (uint32_t)max;
    memcpy(macs, buf + 4, n * 6);
    return (int)n;
}

#if WF_PNET_L2
// PaulaNET Phase 1 (plan 2026-10-11). The send copies the frame into the driver's own SPI buffer
// (cyw43_ll_send_ethernet's memmove), so a PSRAM source is fine. The worker re-adds itself, the
// pattern async_context documents for a periodic at-time worker.
#include "pico/async_context.h"
int net_radio_send_ethernet(const void *frame, size_t len) {
    return cyw43_send_ethernet(&cyw43_state, CYW43_ITF_STA, len, frame, false);
}
static void (*s_every_fn)(void);
static uint32_t s_every_ms;
static void every_work(async_context_t *ctx, async_at_time_worker_t *w) {
    s_every_fn();
    async_context_add_at_time_worker_in_ms(ctx, w, s_every_ms);
}
static async_at_time_worker_t s_every = { .do_work = every_work };
bool net_radio_every_ms(uint32_t ms, void (*fn)(void)) {
    s_every_fn = fn;
    s_every_ms = ms;
    return async_context_add_at_time_worker_in_ms(cyw43_arch_async_context(), &s_every, ms);
}

// The join state is a field the driver updates from core1; core0 reads it for cylinder 76's status
// track. CYW43_LINK_JOIN is the station associated (the SDK's name for it).
bool net_radio_sta_joined(void) {
    return cyw43_wifi_link_status(&cyw43_state, CYW43_ITF_STA) == CYW43_LINK_JOIN;
}
#endif
