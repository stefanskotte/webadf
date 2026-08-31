#ifndef PROVISIONING_H
#define PROVISIONING_H
// Decides whether this board should be serving a disk or offering its
// configuration portal, and nothing else. Plan 4b's spec S5 is the state
// machine this file is; everything about radios, sockets and HTML lives
// elsewhere (portal_net.c, portal_http.c).
//
// This file must not include a pico-sdk or lwIP header. That is what keeps
// it runnable under the host test suite, and it degrades silently -- one
// include and the tests stop covering the decision logic with nothing
// announcing the loss. If it looks like it needs one, the seam is in the
// wrong place: pass the fact in as a parameter instead.
#include <stdbool.h>
#include "config_store.h"

// Spec S3, D-4b-1. Three consecutive failed associations open the portal.
// An "attempt" is one cyw43_arch_wifi_connect_timeout_ms() call with a
// 15 s timeout (main.c owns that call), so this is roughly 45 s of trying
// rather than three instantaneous retries.
#define PROV_MAX_ASSOC_FAILURES 3

typedef enum {
    PROV_PORTAL,     // offer the AP and the config page
    PROV_RUNNING,    // credentials in hand; run plan 4a's protocol loop
} prov_state_t;

typedef struct {
    prov_state_t    state;
    // RAM ONLY, and deliberately so. Persisting this across a power cycle
    // would let failures accumulate over a board's whole lifetime and
    // eventually park a perfectly healthy device in AP mode for good --
    // the same trap plan 4a's spec S4.1 records for the poll cursor.
    // A power cycle restores patience.
    int             assoc_failures;
    bool            have_config;
    device_config_t cfg;    // valid only when have_config is true
} provisioning_t;

// Decide the starting state from what is stored. Touches no radio.
void prov_init(provisioning_t *p);

// Report the outcome of one association attempt. Returns the new state.
// A success resets the failure count, so a flaky router costs retries but
// never accumulates toward the portal across separate outages.
prov_state_t prov_on_assoc_result(provisioning_t *p, bool ok);

// The portal collected credentials AND associating with them succeeded --
// spec D-4b-3's verify-then-commit, with this called only after the verify.
// Commits them and returns true; false if the commit itself failed.
bool prov_on_verified_submit(provisioning_t *p, const device_config_t *cfg);

// Registration came back 400 invalid_or_used_code. Spec D-4b-4: terminal,
// not retryable. A pairing code is single-use with a 10-minute TTL, and 4b
// stores it in flash rather than redeeming it seconds after boot, so a
// board provisioned and then left powered off can wake up holding a dead
// code. Clearing the config and returning to the portal is the only way
// for a human to supply a fresh one.
prov_state_t prov_on_pairing_code_rejected(provisioning_t *p);

// The portal was offered and nobody submitted anything within the caller's
// inactivity window (portal_net.h's PORTAL_IDLE_TIMEOUT_MS).
//
// Final-review Important 2: without this, PROV_PORTAL was a one-way door.
// The case it exists for is a power cut that drops the router and the board
// together: the board boots first, spends its three 15 s attempts
// (PROV_MAX_ASSOC_FAILURES) inside the 45 s the router is still starting
// up, and lands in the portal -- where, with an unbounded wait, it stayed
// until a human arrived with a phone. Spec S2's "a board with a disk
// mounted stays mounted" does not bound that damage, because nothing is
// mounted at boot.
//
// Returns true if there is a stored configuration to re-try -- state goes
// back to PROV_RUNNING with the failure count reset, so the caller gets a
// fresh PROV_MAX_ASSOC_FAILURES attempts and, if those fail too, the portal
// again. Returns false, leaving the state at PROV_PORTAL, when have_config
// is false: nothing is stored (a factory-fresh board) or what was stored
// has just been erased as unusable (prov_on_pairing_code_rejected), so
// there is nothing to re-try and only a human can move this board forward.
// Callers must pass 0 as portal_run()'s idle_timeout_ms in that case rather
// than bouncing the AP under whoever is filling in the form.
bool prov_on_portal_idle_timeout(provisioning_t *p);

#endif
