// NET: volumes' request state (fw 1.22.0). See amiga_req.h.
#include "amiga_req.h"
#include "amiga_send.h"   // as_json_escape
#include <stdio.h>
#include <string.h>

#define AR_CLOSE_RESERVE 16            // "],\"last\":false}" is 15

static void cpy(char *d, size_t cap, const char *s) { size_t k = strnlen(s, cap - 1); memcpy(d, s, k); d[k] = 0; }

void ar_init(as_req_t *r) { memset(r, 0, sizeof *r); }

void ar_fetched(as_req_t *r, int n) {
    if (n < 0) n = 0;
    if (n > AR_FETCH_BYTES) n = AR_FETCH_BYTES;
    r->fetched[n] = 0;
    r->fetched_len = n;
    r->fetched_off = 0;
}
bool ar_pending(const as_req_t *r) { return r->fetched_off < r->fetched_len; }

static bool rid_ok(const char *t, int n) {
    if (n < 1 || n > AR_RID_MAX) return false;
    for (int i = 0; i < n; i++) {
        const char c = t[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_')) return false;
    }
    return true;
}
// "<len>:<text>" filling exactly n bytes: text 1..255 bytes, no control byte.
static bool path_ok(const char *p, int n) {
    int d = 0;
    unsigned len = 0;
    while (d < n && d < 4 && p[d] >= '0' && p[d] <= '9') { len = len * 10u + (unsigned)(p[d] - '0'); d++; }
    if (d == 0 || d >= n || p[d] != ':' || len < 1 || len > 255 || (int)len != n - d - 1) return false;
    for (int i = d + 1; i < n; i++) if ((unsigned char)p[i] < 0x20 || (unsigned char)p[i] == 0x7f) return false;
    return true;
}

bool ar_take(as_req_t *r, int *skipped) {
    while (ar_pending(r)) {
        const char *l = r->fetched + r->fetched_off;
        const char *nl = memchr(l, '\n', (size_t)(r->fetched_len - r->fetched_off));
        const int n = nl ? (int)(nl - l) : r->fetched_len - r->fetched_off;
        r->fetched_off += n + (nl ? 1 : 0);
        ar_kind_t k = AR_NONE;
        int vl = 0;
        if (n > 5 && strncmp(l, "VOLS ", 5) == 0) { k = AR_VOLS; vl = 5; }
        else if (n > 4 && strncmp(l, "DIR ", 4) == 0) { k = AR_DIR; vl = 4; }
        else if (n > 4 && strncmp(l, "GET ", 4) == 0) { k = AR_GET; vl = 4; }
        const char *id = l + vl;
        const char *sp = k == AR_NONE ? NULL : memchr(id, ' ', (size_t)(n - vl));
        const int idn = sp ? (int)(sp - id) : n - vl;
        const bool ok = k != AR_NONE && n <= AR_LINE_MAX && rid_ok(id, idn) &&
                        (k == AR_VOLS ? sp == NULL : (sp != NULL && path_ok(sp + 1, n - vl - idn - 1)));
        if (!ok) { if (skipped) (*skipped)++; continue; }
        r->active = true; r->sent = false; r->ended = false; r->discard = false;
        r->kind = k;
        memcpy(r->rid, id, (size_t)idn); r->rid[idn] = 0;
        memcpy(r->out, l, (size_t)n); r->out[n] = '\n'; r->out[n + 1] = 0; r->out_n = n + 1;
        r->piece = 0; r->lines_total = 0; r->end_err[0] = 0; r->post_owed = false; r->post_last = false;
        ar_body_begin(r);
        return true;
    }
    return false;
}

void ar_body_begin(as_req_t *r) {
    r->body_len = snprintf(r->body, sizeof r->body, "{\"piece\":%lu,\"lines\":[", (unsigned long)r->piece);
    r->body_lines = 0;
}
// The line's length once escaped as as_json_escape does.
static int esc_len(const char *s) {
    int k = 0;
    for (const unsigned char *p = (const unsigned char *)s; *p; p++)
        k += (*p == '"' || *p == '\\') ? 2 : (*p < 0x20 || *p >= 0x7f) ? 6 : 1;
    return k;
}
bool ar_body_add(as_req_t *r, const char *line) {
    const int need = esc_len(line) + 3;   // the quotes and a comma
    if (r->body_lines >= AR_PIECE_LINES || r->body_len + need + AR_CLOSE_RESERVE > AR_BODY_BYTES) return false;
    char *o = r->body + r->body_len;
    if (r->body_lines) *o++ = ',';
    *o++ = '"';
    o += as_json_escape(o, AR_BODY_BYTES - (int)(o - r->body), line, (int)strlen(line));
    *o++ = '"';
    *o = 0;
    r->body_len = (int)(o - r->body);
    r->body_lines++;
    r->lines_total++;
    return true;
}
bool ar_body_full(const as_req_t *r) {
    return r->body_lines >= AR_PIECE_LINES || r->body_len + AR_LINE_MAX * 6 + 3 + AR_CLOSE_RESERVE > AR_BODY_BYTES;
}
void ar_body_close(as_req_t *r, bool last) {
    r->body_len += snprintf(r->body + r->body_len, (size_t)(AR_BODY_BYTES - r->body_len), "],\"last\":%s}",
                            last ? "true" : "false");
    r->post_owed = true;
    r->post_last = last;
    if (last) r->ended = true;
}
void ar_finish(as_req_t *r) {
    r->active = r->sent = r->ended = r->discard = r->post_owed = r->post_last = false;
    r->kind = AR_NONE; r->rid[0] = 0; r->end_err[0] = 0; r->body_len = 0; r->body_lines = 0;
}
void ar_body_posted(as_req_t *r) {
    r->post_owed = false;
    if (r->post_last) { ar_finish(r); return; }
    r->piece++;
    ar_body_begin(r);
    if (r->end_err[0]) {
        (void)ar_body_add(r, r->end_err);   // an empty piece always takes one line
        r->end_err[0] = 0;
        ar_body_close(r, true);
    }
}
int ar_err_line(char *out, int cap, const char *rid, const char *code, const char *text) {
    const int tn = (int)strnlen(text, 79);
    const int n = snprintf(out, (size_t)cap, "ERR %s %s %d:%.*s", rid, code, tn, tn, text);
    return (n < 0 || n >= cap) ? -1 : n;
}
void ar_end_err(as_req_t *r, const char *code, const char *text) {
    char line[AR_ERR_MAX + 1];
    if (!r->active || r->ended) return;
    if (r->discard) { ar_finish(r); return; }
    if (ar_err_line(line, sizeof line, r->rid, code, text) < 0) return;
    r->ended = true;
    if (r->post_owed) { cpy(r->end_err, sizeof r->end_err, line); return; }
    if (!ar_body_add(r, line)) { ar_body_close(r, false); r->ended = true; cpy(r->end_err, sizeof r->end_err, line); return; }
    ar_body_close(r, true);
}

bool ar_line_verb(const char *line, char verb[5], char rid[AR_RID_MAX + 1]) {
    static const char *const V[] = { "VOL", "ENT", "DONE", "ERR", "GOT" };
    for (unsigned i = 0; i < sizeof V / sizeof V[0]; i++) {
        const size_t vl = strlen(V[i]);
        if (strncmp(line, V[i], vl) != 0 || line[vl] != ' ') continue;
        const char *id = line + vl + 1, *e = id;
        while (*e && *e != ' ') e++;
        if (!rid_ok(id, (int)(e - id))) return false;
        memcpy(verb, V[i], vl + 1);
        memcpy(rid, id, (size_t)(e - id)); rid[e - id] = 0;
        return true;
    }
    return false;
}

ar_got_t *ar_got_add(as_req_t *r, const char *rid, const char *tag) {
    ar_got_t *g = NULL;
    for (int i = 0; i < AR_MAX && !g; i++) if (!r->got[i].used) g = &r->got[i];
    if (!g) { g = &r->got[0]; for (int i = 1; i < AR_MAX; i++) if (r->got[i].seq < g->seq) g = &r->got[i]; }
    memset(g, 0, sizeof *g);
    g->used = true;
    g->seq = ++r->got_seq;
    cpy(g->rid, sizeof g->rid, rid);
    cpy(g->tag, sizeof g->tag, tag);
    return g;
}
ar_got_t *ar_got_by_tag(as_req_t *r, const char *tag) {
    for (int i = 0; i < AR_MAX; i++) if (r->got[i].used && strcmp(r->got[i].tag, tag) == 0) return &r->got[i];
    return NULL;
}
ar_got_t *ar_got_by_rid(as_req_t *r, const char *rid) {
    for (int i = 0; i < AR_MAX; i++) if (r->got[i].used && strcmp(r->got[i].rid, rid) == 0) return &r->got[i];
    return NULL;
}
void ar_got_fail(ar_got_t *g, const char *code, const char *text) {
    if (g->err_owed) return;
    if (ar_err_line(g->err, sizeof g->err, g->rid, code, text) >= 0) g->err_owed = true;
}
void ar_got_late(ar_got_t *g, const char *line) {
    if (g->err_owed || strlen(line) > AR_ERR_MAX) return;
    cpy(g->err, sizeof g->err, line);
    g->err_owed = true;
}
ar_got_t *ar_got_owed(const as_req_t *r) {
    for (int i = 0; i < AR_MAX; i++) if (r->got[i].used && r->got[i].err_owed) return (ar_got_t *)&r->got[i];
    return NULL;
}
int ar_late_body(as_req_t *r, const ar_got_t *g) {
    int o = snprintf(r->late, sizeof r->late, "{\"piece\":1,\"lines\":[\"");
    o += as_json_escape(r->late + o, (int)sizeof r->late - o - 20, g->err, (int)strlen(g->err));
    o += snprintf(r->late + o, sizeof r->late - (size_t)o, "\"],\"last\":true}");
    return o;
}
void ar_got_remove(ar_got_t *g) { memset(g, 0, sizeof *g); }
