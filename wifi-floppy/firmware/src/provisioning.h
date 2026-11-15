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
#include "net_radio.h"   // net_join_t only: the header itself includes no SDK header

// Spec S3, D-4b-1. Three consecutive failed associations open the portal.
// An "attempt" is one net_radio_sta_connect() call with a 15 s timeout
// (main.c owns that call), so this is roughly 45 s of trying rather than
// three instantaneous retries.
//
// Several networks (field report 2026-11-14): the count is of ROUNDS. A
// round tries every saved network once -- the one last joined first, then
// the others in saved order -- and fails only if every attempt in it failed.
// So with one network nothing changed (three attempts, ~45 s); with four the
// portal opens after 3 x 4 attempts, ~3 minutes. Any success ends the run of
// failures, exactly as one success did before.
#define PROV_MAX_ASSOC_FAILURES 3

// Room for the longest message prov_round_message() / prov_join_message()
// write: four networks' lines plus every hint (host-tested).
#define PROV_MSG_MAX 800

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
    // Counts consecutive failed ROUNDS (see PROV_MAX_ASSOC_FAILURES).
    int             assoc_failures;
    int             round_pos;     // attempts already made in the current round
    // This round's outcome per cfg.net index; NET_JOIN_OK means "not tried
    // this round" (a success ends the round). What the portal says when a
    // round of failures opens it (prov_round_message).
    net_join_t      result[CONFIG_NETS_MAX];
    bool            have_config;
    device_config_t cfg;    // valid only when have_config is true; ~410 B, keep the struct static
} provisioning_t;

// Decide the starting state from what is stored. Touches no radio.
void prov_init(provisioning_t *p);

// The cfg.net index of the network to try next: position round_pos of the
// order "net[last], then the others in saved order". -1 without a config.
int prov_next_net(const provisioning_t *p);

// Report the outcome of the attempt on prov_next_net(p). Returns the new
// state. A success resets the failure count and the round, so a flaky
// router costs retries but never accumulates toward the portal across
// separate outages -- and makes that network the one tried first from now
// on: cfg.last changes, and is written to flash (config_store_update, which
// keeps the token) only when it changed. That write is refused while a disk
// is mounted; the change then holds in RAM until the next save.
//
// Named for net_join_t on purpose: it replaced prov_on_assoc_result(p, bool),
// and NET_JOIN_OK is 0 -- a leftover `true` would have read as a failure.
prov_state_t prov_on_join_result(provisioning_t *p, net_join_t r);

// The portal collected a network (and maybe a pairing code) AND associating
// with it succeeded -- spec D-4b-3's verify-then-commit, with this called
// only after the verify. The network is added (or, if that SSID is already
// saved, its password replaced in place) and becomes the last joined.
//   * A pairing code in the form: a new pairing -- config_store_save(), which
//     erases the token, exactly as every submit did before.
//   * No code, and one is stored: the board stays paired --
//     config_store_update(), token kept.
// Returns true once committed; false (nothing changed, in RAM or flash) if
// the commit failed, the list is full and the SSID is new, or there is no
// code at all. The portal page refuses the last two before anything is
// joined; this is the backstop.
bool prov_on_verified_submit(provisioning_t *p, const setup_form_t *f);

// The portal's Remove button. Removes `ssid` and writes the list (token
// kept). Refuses to remove the only saved network -- a board with a code and
// no network has nothing to join, and adding first then removing is the way
// to replace it. Returns true when done; false with the reason in msg
// (plain text, PROV_MSG_MAX is plenty) otherwise.
bool prov_forget_network(provisioning_t *p, const char *ssid, char *msg, int cap);

// The setup page's words for a failed join of `ssid` (plain text, '\n'
// between lines, never markup -- portal_http.c escapes it). Names the network
// and the reason, and how to fix it. Returns the length, or -1 if it would
// not fit `cap` (then buf holds "").
int prov_join_message(char *buf, int cap, const char *ssid, net_join_t r);

// The same for the round of failures that just opened the portal: every
// saved network with its own reason, then each kind of hint once. One
// network reads exactly as prov_join_message.
int prov_round_message(const provisioning_t *p, char *buf, int cap);

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
