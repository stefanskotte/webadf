// The provisioning decision, and only the decision. See provisioning.h for
// why this file holds no SDK or lwIP include.
#include "provisioning.h"
#include <string.h>

void prov_init(provisioning_t *p) {
    memset(p, 0, sizeof *p);
    p->have_config = config_store_load(&p->cfg);
    p->state = p->have_config ? PROV_RUNNING : PROV_PORTAL;
}

prov_state_t prov_on_assoc_result(provisioning_t *p, bool ok) {
    if (ok) {
        // Reset rather than decrement: the counter measures *consecutive*
        // failures, so one good association means the run of bad ones is
        // over. Decrementing would let a board that reconnects between
        // outages still drift into the portal over a long enough day.
        p->assoc_failures = 0;
        return p->state;
    }
    if (p->assoc_failures < PROV_MAX_ASSOC_FAILURES) p->assoc_failures++;
    if (p->assoc_failures >= PROV_MAX_ASSOC_FAILURES) p->state = PROV_PORTAL;
    return p->state;
}

bool prov_on_verified_submit(provisioning_t *p, const device_config_t *cfg) {
    // Called only after the caller has associated with these credentials
    // successfully (spec D-4b-3). If the commit itself fails, stay in the
    // portal and say so -- claiming RUNNING would send the caller off with
    // credentials that were never stored.
    if (!config_store_save(cfg)) return false;
    p->cfg = *cfg;
    p->have_config = true;
    p->assoc_failures = 0;
    p->state = PROV_RUNNING;
    return true;
}

prov_state_t prov_on_pairing_code_rejected(provisioning_t *p) {
    // Terminal, per spec D-4b-4. Erasing the config also erases the token
    // (config_store_erase does both), which is what a re-pair needs: the
    // server issues a new device row and a new token, so the old one must
    // not survive.
    config_store_erase();
    memset(&p->cfg, 0, sizeof p->cfg);
    p->have_config = false;
    p->assoc_failures = 0;
    p->state = PROV_PORTAL;
    return p->state;
}

bool prov_on_portal_idle_timeout(provisioning_t *p) {
    // Nothing stored means nothing to re-try -- see provisioning.h. Leaving
    // the state alone (rather than "returning" to a PROV_RUNNING with no
    // credentials in it) is the whole point: the caller loops straight back
    // into the portal, which is where such a board belongs.
    if (!p->have_config) return false;
    // Reset the counter for the same reason prov_on_assoc_result() resets
    // it on success: this is a fresh run of attempts against a network that
    // may well have come back since the last one, not a continuation of the
    // run that opened the portal.
    p->assoc_failures = 0;
    p->state = PROV_RUNNING;
    return true;
}
