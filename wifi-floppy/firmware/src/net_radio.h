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
// What one join attempt came to (field report 2026-11-14: the setup page said
// only "Network not found", for a network the board may well have seen).
// Only what the driver's own link states can tell apart -- see
// net_radio_cyw43.c for which state maps to which value. In particular the
// driver cannot say WHY a network was not found (absent, out of range, 5 GHz
// only, or a WPA3-only network the chip filters out of its join scan), so
// neither does this.
typedef enum {
    NET_JOIN_OK = 0,      // associated and holding an IP address
    NET_JOIN_NOT_FOUND,   // the join scan never matched the SSID (and nothing better followed)
    NET_JOIN_BAD_AUTH,    // the network rejected the key exchange: the password, as far as the driver can tell
    NET_JOIN_FAILED,      // the join failed for another reason the driver does not name
    NET_JOIN_NO_ADDRESS,  // associated, but DHCP gave no address before the time ran out
    NET_JOIN_TIMEOUT,     // still joining when the time ran out, with no verdict
    NET_JOIN_ERROR,       // the driver would not start the join at all
} net_join_t;

// Associate with a WPA2-PSK network, waiting up to timeout_ms. Core1 only.
net_join_t net_radio_sta_connect(const char *ssid, const char *pass, uint32_t timeout_ms);
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
/** Before the firmware's own deliberate reboots (bench 2026-11-15): leave the network cleanly, so the router drops
 *  this MAC's association and keys now. Rebooting without a deauth and reconnecting seconds later left the router
 *  holding the old PTK: AUTH and LINK, never KEYED (join state 0201 -> 0601 -> 0001 every ~5 s) for ~6 minutes, after
 *  the TBYB buy reboot and after a revert. Waits, bounded by `wait_ms`, for the leave's own DISASSOC. A no-op when
 *  nothing is held. Core1 only, foreground; never on a crash path. Returns true if it left something. */
bool net_radio_sta_leave(uint32_t wait_ms);
/** The Wi-Fi fallback (wifi_fallback.h): which of `names` (n <= 31, NUL-terminated SSIDs) a scan sees -- bit i for
 *  names[i] -- waiting at most timeout_ms. Runs beside an associated station (the chip leaves its channel briefly).
 *  A network that hides its name, or a phone hotspot not advertising, is not seen. -1: the scan could not start.
 *  Core1 only, foreground. */
int  net_radio_scan_names(const char *const *names, int n, uint32_t timeout_ms);
/** The station interface, to restore it as lwIP's default route after the AP. */
struct netif *net_radio_sta_netif(void);
/** The AP interface (valid between net_radio_ap_start and net_radio_ap_stop): the portal binds its sockets to it. */
struct netif *net_radio_ap_netif(void);
/** The station is associated and holds an address (the board is online). */
bool net_radio_sta_up(void);
/** The station's address is inside the AP's own /24 (192.168.4.0/24): both up at once would route one into the
 *  other (wifi_ctl.h, WIFI_RES_SUBNET). */
bool net_radio_sta_in_ap_subnet(void);
/** Pure (host-tested in test_wifi_ctl.c): the networks a/amask and b/bmask overlap. a == 0 (no address): false. */
static inline bool net_subnets_overlap(uint32_t a, uint32_t amask, uint32_t b, uint32_t bmask) {
    if (a == 0) return false;
    const uint32_t m = amask & bmask;   // the shorter prefix decides
    return (a & m) == (b & m);
}
/** The station MAC. */
void net_radio_mac(uint8_t mac[6]);
/** RSSI of the current association, dBm. */
int32_t net_radio_rssi(void);
/** The lwIP lock. RECURSIVE (callers nest it). Never from an interrupt. */
void net_radio_lock(void);
void net_radio_unlock(void);
#if WF_PNET_L2
#include <stddef.h>
/** PaulaNET Phase 1: one Ethernet frame out of the station interface, as is (the Amiga's, with
 *  the board's own MAC as its source). 0 on success. From the network context (a worker added
 *  with net_radio_every_ms), or core1 under net_radio_lock(). */
int  net_radio_send_ethernet(const void *frame, size_t len);
/** Runs fn every `ms` in the network context on core1, with the lwIP lock held -- the context the
 *  driver's own receive and lwIP's timers run in. Core1 only; one such worker. False on failure. */
bool net_radio_every_ms(uint32_t ms, void (*fn)(void));
/** PaulaNET Phase 2: the station is associated. Any core: one word of the driver's join state, read
 *  with no lock and no bus traffic -- a stale answer is at most one status read old. */
bool net_radio_sta_joined(void);
#endif
#endif
