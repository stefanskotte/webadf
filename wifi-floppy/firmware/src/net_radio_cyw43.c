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
    absolute_time_t start;
} join_ctx_t;

// The driver's join-state bits (cyw43_ctrl.c, cyw43-driver in pico-sdk 2.3.0,
// WIFI_JOIN_STATE_*): AUTH 0x0200, LINK 0x0400, KEYED 0x0800 are set by the
// association's own events; the low nibble is the kind (ACTIVE 1, FAIL 2,
// NONET 3, BADAUTH 4). Read directly: cyw43_wifi_link_status() folds them away.
#define JOIN_BITS_ASSOC 0x0E00u

// ---------------------------------------------------------------- join trace
//
// Bench 2026-11-15: 1.25.0 failed its first join after power-on, three rounds,
// and the log said only TIMEOUT / NO_ADDRESS. With WF_JOIN_TRACE (a CMake
// option, OFF by default -- a TEST-build aid, never in a release) every change
// of the station's state during a join is logged with its time into the
// attempt: the driver's raw join state, both link statuses, the netif's flags
// and address, and lwIP's DHCP client state; and each drop step.
#ifndef WF_JOIN_TRACE
#define WF_JOIN_TRACE 0
#endif
#if WF_JOIN_TRACE
#include "wf_log.h"
typedef struct { uint32_t js; int wls, tls; uint8_t flags, dhcp; uint32_t ip; } jsnap_t;
static jsnap_t g_jlast;
static bool    g_jlast_ok;

static jsnap_t jsnap(void) {
    jsnap_t s;
    struct netif *n = &cyw43_state.netif[CYW43_ITF_STA];
    cyw43_arch_lwip_begin();
    s.js = cyw43_state.wifi_join_state;
    s.wls = cyw43_wifi_link_status(&cyw43_state, CYW43_ITF_STA);
    s.tls = cyw43_tcpip_link_status(&cyw43_state, CYW43_ITF_STA);
    s.flags = n->flags;
    s.ip = ip4_addr_get_u32(netif_ip4_addr(n));
    const struct dhcp *d = netif_dhcp_data(n);
    s.dhcp = d ? d->state : 0xFF;
    cyw43_arch_lwip_end();
    return s;
}

static void jtrace(const join_ctx_t *c, const char *what) {
    jsnap_t s = jsnap();
    if (!what && g_jlast_ok && memcmp(&s, &g_jlast, sizeof s) == 0) return;   // only changes
    g_jlast = s;
    g_jlast_ok = true;
    unsigned long ms = c ? (unsigned long)(absolute_time_diff_us(c->start, get_absolute_time()) / 1000) : 0;
    wf_logf(WF_INFO, "jtrace +%lu %s js %04lx wls %d tls %d nf %02x ip %lu.%lu.%lu.%lu dhcp %u",
            ms, what ? what : "chg", (unsigned long)s.js, s.wls, s.tls, s.flags,
            (unsigned long)(s.ip & 0xFF), (unsigned long)((s.ip >> 8) & 0xFF),
            (unsigned long)((s.ip >> 16) & 0xFF), (unsigned long)(s.ip >> 24), s.dhcp);
}
#define JTRACE(c, what) jtrace((c), (what))
#else
#define JTRACE(c, what) ((void)0)
#endif

static net_link_t j_status(void *vc) {
    JTRACE((join_ctx_t *)vc, NULL);
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
    JTRACE(c, "join");
    return cyw43_arch_wifi_connect_async(c->ssid, c->pass, CYW43_AUTH_WPA2_AES_PSK);
}

// Is anything held that a new join must not inherit? Associated at the 802.11
// level (the driver's AUTH/LINK/KEYED join bits), the netif's link up, or an
// address on it. A join merely under way -- a scan for an absent network, or a
// first join after power-on -- holds nothing: leaving it is not needed (the
// SDK's own loop re-joins on no-network without leaving) and, the bench showed,
// is harmful (j_drop).
static bool j_held(void *vc) {
    (void)vc;
    struct netif *n = &cyw43_state.netif[CYW43_ITF_STA];
    cyw43_arch_lwip_begin();
    bool held = (cyw43_state.wifi_join_state & JOIN_BITS_ASSOC) != 0 || netif_is_link_up(n) ||
                !ip4_addr_isany_val(*netif_ip4_addr(n));
    cyw43_arch_lwip_end();
    return held;
}

// Drop what the station holds; called only when j_held() said so.
//
// Why only then (bench 2026-11-15, 1.25.0 TEST seq 134: "join wayfart failed
// (5)", (4), (5), portal; 1.24.2 joins in seconds). 1.25.0 dropped before
// EVERY attempt, including the first after power-on, when the station held
// nothing. The mechanism believed to have failed (to be confirmed by
// WF_JOIN_TRACE on the bench):
//   1. cyw43_wifi_leave() (cyw43_ctrl.c) issues SET_DISASSOC; the chip answers
//      with a CYW43_EV_DISASSOC event, processed on a LATER poll.
//   2. The join starts right after: cyw43_wifi_join() sets wifi_join_state =
//      WIFI_JOIN_STATE_ACTIVE (cyw43_ctrl.c, ~line 253).
//   3. The late DISASSOC is then processed: cyw43_ctrl.c ~353-355 sets
//      wifi_join_state = 0x0000 and marks the link down.
//   4. The association's own events then OR in AUTH|LINK|KEYED (0x0E00), but
//      the "joined" test is wifi_join_state == WIFI_JOIN_STATE_ALL (0x0E01,
//      cyw43_ctrl.c ~434): with the ACTIVE bit gone it is never true, so
//      cyw43_cb_tcpip_set_link_up() (cyw43_lwip.c) never runs, the netif
//      never gets its link, lwIP's DHCP never leaves INIT (dhcp.c
//      dhcp_network_changed_link_up is never called) -- and the status reads
//      DOWN (kind 0) until the timeout: TIMEOUT (5), as rounds 1 and 3 did.
//      A round that saw the link come up but no lease, NO_ADDRESS (4), fits
//      the same event landing later still (after the link went up), or DHCP
//      restarted under the link; the trace will say which.
// The M-2 wait added last round never ran there: it waited only while the
// status read JOIN, and a never-joined station reads DOWN.
//
// So: leave only a station that holds something, and then wait (bounded) for
// the leave's own DISASSOC to land -- it zeroes the join state -- before the
// next join can start. Then the netif side (I1, M-1): link down, address
// zeroed, DHCP restarted, so the next association gets a fresh DISCOVER and
// a stale "up" cannot be read. Residual: a DISASSOC later than DROP_WAIT_MS
// would still cost the next attempt; the trace shows it ("drop: no disassoc").
#define DROP_WAIT_MS 1000
static void j_drop(void *vc) {
    join_ctx_t *c = vc;
    (void)c;
    JTRACE(c, "drop: leave");
    cyw43_wifi_leave(&cyw43_state, CYW43_ITF_STA);
    int waited = 0;
    while (waited < DROP_WAIT_MS && cyw43_state.wifi_join_state != 0) {
        cyw43_arch_poll();
        sleep_ms(10);
        waited += 10;
    }
    JTRACE(c, cyw43_state.wifi_join_state == 0 ? "drop: disassoc seen" : "drop: no disassoc");
    cyw43_arch_lwip_begin();
    struct netif *n = &cyw43_state.netif[CYW43_ITF_STA];
    netif_set_link_down(n);
    dhcp_release_and_stop(n);
    netif_set_addr(n, IP4_ADDR_ANY4, IP4_ADDR_ANY4, IP4_ADDR_ANY4);
    dhcp_start(n);
    cyw43_arch_lwip_end();
    JTRACE(c, "drop: netif reset");
}

// A disassociation on its way with nothing held (review of 3bf330b2, I2): a wrong password's deauth (reason 2)
// sets pend_disassoc, which the driver's next poll turns into SET_DISASSOC, whose EV_DISASSOC zeroes the join state
// -- after the join that follows, if nothing waits for it. Also a BADAUTH join state: the same event may follow.
static void j_settle(void *vc) {
    join_ctx_t *c = vc;
    (void)c;
    if (!cyw43_state.pend_disassoc && (cyw43_state.wifi_join_state & 0x000Fu) != 4u /* WIFI_JOIN_STATE_BADAUTH */) return;
    JTRACE(c, "settle: wait");
    int waited = 0;
    while (waited < DROP_WAIT_MS && (cyw43_state.pend_disassoc || cyw43_state.wifi_join_state != 0)) {
        cyw43_arch_poll();
        sleep_ms(10);
        waited += 10;
    }
    JTRACE(c, cyw43_state.wifi_join_state == 0 ? "settle: disassoc seen" : "settle: none came");
}

bool net_radio_sta_leave(uint32_t wait_ms) {
    if (!j_held(NULL)) return false;
    cyw43_wifi_leave(&cyw43_state, CYW43_ITF_STA);
    uint32_t waited = 0;
    while (waited < wait_ms && cyw43_state.wifi_join_state != 0) {
        cyw43_arch_poll();
        sleep_ms(10);
        waited += 10;
    }
    return true;
}

// The scan's state: the callback runs in the driver's background context for as long as the scan runs -- which can
// be past the caller's deadline (review I1) -- so the names are copied here, never borrowed from the caller's
// stack, and a scan given up on has its `n` zeroed under the driver lock: later results match nothing.
static struct {
    char              names[NET_RADIO_SCAN_MAX][33];
    volatile int      n;
    volatile uint32_t seen;
    volatile int      results;   // every result, any name: 0 means the scan heard nothing at all
} s_scan;
static int scan_result(void *env, const cyw43_ev_scan_result_t *r) {
    (void)env;
    const int n = s_scan.n;
    if (n > 0) s_scan.results++;
    for (int i = 0; i < n; i++) {
        const size_t len = strlen(s_scan.names[i]);
        if (len != 0 && len == r->ssid_len && memcmp(r->ssid, s_scan.names[i], len) == 0) s_scan.seen |= 1u << i;
    }
    return 0;
}

// One escan: broadcast (ssid NULL) or directed at one name, active (0) or passive (1). Waits for its end or the
// deadline. -1: it could not start; 0: still running at the deadline; 1: done.
static int scan_once(const char *ssid, int8_t type, absolute_time_t until) {
    cyw43_wifi_scan_options_t opts;
    memset(&opts, 0, sizeof opts);
    if (ssid) {
        opts.ssid_len = (uint32_t)strlen(ssid);
        memcpy(opts.ssid, ssid, opts.ssid_len);
    }
    opts.scan_type = type;
    cyw43_arch_lwip_begin();
    const int err = cyw43_wifi_scan(&cyw43_state, &opts, NULL, scan_result);
    cyw43_arch_lwip_end();
    if (err) return -1;
    while (cyw43_wifi_scan_active(&cyw43_state) && !time_reached(until)) {
        cyw43_arch_poll();
        sleep_ms(10);
    }
    return cyw43_wifi_scan_active(&cyw43_state) ? 0 : 1;
}

// Bench 2026-11-16 (e92807d8, UniFi Block): one broadcast active scan beside the association ended in ~0.6 s and
// matched nothing, not even the network the board was on -- a blocked MAC gets no probe responses, and a 20-40 ms
// active dwell per channel can miss every beacon. So: a broadcast active scan, then (names still unseen) a passive
// one, which listens for beacons, then an active scan directed at each name still unseen (a hotspot or a hidden
// network may answer a probe for its own name only). All within timeout_ms.
int net_radio_scan_names(const char *const *names, int n, uint32_t timeout_ms, int *results) {
    if (results) *results = 0;
    if (n <= 0 || n > NET_RADIO_SCAN_MAX || cyw43_wifi_scan_active(&cyw43_state)) return -1;
    cyw43_arch_lwip_begin();   // no callback can be running while the names change
    for (int i = 0; i < n; i++) {
        strncpy(s_scan.names[i], names[i], sizeof s_scan.names[i] - 1);
        s_scan.names[i][sizeof s_scan.names[i] - 1] = '\0';
    }
    s_scan.n = n;
    s_scan.seen = 0;
    s_scan.results = 0;
    cyw43_arch_lwip_end();
    const uint32_t all = (1u << n) - 1u;
    const absolute_time_t until = make_timeout_time_ms(timeout_ms);
    const int first = scan_once(NULL, 0, until);
    bool more = first == 1;
    if (more && (s_scan.seen & all) != all) more = scan_once(NULL, 1, until) == 1;
    for (int i = 0; more && i < n; i++)
        if (!(s_scan.seen & (1u << i)) && s_scan.names[i][0]) more = scan_once(s_scan.names[i], 0, until) == 1;
    cyw43_arch_lwip_begin();
    s_scan.n = 0;              // a scan still running: its later results count for nothing
    const uint32_t seen = s_scan.seen;
    const int got = s_scan.results;
    cyw43_arch_lwip_end();
    if (first < 0) return -1;
    if (results) *results = got;
    return (int)seen;          // a scan still running at the deadline: what was seen so far
}

bool net_radio_scan_active(void) { return cyw43_wifi_scan_active(&cyw43_state); }

static bool j_time_up(void *vc) {
    return time_reached(((join_ctx_t *)vc)->until);
}

static void j_wait(void *vc) {
    cyw43_arch_poll();
    cyw43_arch_wait_for_work_until(((join_ctx_t *)vc)->until);
}

net_join_t net_radio_sta_connect(const char *ssid, const char *pass, uint32_t timeout_ms) {
    join_ctx_t c = { ssid, pass, make_timeout_time_ms(timeout_ms), get_absolute_time() };
    const net_join_ops_t ops = { &c, j_status, j_join, j_held, j_drop, j_time_up, j_wait, j_settle };
    JTRACE(&c, "start");
    net_join_t r = net_join_run(&ops);
#if WF_JOIN_TRACE
    jtrace(&c, r == NET_JOIN_OK ? "end ok" : "end fail");
    wf_logf(WF_INFO, "jtrace result %d", (int)r);
#endif
    return r;
}

// The AP beside an associated station (2026-11-15, the setup page opened on
// request): the chip has one radio, so the AP must sit on the station's
// channel. cyw43_ll_wifi_ap_init sets the AP's channel with WLC_SET_CHANNEL on
// the STATION's interface (cyw43_ll.c), so a different channel there would
// pull the station off its network. Read the station's channel first
// (WLC_GET_CHANNEL: channel_info_t, hw_channel first) and give the AP that.
// Not associated (the setup page at power-on): the driver's default, as before.
void net_radio_ap_start(const char *ssid, const char *pass) {
    if (net_radio_sta_up()) {
        uint8_t buf[12] = {0};
        if (cyw43_ioctl(&cyw43_state, CYW43_IOCTL_GET_CHANNEL, sizeof buf, buf, CYW43_ITF_STA) == 0) {
            const uint32_t ch = (uint32_t)buf[0] | (uint32_t)buf[1] << 8;
            if (ch >= 1 && ch <= 14) cyw43_wifi_ap_set_channel(&cyw43_state, ch);
        }
    }
    cyw43_arch_enable_ap_mode(ssid, pass, CYW43_AUTH_WPA2_AES_PSK);
}
void net_radio_ap_stop(void) { cyw43_arch_disable_ap_mode(); }

struct netif *net_radio_sta_netif(void) { return &cyw43_state.netif[CYW43_ITF_STA]; }
struct netif *net_radio_ap_netif(void)  { return &cyw43_state.netif[CYW43_ITF_AP]; }

bool net_radio_sta_up(void) {
    return cyw43_tcpip_link_status(&cyw43_state, CYW43_ITF_STA) == CYW43_LINK_UP;
}

// With the station's own netmask (review of 3bf330b2, M7): a home network of 192.168.0.0/16 contains the AP's /24
// as surely as 192.168.4.0/24 is it. The two overlap when either contains the other's base address.
bool net_radio_sta_in_ap_subnet(void) {
    cyw43_arch_lwip_begin();
    const struct netif *n = &cyw43_state.netif[CYW43_ITF_STA];
    const uint32_t ip = lwip_ntohl(ip4_addr_get_u32(netif_ip4_addr(n)));
    const uint32_t mask = lwip_ntohl(ip4_addr_get_u32(netif_ip4_netmask(n)));
    cyw43_arch_lwip_end();
    return net_subnets_overlap(ip, mask, CYW43_DEFAULT_IP_AP_ADDRESS, 0xFFFFFF00u);
}

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
