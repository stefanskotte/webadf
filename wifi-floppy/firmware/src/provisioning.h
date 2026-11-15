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
// round tries every saved network once -- the one joined last THIS SESSION
// first (at power-on: the first saved), then the others in saved order --
// and fails only if every attempt in it failed.
// So with one network nothing changed (three attempts, ~45 s); with four the
// portal opens after 3 x 4 attempts, ~3 minutes. Any success ends the run of
// failures, exactly as one success did before.
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
    // Counts consecutive failed ROUNDS (see PROV_MAX_ASSOC_FAILURES).
    int             assoc_failures;
    int             round_pos;     // attempts already made in the current round
    // This round's outcome per cfg.net index; NET_JOIN_OK means "not tried
    // this round" (a success ends the round). What the portal says when a
    // round of failures opens it (portal_http.c renders it).
    net_join_t      result[CONFIG_NETS_MAX];
    // The cfg.net index a round starts with: the network joined last in THIS
    // session. RAM only (review I2, operator 2026-11-15): remembering it in
    // flash meant erasing the config sector unattended, seconds after
    // power-on, on a board whose Amiga is switched off often -- and a cut
    // during that erase loses every network and the code. At power-on it is
    // 0: the saved order.
    int             first;
    bool            joined;   // `first` was joined this session (not merely the power-on default)
    bool            have_config;
    device_config_t cfg;    // valid only when have_config is true; ~410 B
} provisioning_t;

// Why a Remove did not happen (prov_forget_network); the setup page words it.
typedef enum {
    PROV_FORGOT = 0,
    PROV_FORGET_NOT_SAVED,      // no such network
    PROV_FORGET_ONLY_ONE,       // the only saved network stays
    PROV_FORGET_DISK_MOUNTED,   // config_store's guard: no flash write while a disk is in the drive
    PROV_FORGET_WRITE_FAILED,   // the flash write itself failed
} prov_forget_t;

// Decide the starting state from what is stored. Touches no radio.
void prov_init(provisioning_t *p);

// The cfg.net index of the network to try next: position round_pos of the
// order "net[first], then the others in saved order". -1 without a config.
int prov_next_net(const provisioning_t *p);
// Position k of that order (the setup page lists a failed round in it).
int prov_order_at(const provisioning_t *p, int k);

// The board is paired, so the setup page may take a network with no code:
// a code is stored, or a token is (the token outlives a lost config record,
// see config_store.c's erase-window comment).
bool prov_paired(const provisioning_t *p);

// Report the outcome of the attempt on prov_next_net(p). Returns the new
// state. A success resets the failure count and the round, so a flaky
// router costs retries but never accumulates toward the portal across
// separate outages -- and makes that network the one tried first for the
// rest of the session (`first`, RAM only: this never writes flash).
//
// Named for net_join_t on purpose: it replaced prov_on_assoc_result(p, bool),
// and NET_JOIN_OK is 0 -- a leftover `true` would have read as a failure.
prov_state_t prov_on_join_result(provisioning_t *p, net_join_t r);

// The portal collected a network (and maybe a pairing code) AND associating
// with it succeeded -- spec D-4b-3's verify-then-commit, with this called
// only after the verify. The network is added (or, if that SSID is already
// saved, its password replaced in place) and becomes the last joined -- in
// RAM, and as page 0 of the record (cfg.last: what an older firmware would
// read after a rollback).
//   * A pairing code in the form: a new pairing -- config_store_save(), which
//     erases the token, exactly as every submit did before.
//   * No code, and the board is paired (prov_paired): it stays paired --
//     config_store_update(), token kept.
// Returns true once committed; false (nothing changed, in RAM or flash) if
// the commit failed, the list is full and the SSID is new, or there is no
// code at all. The portal page refuses the last two before anything is
// joined; this is the backstop.
bool prov_on_verified_submit(provisioning_t *p, const setup_form_t *f);

// The portal's Remove button. Removes `ssid` and writes the list (token
// kept), with the network joined last this session as page 0. Refuses to
// remove the only saved network -- a board with a code and no network has
// nothing to join, and adding first then removing is the way to replace it.
// Nothing changes, in RAM or flash, unless it returns PROV_FORGOT.
prov_forget_t prov_forget_network(provisioning_t *p, const char *ssid);

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
