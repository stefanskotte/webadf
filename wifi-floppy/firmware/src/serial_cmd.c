#include "serial_cmd.h"
#include <string.h>

static const char USAGE[] = "usage: wf server set https://host[:port]";

void sc_init(sc_state_t *s) { memset(s, 0, sizeof *s); }

static void result(sc_cmd_t *out, sc_kind_t kind, const char *text) {
    memset(out, 0, sizeof *out);
    out->kind = kind;
    out->text = text;
}

static bool host_char_ok(char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '-';
}

// `rest` is what follows "wf server set ". Fills host and port on success.
static void parse_set(const char *rest, sc_cmd_t *out) {
    if (strncmp(rest, "http://", 7) == 0) { result(out, SC_ERROR, "plain http is not supported -- use https://"); return; }
    if (strncmp(rest, "https://", 8) != 0) { result(out, SC_ERROR, USAGE); return; }
    const char *p = rest + 8;
    size_t n = 0;
    while (host_char_ok(p[n])) n++;
    if (n == 0 || n > OVERRIDE_HOST_MAX) { result(out, SC_ERROR, USAGE); return; }
    char host[OVERRIDE_HOST_MAX + 1];
    memcpy(host, p, n); host[n] = '\0';
    p += n;
    unsigned long port = 443;
    if (*p == ':') {
        p++;
        if (*p < '0' || *p > '9') { result(out, SC_ERROR, USAGE); return; }
        port = 0;
        while (*p >= '0' && *p <= '9') {
            port = port * 10 + (unsigned long)(*p - '0');
            if (port > 65535) { result(out, SC_ERROR, USAGE); return; }
            p++;
        }
        if (port < 1) { result(out, SC_ERROR, USAGE); return; }
    }
    if (*p == '/') p++;
    if (*p != '\0') { result(out, SC_ERROR, USAGE); return; }
    result(out, SC_SET, NULL);
    memcpy(out->host, host, n + 1);
    out->port = (uint16_t)port;
}

void sc_feed_line(sc_state_t *s, const char *line, sc_cmd_t *out) {
    // Trim spaces (and tabs) at both ends into a local copy.
    while (*line == ' ' || *line == '\t') line++;
    size_t len = strlen(line);
    while (len > 0 && (line[len - 1] == ' ' || line[len - 1] == '\t')) len--;
    if (len == 0) { result(out, SC_NONE, NULL); return; }         // empty: ignored, pending kept
    if (len > SC_LINE_MAX) { s->pending = false; result(out, SC_ERROR, "line too long -- ignored"); return; }
    char buf[SC_LINE_MAX + 1];
    memcpy(buf, line, len); buf[len] = '\0';

    // A pending confirmation is answered by the very next non-empty line, whatever it is.
    if (s->pending) {
        s->pending = false;
        if (strcmp(buf, "YES") == 0) { result(out, SC_TLS, NULL); out->tls = OVR_TLS_NOVERIFY; }
        else result(out, SC_ERROR, "not confirmed -- nothing changed");
        return;
    }

    if (strncmp(buf, "wf ", 3) != 0) { result(out, SC_NONE, NULL); return; }

    if (strcmp(buf, "wf server show") == 0) result(out, SC_SHOW, NULL);
    else if (strcmp(buf, "wf server set") == 0) result(out, SC_ERROR, USAGE);
    else if (strncmp(buf, "wf server set ", 14) == 0) parse_set(buf + 14, out);
    else if (strcmp(buf, "wf server tls verify") == 0) { result(out, SC_TLS, NULL); out->tls = OVR_TLS_VERIFY; }
    else if (strcmp(buf, "wf server tls noverify") == 0) {
        s->pending = true;
        result(out, SC_ASK, "noverify accepts ANY certificate for this server -- type YES to confirm");
    }
    else if (strcmp(buf, "wf server clear") == 0) result(out, SC_CLEAR, NULL);
    else if (strcmp(buf, "wf reboot") == 0) result(out, SC_REBOOT, NULL);
    else result(out, SC_ERROR, "unknown command -- wf server show|set|tls|clear, wf reboot");
}

bool sc_feed_char(sc_state_t *s, int ch, sc_cmd_t *out) {
    if (ch == '\r' || ch == '\n') {
        if (s->len == 0 && !s->overflow) return false;            // empty line (or the LF of a CRLF)
        bool over = s->overflow;
        s->line[s->len] = '\0';
        s->len = 0; s->overflow = false;
        if (over) { s->pending = false; result(out, SC_ERROR, "line too long -- ignored"); }
        else sc_feed_line(s, s->line, out);
        return true;
    }
    if (ch == 0x08 || ch == 0x7f) { if (!s->overflow && s->len > 0) s->len--; return false; }
    if (s->overflow) return false;
    if (s->len >= SC_LINE_MAX) { s->overflow = true; return false; }
    s->line[s->len++] = (char)ch;
    return false;
}
