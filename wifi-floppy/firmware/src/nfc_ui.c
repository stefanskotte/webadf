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
    case DC_TAP_TOO_LONG:  fixed = "Tag: too long for board"; break;
    case DC_TAP_IGNORED:   return NULL;
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

void nfc_ui_armed_line(const char *title, char *buf, int cap) {
    if (title && title[0]) snprintf(buf, (size_t)cap, "Tap tag to write: %s", title);
    else                   snprintf(buf, (size_t)cap, "Tap tag to write");
}

void nfc_ui_uid_hex(const nfc_event_t *ev, char out[NFC_UI_UID_HEX_BYTES]) {
    if (ev->uid_len <= 0) { snprintf(out, NFC_UI_UID_HEX_BYTES, "none"); return; }
    int n = ev->uid_len > 4 ? 4 : ev->uid_len;
    for (int i = 0; i < n; i++) snprintf(out + 2 * i, 3, "%02X", ev->uid[i]);
}

void nfc_armed_init(nfc_armed_t *a) {
    memset(a, 0, sizeof *a);
}

void nfc_armed_set(nfc_armed_t *a, uint32_t seq, const char *line, uint32_t now) {
    a->armed = true;
    a->seq = seq;
    a->since = now;
    snprintf(a->line, sizeof a->line, "%s", line ? line : "");
}

void nfc_armed_clear(nfc_armed_t *a) {
    a->armed = false;
}

bool nfc_armed_expired(const nfc_armed_t *a, uint32_t now) {
    return a->armed && now - a->since >= NFC_WRITE_LIFETIME_MS;
}

void nfc_armed_on_event(nfc_armed_t *a, const nfc_event_t *ev) {
    if (a->armed && ev->kind == NFC_EV_WRITE_DONE && ev->seq == a->seq) a->armed = false;
}

const char *nfc_ui_detail(const char *base, const char *tag, uint32_t tag_at, uint32_t now,
                          const nfc_armed_t *armed) {
    if (tag && tag[0] && now - tag_at < NFC_UI_LINE_MS) return tag;
    if (armed && armed->armed) return armed->line;
    return base;
}
