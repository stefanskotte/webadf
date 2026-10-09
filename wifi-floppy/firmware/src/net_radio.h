#ifndef NET_RADIO_H
#define NET_RADIO_H
// The WiFi chip behind one seam (spec 2026-10-04-unified-firmware-design.md
// §8). Everything above it -- lwIP, mbedTLS, transport_tls.c, the portal's
// servers, SNTP, OTA -- is shared. P1 has one implementation,
// net_radio_cyw43.c, which is the ONLY file that may name cyw43_/CYW43_
// (test/run.sh enforces it).
#include <stdbool.h>
#include <stdint.h>
struct netif;

/** Bring the radio up. Returns 0 on success, nonzero on failure. Core1 only. */
int  net_radio_init(void);
/** Station mode on (no association yet). */
void net_radio_sta_enable(void);
/** Associate with a WPA2-PSK network. Returns PICO_OK (0) or a PICO_ERROR_* code,
 *  exactly as the SDK's blocking WiFi connect call did (main.c's assoc_failure_message maps them). */
int  net_radio_sta_connect(const char *ssid, const char *pass, uint32_t timeout_ms);
/** Start / stop the WPA2-PSK access point the setup portal serves on. */
void net_radio_ap_start(const char *ssid, const char *pass);
void net_radio_ap_stop(void);
/** DIAGNOSTIC (portal re-join, HANDOFF 2026-10-09). The stations the AP
 *  counts as ASSOCIATED (the chip's association list, which includes a
 *  station still in, or failed at, the WPA2 4-way handshake), up to `max`
 *  MACs into `macs`. Returns the count, or a negative driver error. Core1,
 *  foreground only (it takes the driver lock itself). */
int  net_radio_ap_stas(uint8_t (*macs)[6], int max);
/** The stations the AP counts as AUTHORIZED (handshake complete), via the
 *  chip's "autho_sta_list" iovar. Best effort: the 43439 firmware may not
 *  support it -- then a negative error, every call. Same contract otherwise. */
int  net_radio_ap_authorized(uint8_t (*macs)[6], int max);
/** The station interface, to restore it as lwIP's default route after the AP. */
struct netif *net_radio_sta_netif(void);
/** The station MAC. */
void net_radio_mac(uint8_t mac[6]);
/** RSSI of the current association, dBm. */
int32_t net_radio_rssi(void);
/** The lwIP lock. RECURSIVE (callers nest it). Never from an interrupt. */
void net_radio_lock(void);
void net_radio_unlock(void);
#endif
