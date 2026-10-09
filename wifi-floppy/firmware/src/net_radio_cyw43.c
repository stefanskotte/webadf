// The CYW43439 (RM2 on the PIM726) behind net_radio.h. Each function is the
// call it replaces, unchanged: P1 must not change behaviour. Device-only.
#include "net_radio.h"
#include "pico/cyw43_arch.h"
#include "lwip/netif.h"
#include <string.h>

int  net_radio_init(void)       { return cyw43_arch_init(); }
void net_radio_sta_enable(void) { cyw43_arch_enable_sta_mode(); }

int net_radio_sta_connect(const char *ssid, const char *pass, uint32_t timeout_ms) {
    return cyw43_arch_wifi_connect_timeout_ms(ssid, pass, CYW43_AUTH_WPA2_AES_PSK, timeout_ms);
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
