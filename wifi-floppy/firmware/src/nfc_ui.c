#include "nfc_ui.h"
#include <stdio.h>
#include <string.h>

const char *nfc_ui_tap_line(dc_tap_outcome_t o, const char *title, char *buf, int cap) {
    const char *fixed;
    switch (o) {
    case DC_TAP_MOUNTING:
        snprintf(buf, (size_t)cap, "Tag: %s", title && title[0] ? title : "mounting");
        return buf;
    case DC_TAP_ALREADY:   fixed = "Tag: already in drive";   break;
    case DC_TAP_NOT_FOUND: fixed = "Tag: not in library";     break;
    case DC_TAP_TOO_LONG:  fixed = "Tag: tracks too long";    break;
    case DC_TAP_IGNORED:   fixed = "Tag: too fast";           break;
    case DC_TAP_FAILED:
    default:               fixed = "Tag: offline";            break;
    }
    snprintf(buf, (size_t)cap, "%s", fixed);
    return buf;
}

const char *nfc_ui_event_line(const nfc_event_t *ev) {
    switch (ev->kind) {
    case NFC_EV_NOT_OURS:   return "Tag: not a disk tag";
    case NFC_EV_UNREADABLE:
        return ev->why && strcmp(ev->why, "locked") == 0 ? "Tag: locked" : "Tag: unreadable";
    case NFC_EV_WRITE_DONE: return ev->ok ? "Tag written" : "Write failed";
    default:                return NULL;
    }
}

void nfc_ui_uid_hex(const nfc_event_t *ev, char out[NFC_UI_UID_HEX_BYTES]) {
    if (ev->uid_len <= 0) { snprintf(out, NFC_UI_UID_HEX_BYTES, "none"); return; }
    int n = ev->uid_len > 4 ? 4 : ev->uid_len;
    for (int i = 0; i < n; i++) snprintf(out + 2 * i, 3, "%02X", ev->uid[i]);
}

void nfc_armed_init(nfc_armed_t *a) {
    memset(a, 0, sizeof *a);
}

void nfc_armed_set(nfc_armed_t *a, uint32_t seq, const char *title, uint32_t now) {
    a->armed = true;
    a->seq = seq;
    a->since = now;
    snprintf(a->title, sizeof a->title, "%s", title ? title : "");
}

void nfc_armed_clear(nfc_armed_t *a) {
    a->armed = false;
}

bool nfc_armed_expired(nfc_armed_t *a, uint32_t now) {
    if (!a->armed || now - a->since < NFC_WRITE_LIFETIME_MS) return false;
    a->armed = false;                // ended here, once: a wrapped clock cannot revive it
    return true;
}

void nfc_armed_on_event(nfc_armed_t *a, const nfc_event_t *ev) {
    if (a->armed && ev->kind == NFC_EV_WRITE_DONE && ev->seq == a->seq) a->armed = false;
}

void nfc_tag_clock_init(nfc_tag_clock_t *c) {
    memset(c, 0, sizeof *c);
}

bool nfc_tag_clock_live(nfc_tag_clock_t *c, uint32_t n, uint32_t at, uint32_t now) {
    if (n != c->n) {                 // a new publication starts its own 3 s
        c->n = n;
        c->at = at;
        c->live = n != 0;
    }
    if (c->live && now - c->at >= NFC_UI_LINE_MS) c->live = false;   // over, for good
    return c->live;
}

const char *nfc_ui_detail(const char *base, const char *tag, bool tag_live,
                          const nfc_armed_t *armed) {
    if (tag && tag[0] && tag_live) return tag;
    if (armed && armed->armed) return NFC_UI_ARMED_DETAIL;
    return base;
}

const char *nfc_ui_title(const char *base, const nfc_armed_t *armed) {
    if (armed && armed->armed && armed->title[0]) return armed->title;
    return base;
}
