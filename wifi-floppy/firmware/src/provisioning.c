// The provisioning decision, and only the decision. See provisioning.h for
// why this file holds no SDK or lwIP include.
#include "provisioning.h"
#include <stdarg.h>
#include <stdio.h>
#include <string.h>


static void round_reset(provisioning_t *p) {
    p->round_pos = 0;
    for (int i = 0; i < CONFIG_NETS_MAX; i++) p->result[i] = NET_JOIN_OK;
}

void prov_init(provisioning_t *p) {
    memset(p, 0, sizeof *p);
    p->have_config = config_store_load(&p->cfg);
    p->state = p->have_config ? PROV_RUNNING : PROV_PORTAL;
}

// Position `pos` of the order "net[last], then the others in saved order".
static int order_at(const device_config_t *cfg, int pos) {
    int n = cfg->n_nets, last = cfg->last;
    if (n < 1) return -1;
    if (last < 0 || last >= n) last = 0;
    pos %= n;
    if (pos == 0) return last;
    // The pos-th network that is not `last`, in saved order.
    for (int i = 0; i < n; i++) {
        if (i == last) continue;
        if (--pos == 0) return i;
    }
    return last;   // unreachable: pos < n
}

int prov_next_net(const provisioning_t *p) {
    if (!p->have_config) return -1;
    return order_at(&p->cfg, p->round_pos);
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
        if (idx >= 0 && idx != p->cfg.last) {
            // Tried first from now on. A refused write (a disk is mounted)
            // keeps it in RAM only: the next boot tries the old order, which
            // costs one attempt, not a network.
            p->cfg.last = idx;
            (void)config_store_update(&p->cfg);
        }
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
    // The edit is made on a copy, so a refused flash write leaves p->cfg
    // exactly as it was. A ~410 B local: this runs only on core1's portal
    // path (~2.3 KB of its 16 KB stack, main.c's CORE1_STACK_BYTES comment),
    // and a static would come out of a heap that sits near its floor.
    device_config_t edit;
    if (p->have_config) edit = p->cfg;
    else memset(&edit, 0, sizeof edit);
    if (new_code) {
        memset(edit.code, 0, sizeof edit.code);
        memcpy(edit.code, f->code, strnlen(f->code, CONFIG_CODE_MAX));
    } else if (!p->have_config || edit.code[0] == '\0') {
        return false;   // nothing to pair with; portal_http.c refuses this before the join
    }
    int idx = config_add_net(&edit, f->ssid, f->pass);
    if (idx < 0) return false;   // full and new; portal_http.c refuses this before the join
    edit.last = idx;
    // A new code is a new pairing: config_store_save() erases the token, as
    // every submit did before. Without one the board is still the device the
    // server knows: config_store_update() keeps the token.
    if (!(new_code ? config_store_save(&edit) : config_store_update(&edit))) return false;
    p->cfg = edit;
    p->have_config = true;
    p->assoc_failures = 0;
    round_reset(p);
    p->state = PROV_RUNNING;
    return true;
}

// snprintf appended at buf[*len]; false (and *len unchanged) if it would not fit.
static bool append(char *buf, int cap, int *len, const char *fmt, ...) {
    if (*len < 0 || *len >= cap) return false;
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(buf + *len, (size_t)(cap - *len), fmt, ap);
    va_end(ap);
    if (n < 0 || n >= cap - *len) { buf[*len] = '\0'; return false; }
    *len += n;
    return true;
}

// Curly quotes around an SSID: a straight " would become &quot; in the page,
// and the SSID itself may hold one.
#define LQ "\xe2\x80\x9c"
#define RQ "\xe2\x80\x9d"

bool prov_forget_network(provisioning_t *p, const char *ssid, char *msg, int cap) {
    int len = 0;
    if (msg && cap > 0) msg[0] = '\0';
    int idx = p->have_config ? config_find_net(&p->cfg, ssid) : -1;
    if (idx < 0) {
        if (msg) append(msg, cap, &len, LQ "%s" RQ " is not saved on this board.", ssid ? ssid : "");
        return false;
    }
    if (p->cfg.n_nets <= 1) {
        if (msg) append(msg, cap, &len, LQ "%s" RQ " is the only saved network. Add another network "
                        "before removing it.", ssid);
        return false;
    }
    device_config_t edit = p->cfg;   // a local, as in prov_on_verified_submit
    config_remove_net(&edit, idx);
    if (!config_store_update(&edit)) {
        if (msg) append(msg, cap, &len, "Could not remove " LQ "%s" RQ ": the change was not saved. "
                        "Try again.", ssid);
        return false;
    }
    p->cfg = edit;
    round_reset(p);
    return true;
}

// What each outcome means, in two parts: a few words after the network's
// name, and what to do about it. Only distinctions net_radio_sta_connect can
// actually make (net_radio_cyw43.c). Spec §6's two-message requirement is
// "wrong password" vs "not found"; both stay, now with the network named.
static const char *reason_short(net_join_t r) {
    switch (r) {
    case NET_JOIN_NOT_FOUND:  return "not found";
    case NET_JOIN_BAD_AUTH:   return "wrong password";
    case NET_JOIN_FAILED:     return "the network refused the connection";
    case NET_JOIN_NO_ADDRESS: return "joined, but the network gave the board no address";
    case NET_JOIN_TIMEOUT:    return "no answer in time";
    case NET_JOIN_ERROR:      return "the board's WiFi chip did not start the join";
    case NET_JOIN_OK:         break;
    }
    return "could not connect";
}

static const char *reason_hint(net_join_t r) {
    switch (r) {
    case NET_JOIN_NOT_FOUND:
        return "The board only sees 2.4 GHz networks, and cannot join one that is WPA3-only. "
               "Phone hotspots often need " LQ "Maximise compatibility" RQ " (iPhone) or a "
               "2.4 GHz band (Android) turned on.";
    case NET_JOIN_BAD_AUTH:
        return "Check the password; it is case-sensitive. If it is right, the network may be "
               "WPA3-only: the board needs WPA2.";
    case NET_JOIN_FAILED:
        return "A network that refuses the board may be WPA3-only (the board needs WPA2) or "
               "admit only devices it knows.";
    case NET_JOIN_NO_ADDRESS:
        return "Restart the router or hotspot, then try again.";
    case NET_JOIN_TIMEOUT:
        return "Move the board closer to the router, then try again.";
    case NET_JOIN_ERROR:
    case NET_JOIN_OK:
        break;
    }
    return "Try again.";
}

int prov_join_message(char *buf, int cap, const char *ssid, net_join_t r) {
    if (!buf || cap <= 0) return -1;
    int len = 0;
    if (append(buf, cap, &len, "Could not join " LQ "%s" RQ ": %s.\n%s", ssid ? ssid : "",
               reason_short(r), reason_hint(r)))
        return len;
    buf[0] = '\0';
    return -1;
}

int prov_round_message(const provisioning_t *p, char *buf, int cap) {
    if (!buf || cap <= 0) return -1;
    buf[0] = '\0';
    int n = p->have_config ? p->cfg.n_nets : 0;
    if (n <= 0) return 0;
    if (n == 1) return prov_join_message(buf, cap, p->cfg.net[0].ssid, p->result[0]);
    int len = 0;
    bool ok = append(buf, cap, &len, "Could not join any saved network:");
    // In the order they are tried, so the list reads as what happened.
    for (int k = 0; k < n && ok; k++) {
        int i = order_at(&p->cfg, k);
        ok = append(buf, cap, &len, "\n" LQ "%s" RQ ": %s.", p->cfg.net[i].ssid,
                    reason_short(p->result[i]));
    }
    // Each kind of advice once, in a fixed order.
    static const net_join_t kinds[] = { NET_JOIN_NOT_FOUND, NET_JOIN_BAD_AUTH, NET_JOIN_FAILED,
                                        NET_JOIN_NO_ADDRESS, NET_JOIN_TIMEOUT, NET_JOIN_ERROR,
                                        NET_JOIN_OK };
    for (unsigned k = 0; k < sizeof kinds / sizeof kinds[0] && ok; k++) {
        bool seen = false;
        for (int i = 0; i < n; i++) seen = seen || p->result[i] == kinds[k];
        if (seen) ok = append(buf, cap, &len, "\n%s", reason_hint(kinds[k]));
    }
    if (ok) return len;
    buf[0] = '\0';
    return -1;
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
