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
#include <stdint.h>
#include "config_store.h"

// How long portal_run() will sit with the AP up and nobody talking to it
// before giving up and handing control back (see portal_run_result_t and
// the `idle_timeout_ms` parameter). Five minutes, and the reasoning is a
// two-sided bound:
//
//   * Short enough to self-heal. The failure this exists for is a power
//     cut that takes out the router and the board together: the board
//     boots first, burns its three 15 s attempts in 45 s while the router
//     is still coming up, and lands here. Without a timeout that board
//     stays in AP mode until a human with a phone appears -- the spec
//     accepted that risk, but justified it with "a board with a disk
//     mounted stays mounted", which is not true at boot when nothing is
//     mounted. Five minutes means a router that comes back inside the
//     usual minute or two is picked up on the very next sweep.
//   * Long enough not to interrupt anyone. It is an INACTIVITY window,
//     not a wall clock: any DHCP, DNS or HTTP packet from a client
//     restarts it, and it is never even evaluated while an HTTP
//     connection is open (see portal_run()). A phone joined to the AP
//     with the form on screen is emitting DHCP renewals and captive-
//     portal re-probes the whole time, so five minutes of true silence
//     means nobody is there at all.
#define PORTAL_IDLE_TIMEOUT_MS (5u * 60u * 1000u)

typedef enum {
    // A POST /save decoded to a complete device_config_t; `out` is filled.
    PORTAL_RUN_SUBMITTED,
    // `idle_timeout_ms` elapsed with no client activity and no HTTP
    // connection open. `out` is untouched. The caller decides what to do
    // with that -- main.c retries the configuration still in flash.
    PORTAL_RUN_IDLE_TIMEOUT,
} portal_run_result_t;

// Assumes cyw43_arch_init() AND cyw43_arch_enable_sta_mode() have already
// run and this core owns the cyw43 driver -- main.c does both once at
// boot, unconditionally, before any provisioning decision. This file
// only adds AP mode and the three sockets on top of that. The STA-mode
// precondition specifically is load-bearing, not just a convenience: it
// is what guarantees cyw43_state.netif[CYW43_ITF_STA] is already a
// valid, registered netif by the time portal_stop() needs to hand
// default routing back to it (see portal_net.c's portal_stop() for the
// review-round-1 netif_default fix this depends on). Calling either
// function here before that precondition holds is not a supported call
// pattern.
//
// Brings up the WPA2 AP (SSID "wifi-floppy-XXXX" built from the last two
// MAC octets, password PORTAL_AP_PASSWORD -- see CMakeLists.txt), starts
// the DHCP/DNS/HTTP servers, and waits for a POST /save request that
// decodes to a complete device_config_t (portal_http.h's
// PORTAL_ACT_SUBMIT). `err`, when non-NULL, is shown on the form -- e.g.
// the caller's own "Wrong password" from a previous verify-then-commit
// attempt (spec D-4b-3).
//
// `idle_timeout_ms` bounds that wait:
//
//   * 0 means wait forever. That is the right value when the board has
//     nothing in flash worth going back to (provisioning_t::have_config
//     false, which includes the rejected-pairing-code case) -- there is
//     no alternative to a human, so interrupting the wait would only
//     bounce the AP under whoever is mid-form.
//   * Non-zero (PORTAL_IDLE_TIMEOUT_MS) returns PORTAL_RUN_IDLE_TIMEOUT
//     after that much *inactivity*. A submission in progress is never cut
//     off: the clock is restarted by every DHCP/DNS/HTTP packet, the
//     timeout is not evaluated at all while any HTTP connection slot is
//     in use, and a submit published while the foreground was deciding
//     still wins (portal_run() rechecks it before returning the timeout).
//
// There is no path back to the caller on setup failure (see portal_net.c's
// header comment for why).
portal_run_result_t portal_run(device_config_t *out, const char *err,
                               uint32_t idle_timeout_ms);

// Tears down the sockets and the AP, and restores the already-enabled
// STA interface as lwIP's default route (see portal_net.c: bringing the
// AP up made *it* the default route, and disabling it does not put that
// back on its own), so the caller can attempt the submitted credentials
// over STA. Meant to be called after portal_run() has returned, on BOTH
// of its outcomes -- an idle timeout leaves the AP up exactly as a
// submission does. portal_run() itself now also calls this first if a
// previous session's sockets were still up (see its own comment), so
// callers no longer need to track that ordering themselves.
void portal_stop(void);

#endif
