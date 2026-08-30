#ifndef PORTAL_NET_H
#define PORTAL_NET_H
// The lwIP/cyw43 glue that turns dhcp_server.c's, dns_server.c's and
// portal_http.c's pure packet logic into an actual WPA2 access point: two
// raw UDP sockets (DHCP on 67, DNS on 53) and one raw TCP listener (port
// 80). Device-only -- see portal_net.c's header comment for the locking
// discipline and test/run.sh's exclusion comment for why it never joins
// the host build. This header itself stays free of pico-sdk/lwIP includes
// so anything that only needs the two entry points below (main.c, task 10)
// doesn't have to pull those in transitively.
#include <stdbool.h>
#include "config_store.h"

// Assumes cyw43_arch_init() has already run and this core owns the cyw43
// driver -- main.c does that once at boot, the same precondition
// transport_tls.c has for STA mode. This file only adds AP mode and the
// three sockets on top of it.
//
// Brings up the WPA2 AP (SSID "wifi-floppy-XXXX" built from the last two
// MAC octets, password PORTAL_AP_PASSWORD -- see CMakeLists.txt), starts
// the DHCP/DNS/HTTP servers, and blocks until a POST /save request decodes
// to a complete device_config_t (portal_http.h's PORTAL_ACT_SUBMIT). `err`,
// when non-NULL, is shown on the form -- e.g. the caller's own "Wrong
// password" from a previous verify-then-commit attempt (spec D-4b-3).
// Fills `out` and returns true once that happens. There is no path back to
// the caller on setup failure (see portal_net.c's header comment for why);
// the bool return exists purely to name the one thing this function
// actually does before returning, not to signal an alternative outcome.
bool portal_run(device_config_t *out, const char *err);

// Tears down the sockets and the AP so the caller can switch the radio to
// STA mode and attempt the submitted credentials. Only meaningful after
// portal_run() has returned; calling it first is a no-op (nothing is up
// yet to tear down).
void portal_stop(void);

#endif
