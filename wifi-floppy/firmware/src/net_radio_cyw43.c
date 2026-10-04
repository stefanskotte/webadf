// The CYW43439 (RM2 on the PIM726) behind net_radio.h. Each function is the
// call it replaces, unchanged: P1 must not change behaviour. Device-only.
#include "net_radio.h"
#include "pico/cyw43_arch.h"
#include "lwip/netif.h"

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
