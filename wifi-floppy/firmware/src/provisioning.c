// The provisioning decision, and only the decision. See provisioning.h for
// why this file holds no SDK or lwIP include. The words the setup page shows
// for these decisions are portal_http.c's.
#include "provisioning.h"
#include "psram_image.h"   // psram_active_slot(): config_store's write guard, to say why it refused
#include "token_store.h"
#include "secure_zero.h"
#include <string.h>

static void round_reset(provisioning_t *p) {
    p->round_pos = 0;
    for (int i = 0; i < CONFIG_NETS_MAX; i++) p->result[i] = NET_JOIN_OK;
}

void prov_init(provisioning_t *p) {
    memset(p, 0, sizeof *p);
    p->have_config = config_store_load(&p->cfg);
    p->first = 0;   // power-on: the saved order (review I2)
    p->state = p->have_config ? PROV_RUNNING : PROV_PORTAL;
}

// Position `pos` of the order "net[first], then the others in saved order".
static int order_at(const device_config_t *cfg, int first, int pos) {
    int n = cfg->n_nets;
    if (n < 1) return -1;
    if (first < 0 || first >= n) first = 0;
    pos %= n;
    if (pos == 0) return first;
    // The pos-th network that is not `first`, in saved order.
    for (int i = 0; i < n; i++) {
        if (i == first) continue;
        if (--pos == 0) return i;
    }
    return first;   // unreachable: pos < n
}

int prov_next_net(const provisioning_t *p) {
    if (!p->have_config) return -1;
    return order_at(&p->cfg, p->first, p->round_pos);
}

int prov_order_at(const provisioning_t *p, int k) {
    if (!p->have_config) return -1;
    return order_at(&p->cfg, p->first, k);
}

bool prov_paired(const provisioning_t *p) {
    if (p->have_config && p->cfg.code[0] != '\0') return true;
    char tok[TOKEN_STORE_MAX_LEN + 1];
    bool have = token_store_load(tok, sizeof tok);
    secure_zero(tok, sizeof tok);   // a dead store a plain memset would lose
    return have;
}

prov_state_t prov_on_join_result(provisioning_t *p, net_join_t r) {
    int idx = prov_next_net(p);
    if (r == NET_JOIN_OK) {
        // Reset rather than decrement: the counter measures *consecutive*
        // failures, so one good association means the run of bad ones is
        // over. Decrementing would let a board that reconnects between
        // outages still drift into the portal over a long enough day.
        p->assoc_failures = 0;
        round_reset(p);
        // Tried first for the rest of this session. RAM only -- see `first`.
        if (idx >= 0) { p->first = idx; p->joined = true; }
        return p->state;
    }
    if (idx >= 0) p->result[idx] = r;
    p->round_pos++;
    int n = p->have_config && p->cfg.n_nets > 0 ? p->cfg.n_nets : 1;
    if (p->round_pos < n) return p->state;   // the round goes on: next network
    p->round_pos = 0;                        // a whole round failed
    if (p->assoc_failures < PROV_MAX_ASSOC_FAILURES) p->assoc_failures++;
    if (p->assoc_failures >= PROV_MAX_ASSOC_FAILURES) p->state = PROV_PORTAL;
    return p->state;
}

bool prov_on_verified_submit(provisioning_t *p, const setup_form_t *f) {
    // Called only after the caller has associated with this network
    // successfully (spec D-4b-3). If the commit itself fails, stay in the
    // portal and say so -- claiming RUNNING would send the caller off with
    // credentials that were never stored.
    bool new_code = f->code[0] != '\0';
    if (!new_code && !prov_paired(p)) return false;   // nothing to pair with; portal_http.c refuses this first
    // The edit is made on a copy, so a refused flash write leaves p->cfg
    // exactly as it was. A ~420 B local: this runs only on core1's portal
    // path (main.c's CORE1_STACK_BYTES comment), and a static would come out
    // of a heap that sits near its floor.
    device_config_t edit;
    if (p->have_config) edit = p->cfg;
    else memset(&edit, 0, sizeof edit);
    if (new_code) {
        memset(edit.code, 0, sizeof edit.code);
        memcpy(edit.code, f->code, strnlen(f->code, CONFIG_CODE_MAX));
    }
    int idx = config_add_net(&edit, f->ssid, f->pass);
    if (idx < 0) { secure_zero(&edit, sizeof edit); return false; }   // full and new; refused on the page first
    edit.last = idx;             // page 0: the network just verified
    // A new code is a new pairing: config_store_save() erases the token, as
    // every submit did before. Without one the board is still the device the
    // server knows: config_store_update() keeps the token.
    bool saved = new_code ? config_store_save(&edit) : config_store_update(&edit);
    if (saved) p->cfg = edit;
    secure_zero(&edit, sizeof edit);   // passwords: the stack copy goes either way
    if (!saved) return false;
    p->have_config = true;
    p->assoc_failures = 0;
    p->first = idx;
    p->joined = true;
    round_reset(p);
    p->state = PROV_RUNNING;
    return true;
}

prov_forget_t prov_forget_network(provisioning_t *p, const char *ssid) {
    int idx = p->have_config ? config_find_net(&p->cfg, ssid) : -1;
    if (idx < 0) return PROV_FORGET_NOT_SAVED;
    if (p->cfg.n_nets <= 1) return PROV_FORGET_ONLY_ONE;
    // config_store's own guard, checked first so the page can say why.
    if (psram_active_slot() != SLOT_NONE) return PROV_FORGET_DISK_MOUNTED;
    device_config_t edit = p->cfg;   // a local, as in prov_on_verified_submit
    // A user action writes anyway: page 0 gets the network joined last this
    // session (operator 2026-11-15) -- if one was joined (review M-3: `first`
    // is only the power-on default otherwise) and it is not the one going.
    int first = p->first;
    edit.last = (p->joined && first >= 0 && first < edit.n_nets && first != idx) ? first : edit.last;
    config_remove_net(&edit, idx);
    if (!config_store_update(&edit)) { secure_zero(&edit, sizeof edit); return PROV_FORGET_WRITE_FAILED; }
    // `first` follows its network; if it was the one removed, the saved order.
    if (first == idx) { first = 0; p->joined = false; }
    else if (first > idx) first--;
    p->cfg = edit;
    secure_zero(&edit, sizeof edit);
    p->first = first;
    round_reset(p);
    return PROV_FORGOT;
}

prov_forget_t prov_forget_other_network(provisioning_t *p, const char *ssid) {
    int idx = p->have_config ? config_find_net(&p->cfg, ssid) : -1;
    if (idx >= 0 && p->joined && idx == p->first) return PROV_FORGET_IN_USE;
    return prov_forget_network(p, ssid);
}

prov_add_t prov_add_network(provisioning_t *p, const char *ssid, const char *pass) {
    if (!p->have_config) return PROV_ADD_NO_CONFIG;
    // The same order of checks the page uses, so the reason given is the real one.
    if (config_find_net(&p->cfg, ssid) < 0 && p->cfg.n_nets >= CONFIG_NETS_MAX) return PROV_ADD_FULL;
    if (psram_active_slot() != SLOT_NONE) return PROV_ADD_DISK_MOUNTED;
    device_config_t edit = p->cfg;   // a local, as in prov_on_verified_submit
    int idx = config_add_net(&edit, ssid, pass);
    // Full was answered above; -1 here is a name or password the page would not have let through.
    if (idx < 0) { secure_zero(&edit, sizeof edit); return PROV_ADD_WRITE_FAILED; }
    // Page 0: the network the board is on (joined this session), as a Remove writes it.
    if (p->joined && p->first >= 0 && p->first < edit.n_nets) edit.last = p->first;
    if (!config_store_update(&edit)) { secure_zero(&edit, sizeof edit); return PROV_ADD_WRITE_FAILED; }
    p->cfg = edit;   // indices of the networks already saved do not move (config_add_net appends)
    secure_zero(&edit, sizeof edit);
    return PROV_ADDED;
}

prov_state_t prov_on_pairing_code_rejected(provisioning_t *p) {
    // Terminal, per spec D-4b-4. Erasing the config also erases the token
    // (config_store_erase does both), which is what a re-pair needs: the
    // server issues a new device row and a new token, so the old one must
    // not survive. Every saved network goes with it, as the one network did
    // before: the portal then asks for a network and a fresh code together.
    config_store_erase();
    memset(&p->cfg, 0, sizeof p->cfg);
    p->have_config = false;
    p->assoc_failures = 0;
    p->first = 0;
    p->joined = false;
    round_reset(p);
    p->state = PROV_PORTAL;
    return p->state;
}

bool prov_on_portal_idle_timeout(provisioning_t *p) {
    // Nothing stored means nothing to re-try -- see provisioning.h. Leaving
    // the state alone (rather than "returning" to a PROV_RUNNING with no
    // credentials in it) is the whole point: the caller loops straight back
    // into the portal, which is where such a board belongs.
    if (!p->have_config) return false;
    // Reset the counter for the same reason prov_on_join_result() resets
    // it on success: this is a fresh run of rounds against networks that
    // may well have come back since the last one, not a continuation of the
    // run that opened the portal.
    p->assoc_failures = 0;
    round_reset(p);
    p->state = PROV_RUNNING;
    return true;
}
