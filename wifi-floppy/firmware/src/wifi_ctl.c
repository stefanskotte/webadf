// Wi-Fi networks from the web app: the decisions and the wire (wifi_ctl.h).
#include "wifi_ctl.h"
#include "json_scan.h"
#include <stdio.h>
#include <string.h>

static int hexv(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

int wifi_hex_encode(const char *s, char *out, int cap) {
    static const char d[] = "0123456789abcdef";
    if (!out || cap <= 0) return -1;
    int n = s ? (int)strlen(s) : 0;
    if (2 * n + 1 > cap) { out[0] = '\0'; return -1; }
    for (int i = 0; i < n; i++) {
        unsigned char b = (unsigned char)s[i];
        out[2 * i] = d[b >> 4];
        out[2 * i + 1] = d[b & 15];
    }
    out[2 * n] = '\0';
    return 2 * n;
}

bool wifi_hex_decode(const char *hex, char *out, int cap) {
    if (!out || cap <= 0) return false;
    out[0] = '\0';
    if (!hex) return false;
    int n = (int)strlen(hex);
    if (n == 0 || n % 2 || n / 2 > cap - 1) return false;
    for (int i = 0; i < n / 2; i++) {
        int hi = hexv(hex[2 * i]), lo = hexv(hex[2 * i + 1]);
        if (hi < 0 || lo < 0 || (hi == 0 && lo == 0)) { out[0] = '\0'; return false; }   // no NUL inside a name
        out[i] = (char)(hi << 4 | lo);
    }
    out[n / 2] = '\0';
    return true;
}

bool wifi_cmd_parse(const char *json, wifi_cmd_t *out) {
    memset(out, 0, sizeof *out);
    if (!json) return false;
    uint32_t seq;
    if (!json_u32_strict(json, "seq", &seq)) return false;
    char op[16] = "";
    json_str(json, "op", op, sizeof op);
    out->seq = seq;
    if (strcmp(op, "none") == 0 || op[0] == '\0') out->op = WIFI_OP_NONE;
    else if (strcmp(op, "open") == 0) out->op = WIFI_OP_OPEN;
    else if (strcmp(op, "close") == 0) out->op = WIFI_OP_CLOSE;
    else if (strcmp(op, "remove") == 0) {
        // json_str truncates silently: a buffer one wider than the longest
        // legal value, so a cut one is odd-length or too long and refused.
        char hex[2 * CONFIG_SSID_MAX + 2];
        if (!json_str(json, "ssid", hex, sizeof hex) || strlen(hex) > 2 * CONFIG_SSID_MAX ||
            !wifi_hex_decode(hex, out->ssid, (int)sizeof out->ssid)) {
            memset(out, 0, sizeof *out);
            return false;
        }
        out->op = WIFI_OP_REMOVE;
    } else out->op = WIFI_OP_UNKNOWN;
    return true;
}

const char *wifi_res_wire(wifi_res_t r) {
    switch (r) {
    case WIFI_RES_OK:           return "ok";
    case WIFI_RES_IDLE:         return "none";
    case WIFI_RES_UNKNOWN:      return "unknown";
    case WIFI_RES_DISK:         return "disk";
    case WIFI_RES_ONLY_ONE:     return "only_one";
    case WIFI_RES_IN_USE:       return "in_use";
    case WIFI_RES_NOT_SAVED:    return "not_saved";
    case WIFI_RES_WRITE_FAILED: return "write_failed";
    case WIFI_RES_SUBNET:       return "subnet";
    case WIFI_RES_NONE:         break;
    }
    return "";
}

wifi_res_t wifi_res_from_forget(prov_forget_t f) {
    switch (f) {
    case PROV_FORGOT:              return WIFI_RES_OK;
    case PROV_FORGET_NOT_SAVED:    return WIFI_RES_NOT_SAVED;
    case PROV_FORGET_ONLY_ONE:     return WIFI_RES_ONLY_ONE;
    case PROV_FORGET_DISK_MOUNTED: return WIFI_RES_DISK;
    case PROV_FORGET_IN_USE:       return WIFI_RES_IN_USE;
    case PROV_FORGET_WRITE_FAILED: break;
    }
    return WIFI_RES_WRITE_FAILED;
}

wifi_res_t wifi_open_check(bool disk_mounted, bool subnet_clash) {
    if (disk_mounted) return WIFI_RES_DISK;
    if (subnet_clash) return WIFI_RES_SUBNET;
    return WIFI_RES_OK;
}

// Appends; false once it would not fit (the caller then refuses the whole tail).
static bool put(char *buf, int cap, int *len, const char *s) {
    int n = (int)strlen(s);
    if (*len + n + 1 > cap) return false;
    memcpy(buf + *len, s, (size_t)n + 1);
    *len += n;
    return true;
}

int wifi_report_json(const wifi_report_t *r, char *buf, int cap) {
    if (!buf || cap <= 0) return -1;
    buf[0] = '\0';
    int len = 0;
    if (!put(buf, cap, &len, ",\"wifi\":{\"nets\":[")) goto full;
    int n = r->cfg ? r->cfg->n_nets : 0;
    if (n < 0) n = 0;
    if (n > CONFIG_NETS_MAX) n = CONFIG_NETS_MAX;
    for (int i = 0; i < n; i++) {
        char hex[2 * CONFIG_SSID_MAX + 1];
        if (wifi_hex_encode(r->cfg->net[i].ssid, hex, (int)sizeof hex) < 0) goto full;   // cannot: ssid <= 32
        if (!put(buf, cap, &len, i ? ",\"" : "\"") || !put(buf, cap, &len, hex) || !put(buf, cap, &len, "\""))
            goto full;
    }
    {
        const int cur = (r->cur >= 0 && r->cur < n) ? r->cur : -1;
        const uint32_t setup = r->setup_s > 3600u ? 3600u : r->setup_s;
        char tail[96];
        if (r->res == WIFI_RES_NONE)
            snprintf(tail, sizeof tail, "],\"cur\":%d,\"ack\":%lu,\"res\":null,\"setup\":%lu}",
                     cur, (unsigned long)r->ack, (unsigned long)setup);
        else
            snprintf(tail, sizeof tail, "],\"cur\":%d,\"ack\":%lu,\"res\":\"%s\",\"setup\":%lu}",
                     cur, (unsigned long)r->ack, wifi_res_wire(r->res), (unsigned long)setup);
        if (!put(buf, cap, &len, tail)) goto full;
    }
    return len;
full:
    buf[0] = '\0';
    return -1;
}

void wifi_window_open(wifi_window_t *w, uint32_t now, uint32_t ms) {
    w->open = true;
    w->until_ms = now + ms;
}

uint32_t wifi_window_left_ms(const wifi_window_t *w, uint32_t now) {
    if (!w->open) return 0;
    const int32_t left = (int32_t)(w->until_ms - now);   // wrap-safe for spans under 24 days
    return left > 0 ? (uint32_t)left : 0;
}

void wifi_window_at_least(wifi_window_t *w, uint32_t now, uint32_t ms) {
    if (!w->open) return;
    if (wifi_window_left_ms(w, now) < ms) w->until_ms = now + ms;
}

void wifi_window_close(wifi_window_t *w) {
    w->open = false;
    w->until_ms = 0;
}

bool wifi_window_due(const wifi_window_t *w, uint32_t now) {
    return w->open && wifi_window_left_ms(w, now) == 0;
}

unsigned wifi_window_left_min(const wifi_window_t *w, uint32_t now) {
    const uint32_t ms = wifi_window_left_ms(w, now);
    return (unsigned)((ms + 59999u) / 60000u);
}

void wifi_check_run(provisioning_t *p, const char *ssid, const char *pass,
                    const wifi_check_ops_t *ops, wifi_check_t *out) {
    memset(out, 0, sizeof *out);
    out->back_on = -1;
    // The network the board was on: the one the return starts with. The new
    // network may replace its password in place (the same name), which keeps
    // its index -- so the board goes back to it with the password just checked.
    const int was = p->joined ? p->first : 0;

    out->join = ops->join(ops->ctx, ssid, pass);
    if (out->join == NET_JOIN_OK) {
        out->tried_save = true;
        out->saved = prov_add_network(p, ssid, pass);
    }

    out->back_on = wifi_rejoin_run(p, was, ops, &out->attempts);
}

int wifi_rejoin_run(provisioning_t *p, int from, const wifi_check_ops_t *ops, int *attempts) {
    // The round logic the board starts with, from `from`. prov_on_join_result
    // records each failure and, on a success, makes that network `first`.
    int back_on = -1;
    p->first = (from >= 0 && from < p->cfg.n_nets) ? from : 0;
    p->round_pos = 0;
    p->assoc_failures = 0;
    for (int i = 0; i < CONFIG_NETS_MAX; i++) p->result[i] = NET_JOIN_OK;
    p->state = PROV_RUNNING;
    while (p->have_config && p->cfg.n_nets > 0) {
        const int idx = prov_next_net(p);
        if (idx < 0) break;
        const net_join_t r = ops->join(ops->ctx, p->cfg.net[idx].ssid, p->cfg.net[idx].pass);
        if (attempts) (*attempts)++;
        prov_on_join_result(p, r);
        if (r == NET_JOIN_OK) { back_on = idx; break; }
        if (p->state == PROV_PORTAL) break;   // PROV_MAX_ASSOC_FAILURES whole rounds
    }
    if (back_on < 0) p->joined = false;
    p->state = PROV_RUNNING;   // the caller decides what a failed return means (main.c: a restart)
    return back_on;
}
