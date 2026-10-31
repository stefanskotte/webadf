// PaulaNET Phase 4: the board's side of sending files to Receive on the Amiga. See amiga_send.h.
#include "amiga_send.h"
#include "json_scan.h"
#include "wf_log.h"
#include <stdio.h>
#include <string.h>

_Static_assert(AR_LINE_MAX == AS_LINE_MAX, "an answer line is a line from Transfer");
#define AS_TXT_NORX "Transfer is not running on the Amiga"
#define AS_TXT_LOST "The connection to Transfer was lost"
#define AS_TXT_OLD "Transfer 2.3 or newer is needed"
#define AS_TXT_SILENT "Transfer stopped answering"
static void req_on_drop(amiga_send_t *s);
static bool req_work(const amiga_send_t *s);
static bool reconnect_soon(const amiga_send_t *s, uint32_t t);

static uint32_t now(const amiga_send_t *s) { return s->ops->now_ms(s->ops->ctx); }
static void http_failed(amiga_send_t *s, const char *what, int st);
static void up_reset(amiga_send_t *s);

// The queue text's first line is "NEXT -" or "NEXT <id> <size> <crc> <prot> <len>:<path> <len>:<comment>".
static bool next_present(const amiga_send_t *s) {
    return s->queue_len > 5 && strncmp(s->queue, "NEXT ", 5) == 0 && s->queue[5] != '-';
}
static const char *list_block(const amiga_send_t *s, int *n) {
    const char *nl = memchr(s->queue, '\n', (size_t)s->queue_len);
    if (!nl) { *n = 0; return s->queue; }
    *n = s->queue_len - (int)(nl + 1 - s->queue);
    return nl + 1;
}
static uint32_t retry_ms(const amiga_send_t *s) { return next_present(s) ? AS_RETRY_WAITING_MS : AS_RETRY_IDLE_MS; }

static void push(amiga_send_t *s, const uint8_t *p, int n) { s->out_p = p; s->out_n = n; }
// Pushes what the socket takes now. false: the socket is broken.
static bool flush(amiga_send_t *s) {
    while (s->out_n > 0) {
        int k = s->ops->send(s->ops->ctx, s->out_p, s->out_n);
        if (k < 0) return false;
        if (k == 0) break;
        s->out_p += k;
        s->out_n -= k;
    }
    return true;
}

// Closes the connection and starts over: any file in flight stays queued on the server (no outcome is posted), and
// Receive deletes its temporary file when the connection goes.
static void drop(amiga_send_t *s, char rx, const char *why) {
    if (s->phase != AS_IDLE) wf_logf(WF_INFO, "send: connection to Transfer dropped (%s)", why);
    if (s->req) req_on_drop(s);
    if (s->phase >= AS_FILE_SENT && s->phase <= AS_AWAIT_OK) wf_logf(WF_WARN, "send: %.8s aborted (%s)", s->id, why);
    // An upload cut off (an Amiga reset, bench B5 2026-10-21) comes back as a fresh Receive that waits 60 s for the
    // board: reconnect at the waiting cadence, not the idle one, or the board misses it.
    const bool up_cut = s->up && (s->up->pending || (s->phase >= AS_UP_OPEN && s->phase <= AS_UP_CLOSE));
    if (s->up && s->phase >= AS_UP_OPEN && s->phase <= AS_UP_CLOSE) wf_logf(WF_WARN, "up: %s aborted (%s)", s->up->tag, why);
    if (s->up) up_reset(s);   // the server keeps the partial upload: the same file sent again resumes (spec U4)
    s->ops->close(s->ops->ctx);
    s->phase = AS_IDLE;
    s->rx = rx;
    s->out_n = 0;
    s->ping_out = false;
    const bool quick = up_cut || (s->req && s->peer_v >= 3);   // plan ruling F8: Transfer's switch shows quickly
    if (s->req && s->peer_v >= 3) s->req->quick = true;         // ... and counts as work until then (final review I1)
    s->peer_v = 0;
    s->list_owed = false;
    s->t_retry = now(s) + (quick ? AS_RETRY_WAITING_MS : retry_ms(s));
    s->force_fetch = true;
}

int as_json_escape(char *dst, int cap, const char *src, int n) {
    int o = 0;
    for (int i = 0; i < n; i++) {
        unsigned char c = (unsigned char)src[i];
        char tmp[8];
        int k;
        if (c == '"' || c == '\\') { tmp[0] = '\\'; tmp[1] = (char)c; k = 2; }
        else if (c < 0x20 || c >= 0x7f) k = snprintf(tmp, sizeof tmp, "\\u%04x", c);
        else { tmp[0] = (char)c; k = 1; }
        if (o + k >= cap) break;           // cut to fit, never half an escape
        memcpy(dst + o, tmp, (size_t)k);
        o += k;
    }
    dst[o] = 0;
    return o;
}

int as_raw_feed(as_raw_t *w, const uint8_t *b, int n) {
    const uint32_t got = w->got;                                   // this is the only writer
    const uint32_t lim = __atomic_load_n(&w->limit, __ATOMIC_ACQUIRE);
    uint32_t take = w->total - got;
    if (n <= 0 || take == 0) return 0;
    if ((uint32_t)n < take) take = (uint32_t)n;
    if (got + take > lim) { w->broken = true; return -1; }        // past the credit
    const uint32_t at = got % AS_UP_RING_BYTES;
    uint32_t first = AS_UP_RING_BYTES - at;
    if (first > take) first = take;
    memcpy(w->ring + at, b, first);
    if (take > first) memcpy(w->ring, b + first, take - first);
    __atomic_store_n(&w->got, got + take, __ATOMIC_RELEASE);       // the bytes, then the count
    return (int)take;
}

int as_utf8_to_latin1(const char *in, char *out, int cap) {
    int o = 0;
    const unsigned char *p = (const unsigned char *)in;
    while (*p && o < cap - 1) {
        if (*p < 0x80) { out[o++] = (char)*p++; }
        else if ((*p == 0xC2 || *p == 0xC3) && (p[1] & 0xC0) == 0x80) { out[o++] = (char)(((*p & 0x03u) << 6) | (p[1] & 0x3Fu)); p += 2; }
        else { out[o++] = '?'; p++; while ((*p & 0xC0) == 0x80) p++; }
    }
    out[o] = 0;
    return o;
}

static const char *word(const char **p, int *n) {
    const char *t = *p;
    while (**p && **p != ' ') (*p)++;
    *n = (int)(*p - t);
    if (**p == ' ') (*p)++;
    return t;
}
static bool dec32(const char *t, int n, uint32_t *v) {
    uint64_t x = 0;
    if (n < 1 || n > 10) return false;
    for (int i = 0; i < n; i++) { if (t[i] < '0' || t[i] > '9') return false; x = x * 10u + (uint64_t)(t[i] - '0'); }
    if (x > 0xFFFFFFFFu) return false;
    *v = (uint32_t)x;
    return true;
}
static bool hex32(const char *t, int n, uint32_t *v) {
    uint32_t x = 0;
    if (n < 1 || n > 8) return false;
    for (int i = 0; i < n; i++) {
        char c = t[i];
        int d = (c >= '0' && c <= '9') ? c - '0' : (c >= 'a' && c <= 'f') ? c - 'a' + 10 : (c >= 'A' && c <= 'F') ? c - 'A' + 10 : -1;
        if (d < 0) return false;
        x = (x << 4) | (uint32_t)d;
    }
    *v = x;
    return true;
}
// "<len>:<bytes>" then a space or the end of the line.
static bool lenfield(const char **p, const char **s, int *n) {
    const char *q = *p;
    uint32_t len = 0;
    int d = 0;
    while (*q >= '0' && *q <= '9' && d < 4) { len = len * 10u + (uint32_t)(*q - '0'); q++; d++; }
    if (d == 0 || *q != ':') return false;
    q++;
    if (strnlen(q, len) < len) return false;
    *s = q; *n = (int)len; q += len;
    if (*q == ' ') q++; else if (*q) return false;
    *p = q;
    return true;
}
bool as_put_parse(const char *line, as_put_t *o) {
    const char *p = line, *t;
    int n, dots = 0;
    if (strncmp(p, "PUT ", 4) != 0) return false;
    p += 4;
    t = word(&p, &n);
    if (n < 1 || n > AS_TAG_MAX) return false;
    for (int i = 0; i < n; i++) if (t[i] < '0' || t[i] > '9') return false;
    memcpy(o->tag, t, (size_t)n); o->tag[n] = 0;
    t = word(&p, &n); if (!dec32(t, n, &o->size)) return false;
    t = word(&p, &n);
    if (n < 5 || n >= (int)sizeof o->date) return false;
    for (int i = 0; i < n; i++) {
        if (t[i] == '.') { if (i == 0 || i == n - 1 || t[i - 1] == '.') return false; dots++; }
        else if (t[i] < '0' || t[i] > '9') return false;
    }
    if (dots != 2) return false;
    memcpy(o->date, t, (size_t)n); o->date[n] = 0;
    t = word(&p, &n); if (!hex32(t, n, &o->prot)) return false;
    if (!lenfield(&p, &o->path, &o->path_n) || o->path_n < 1 || o->path_n > 255) return false;
    if (!lenfield(&p, &o->comment, &o->comment_n) || o->comment_n > 79) return false;
    return *p == 0;
}
int as_put_json(const as_put_t *p, const char *request, char *json, int cap) {
    int o = snprintf(json, (size_t)cap, "{\"size\":%lu,\"date\":\"%s\",\"protection\":%lu,\"path\":\"",
                     (unsigned long)p->size, p->date, (unsigned long)p->prot);
    if (o < 0 || o >= cap) return -1;
    const int rn = request ? (int)strnlen(request, AR_RID_MAX + 1) : 0;
    if (rn > AR_RID_MAX) return -1;
    if (p->path_n * 6 + p->comment_n * 6 + rn + o + 34 > cap) return -1;   // never cut a name; ",\"request\":\"\"" is 14
    o += as_json_escape(json + o, cap - o, p->path, p->path_n);
    int k = snprintf(json + o, (size_t)(cap - o), "\",\"comment\":\"");
    if (k < 0 || o + k >= cap) return -1;
    o += k;
    o += as_json_escape(json + o, cap - o, p->comment, p->comment_n);
    k = request ? snprintf(json + o, (size_t)(cap - o), "\",\"request\":\"%.*s\"}", rn, request)
                : snprintf(json + o, (size_t)(cap - o), "\"}");
    if (k < 0 || o + k >= cap) return -1;
    return o + k;
}

// Receive's "ERR <id> <code> <text>" or the board's own reason, as the outcome to post.
static void set_failure(amiga_send_t *s, const char *code, const char *text) {
    char c[40], t[300];
    if (as_json_escape(c, sizeof c, code, (int)strnlen(code, 16)) == 0) snprintf(c, sizeof c, "write");
    as_json_escape(t, sizeof t, text, (int)strnlen(text, 120));
    snprintf(s->done_json, sizeof s->done_json, "{\"ok\":false,\"code\":\"%s\",\"text\":\"%s\"}", c, t);
    snprintf(s->done_id, sizeof s->done_id, "%s", s->id);
    s->done_owed = true;
}
static bool is_for_me(const amiga_send_t *s, const char *line, const char *verb) {
    size_t vl = strlen(verb), il = strlen(s->id);
    return strncmp(line, verb, vl) == 0 && strncmp(line + vl, s->id, il) == 0 && (line[vl + il] == ' ' || line[vl + il] == 0);
}
// "ERR <id> <code> <text>": the code and text.
static void take_err(amiga_send_t *s, const char *line) {
    const char *p = line + 4 + strlen(s->id);
    while (*p == ' ') p++;
    char code[17];
    int i = 0;
    while (p[i] && p[i] != ' ' && i < 16) { code[i] = p[i]; i++; }
    code[i] = 0;
    const char *text = p + i;
    while (*text == ' ') text++;
    set_failure(s, i ? code : "write", text);
}

// Starts the queue's NEXT file: "FILE " + everything after "NEXT ".
static void start_file(amiga_send_t *s) {
    const char *nl = memchr(s->queue, '\n', (size_t)s->queue_len);
    int len = nl ? (int)(nl - s->queue) : s->queue_len;
    const char *rest = s->queue + 5;
    int idn = 0;
    while (idn < len - 5 && rest[idn] != ' ' && idn < AS_ID_MAX) { s->id[idn] = rest[idn]; idn++; }
    s->id[idn] = 0;
    unsigned long size = 0;
    if (len - 5 > AS_LINE_MAX || sscanf(rest + idn, " %lu", &size) != 1) {
        // An entry the board cannot read is reported as failed, so the server ends it -- never refetched in a loop.
        if (idn > 0) set_failure(s, "name", "the board could not read this file's entry");
        else http_failed(s, "queue entry", -1);
        return;
    }
    s->size = (uint32_t)size;
    s->off = 0;
    s->chunk_len = 0;
    int n = snprintf(s->out_line, sizeof s->out_line, "FILE %.*s\n", len - 5, rest);
    push(s, (const uint8_t *)s->out_line, n);
    s->phase = AS_FILE_SENT;
    s->t_phase = now(s);
}

static bool in_backoff(const amiga_send_t *s) { return s->backoff_ms && (int32_t)(now(s) - s->t_backoff) < 0; }
static void http_failed(amiga_send_t *s, const char *what, int st) {
    s->backoff_ms = s->backoff_ms ? (s->backoff_ms * 2 > AS_BACKOFF_MAX_MS ? AS_BACKOFF_MAX_MS : s->backoff_ms * 2)
                                  : AS_BACKOFF_MIN_MS;
    s->t_backoff = now(s) + s->backoff_ms;
    wf_logf(WF_WARN, "send: %s failed (%d), next try in %lus", what, st, (unsigned long)(s->backoff_ms / 1000));
}

static bool fetch_owed(const amiga_send_t *s) {
    return !s->fetched_once || s->force_fetch || s->want_version != s->have_version;
}
// A file moving either way: no queue fetch, no long poll.
static bool file_moving(const amiga_send_t *s) { return s->phase >= AS_FILE_SENT && s->phase <= AS_UP_CLOSE; }

void as_init(amiga_send_t *s, const as_ops_t *ops, char *queue_buf, uint8_t *chunk_buf, as_up_t *up) {
    memset(s, 0, sizeof *s);
    s->ops = ops;
    s->rx = '-';
    s->queue = queue_buf;
    s->chunk = chunk_buf;
    s->up = (queue_buf && chunk_buf) ? up : NULL;
    if (s->up) memset(s->up, 0, sizeof *s->up);
}
void as_set_key(amiga_send_t *s, const char *hex) {
    if (!s->up) return;
    bool ok = hex && strlen(hex) == AS_KEY_HEX;
    for (int i = 0; ok && i < AS_KEY_HEX; i++) ok = (hex[i] >= '0' && hex[i] <= '9') || (hex[i] >= 'a' && hex[i] <= 'f');
    if (ok) memcpy(s->up->key, hex, AS_KEY_HEX + 1); else s->up->key[0] = 0;
}
static bool usable(const amiga_send_t *s) { return s->queue && s->chunk; }

void as_set_inputs(amiga_send_t *s, bool net_on, uint32_t amiga_ip, uint32_t queue_version) {
    s->net_on = net_on;
    s->ip = amiga_ip;
    s->want_version = queue_version;
}

bool as_has_work(const amiga_send_t *s) {
    if (!usable(s) || !s->net_on || s->ip == 0 || in_backoff(s)) return false;
    // The handshake too: a 25 s long poll in the middle would time it out.
    // And a ready receiver with a LIST to forward or the next file to offer: otherwise the loop starts a long poll
    // between two files, and each file of a folder waits it out (bench 2026-10-18: ~28 s apiece).
    return s->done_owed || file_moving(s) || s->phase == AS_CONNECTING || s->phase == AS_HELLO
        || (fetch_owed(s) && !file_moving(s))
        || (s->phase == AS_READY && (s->list_owed || s->out_n > 0 || next_present(s) || (s->up && s->up->pending)))
        || (s->req && req_work(s))
        // Final review I1: the reconnect after a protocol 3 drop is due within 5 s. As work, core1 ticks the engine in
        // 20 ms steps meanwhile; otherwise it would wait behind a 25 s long poll.
        || (s->req && s->req->quick && s->phase == AS_IDLE && reconnect_soon(s, now(s)));
}

char as_rx(const amiga_send_t *s) { return s->rx; }
// Network off, or no Amiga address: nothing can be fetched, so the poll's own version is acked -- otherwise the
// server answers every poll at once (final review C1). have_version stays: Network back on fetches as owed.
static bool offline(const amiga_send_t *s) { return !s->net_on || s->ip == 0; }
uint32_t as_acked_version(const amiga_send_t *s) { return offline(s) ? s->want_version : s->have_version; }

// --- Uploads (protocol 2, spec 2026-10-18 §3, §5) -------------------------------------------------------------------
static bool up_moving(const amiga_send_t *s) { return s->phase >= AS_UP_OPEN && s->phase <= AS_UP_CLOSE; }
// Every way an upload ends comes here: DONE, a NO on lines, a drop. Disarm first, so no byte lands meanwhile.
static void up_reset(amiga_send_t *s) {
    as_up_t *u = s->up;
    if (s->ops->raw_arm) s->ops->raw_arm(s->ops->ctx, NULL);
    u->pending = false; u->aborted = false; u->end_seen = false;
    u->tag[0] = 0; u->id[0] = 0;
    u->size = u->start = u->posted = u->crc = u->last_got = 0;
    u->raw.total = 0; u->raw.got = 0; u->raw.limit = 0; u->raw.broken = false;
}
static const char *no_text(const char *code) {
    if (!strcmp(code, "size")) return "file too large (4 MB at most)";
    if (!strcmp(code, "full")) return "the From the Amiga area on the web app is full";
    if (!strcmp(code, "name")) return "the web app refused the name";
    if (!strcmp(code, "offline")) return "the web app cannot be reached";
    if (!strcmp(code, "auth")) return "this board is not paired";
    if (!strcmp(code, "busy")) return "the web app is busy";   // the Amiga's own ABORT says "cancelled" itself
    if (!strcmp(code, "crc")) return "damaged on the way";
    if (!strcmp(code, "gone")) return "deleted on the web app";   // the person deleted it mid-upload
    return "the web app refused it";
}
static bool code_known(const char *c) {
    static const char *const k[] = { "size", "full", "name", "offline", "auth", "busy", "server", "crc", "gone" };
    for (unsigned i = 0; i < sizeof k / sizeof k[0]; i++) if (!strcmp(c, k[i])) return true;
    return false;
}
// The server's upload id goes into a request path: lower-case hex and '-' only.
static bool id_ok(const char *id) {
    size_t n = strlen(id);
    if (n < 1 || n > AS_ID_MAX) return false;
    for (size_t i = 0; i < n; i++) if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f') || id[i] == '-')) return false;
    return true;
}
// "NO <tag> <code> <len>:<text>".
static void up_no(amiga_send_t *s, const char *code, const char *text) {
    as_up_t *u = s->up;
    int n = snprintf(u->line, sizeof u->line, "NO %s %s %u:%s\n", u->tag, code, (unsigned)strlen(text), text);
    push(s, (const uint8_t *)u->line, n);
    wf_logf(WF_INFO, "up: %s NO %s", u->tag, code);
    // A GET's file refused (spec section 3, After GOT; plan ruling F5): toolarge for a file over 4 MB, io otherwise.
    ar_got_t *g = s->req ? ar_got_by_tag(s->req, u->tag) : NULL;
    if (g) ar_got_fail(g, strcmp(code, "size") == 0 ? "toolarge" : "io", text);
}
// Before TAKE, or after the last raw byte: the stream is lines, so the connection stays.
static void up_refuse(amiga_send_t *s, const char *code, const char *text) {
    up_no(s, code, text);
    up_reset(s);
    s->phase = AS_READY;
    s->up_last = true;
    s->t_ping = now(s);
    if (!flush(s)) drop(s, 'u', "send");
}
// Raw bytes may be in flight: the stream's place is lost, so after the NO the connection goes (plan ruling P7).
static void up_fail_drop(amiga_send_t *s, const char *code, const char *text) {
    char why[24];
    up_no(s, code, text);
    (void)flush(s);
    snprintf(why, sizeof why, "upload %s", code);
    drop(s, s->rx, why);
}
static void on_put(amiga_send_t *s) {
    as_put_t p;
    if (!s->up || s->peer_v < 2) return;                    // only a protocol 2 Receive offers files
    if (s->up->pending || up_moving(s)) { drop(s, 'u', "a second PUT"); return; }   // Receive sends one at a time
    if (!as_put_parse(s->line, &p)) { drop(s, 'u', "bad PUT"); return; }
    memcpy(s->up->put, s->line, strlen(s->line) + 1);
    memcpy(s->up->tag, p.tag, sizeof s->up->tag);
    s->up->pending = true;
    s->up->aborted = false;
    s->up->t_open = now(s);
}
static void on_abort(amiga_send_t *s) {
    if (s->up && (s->up->pending || up_moving(s)) && strcmp(s->line + 6, s->up->tag) == 0) s->up->aborted = true;
}
static void on_end(amiga_send_t *s) {
    as_up_t *u = s->up;
    const char *p = s->line + 4, *t;
    int n;
    if (!u || s->phase != AS_UP_DATA) { drop(s, 'u', "stray END"); return; }
    t = word(&p, &n);
    if ((int)strlen(u->tag) != n || strncmp(t, u->tag, (size_t)n) != 0) { drop(s, 'u', "END for another file"); return; }
    t = word(&p, &n);
    if (!hex32(t, n, &u->crc) || __atomic_load_n(&u->raw.got, __ATOMIC_ACQUIRE) != u->raw.total) { drop(s, 'u', "bad END"); return; }
    u->end_seen = true;
    u->t_progress = now(s);   // END is progress too: after a resume's long pre-read it is the first sign of life
}
static bool up_open(amiga_send_t *s, uint32_t t, bool http) {
    as_up_t *u = s->up;
    as_put_t p;
    uint32_t off;
    char id[AS_ID_MAX + 2];   // one past AS_ID_MAX: json_str cuts silently, and a cut id must not pass id_ok
    if (s->out_n > 0) return false;
    if (u->aborted) { up_refuse(s, "busy", "cancelled"); return true; }
    if ((int32_t)(t - u->t_open) > (int32_t)AS_UP_OPEN_GIVEUP_MS) { up_refuse(s, "offline", no_text("offline")); return true; }
    if (!http || in_backoff(s)) return false;
    if (!as_put_parse(u->put, &p)) { drop(s, 'u', "bad PUT"); return true; }
    if (p.size > AS_UP_FILE_MAX) { up_refuse(s, "size", no_text("size")); return true; }
    const ar_got_t *g = s->req ? ar_got_by_tag(s->req, u->tag) : NULL;   // a GET's file: tied to its request
    if (as_put_json(&p, g ? g->rid : NULL, u->json, sizeof u->json) < 0) { up_refuse(s, "name", no_text("name")); return true; }
    int st = s->ops->upload_open(s->ops->ctx, u->json, u->resp, sizeof u->resp);
    if (st == 200 || st == 201) {
        if (!json_str(u->resp, "id", id, sizeof id) || !id_ok(id) ||
            !json_u32_strict(u->resp, "offset", &off) || off > p.size) {
            up_refuse(s, "server", "the web app gave an answer the board cannot read");
            return true;
        }
        memcpy(u->id, id, strlen(id) + 1);
        s->backoff_ms = 0;
        u->size = p.size; u->start = u->posted = off; u->end_seen = false; u->last_got = 0;
        // The limit before the total: until the total is in, as_raw_feed takes nothing (it never reads a stale
        // limit against a new total and calls the credit broken).
        const uint32_t total = p.size - off;
        const uint32_t lim = total < AS_UP_RING_BYTES ? total : AS_UP_RING_BYTES;
        u->raw.ring = s->chunk; u->raw.got = 0; u->raw.broken = false;
        __atomic_store_n(&u->raw.limit, lim, __ATOMIC_RELEASE);
        __atomic_store_n(&u->raw.total, total, __ATOMIC_RELEASE);
        // BEFORE the TAKE: every later byte is file data. A resume at the file's size has no raw section: END is next.
        if (s->ops->raw_arm && u->raw.total) s->ops->raw_arm(s->ops->ctx, &u->raw);
        int n = snprintf(u->line, sizeof u->line, "TAKE %s %lu %lu\n", u->tag, (unsigned long)off, (unsigned long)(off + lim));
        push(s, (const uint8_t *)u->line, n);
        s->phase = AS_UP_DATA;
        u->t_progress = t;
        wf_logf(WF_INFO, "up: %s open %.*s %lu at %lu%s", u->tag, p.path_n < 40 ? p.path_n : 40, p.path,
                (unsigned long)p.size, (unsigned long)off, g ? " for a request" : "");
        if (!flush(s)) drop(s, 'u', "send");
        return true;
    }
    if (st == 401) { up_refuse(s, "auth", no_text("auth")); return true; }
    if (st >= 400 && st < 500 && st != 408 && st != 429) {
        char code[17];
        if (!json_str(u->resp, "code", code, sizeof code) || !code_known(code)) snprintf(code, sizeof code, "server");
        up_refuse(s, code, no_text(code));
        return true;
    }
    http_failed(s, "upload open", st);
    return true;
}
static bool up_data(amiga_send_t *s, uint32_t t, bool http) {
    as_up_t *u = s->up;
    if (u->raw.broken) { drop(s, 'u', "upload past the credit"); return true; }
    const uint32_t got = __atomic_load_n(&u->raw.got, __ATOMIC_ACQUIRE);
    if (got != u->last_got) { u->last_got = got; u->t_progress = t; }
    // Before the first raw byte (or END) of a resume, Receive is still CRCing the part the server has: allow for it.
    const uint32_t stall = (got == 0 && !u->end_seen && u->start > 0) ? AS_UP_PREREAD_MS(u->start) : AS_UP_STALL_MS;
    if ((int32_t)(t - u->t_progress) > (int32_t)stall) {
        // Spec §5, PF8: NO offline either way (the file resumes later); the log says which side stalled.
        if (s->backoff_ms) wf_logf(WF_WARN, "up: %s stalled: the web app keeps failing", u->tag);
        else wf_logf(WF_WARN, "up: %s stalled: the Amiga stopped sending", u->tag);
        up_fail_drop(s, "offline", no_text("offline"));
        return true;
    }
    if (s->out_n > 0) return false;
    const uint32_t done = u->posted - u->start, total = u->raw.total;
    if (done == total) {
        if (u->aborted) { up_refuse(s, "busy", "cancelled"); return true; }   // every byte is in: lines again
        if (u->end_seen) { s->phase = AS_UP_CLOSE; return true; }
        return false;                                                       // waiting for END
    }
    const uint32_t hi = total - done > AS_CHUNK_BYTES ? done + AS_CHUNK_BYTES : total;
    if (got < hi || !http || in_backoff(s)) return false;                   // the chunk is still filling
    // The chunk that completes the raw section waits for END: an ABORT that crossed the TAKE lands in the ring as
    // data (Receive then closes, rx_proto.c on_take), and for a tiny file it can fill the section. Never post it.
    if (hi == total && !u->end_seen) return false;
    int st = s->ops->upload_chunk(s->ops->ctx, u->id, u->posted, s->chunk + (done % AS_UP_RING_BYTES), hi - done,
                                  u->resp, sizeof u->resp);
    if (st == 200) {
        uint32_t rec;
        if (!json_u32_strict(u->resp, "received", &rec) || rec != u->start + hi) {
            up_fail_drop(s, "server", "the web app lost its place in the file");
            return true;
        }
        u->posted = rec; s->backoff_ms = 0; u->t_progress = t;
        const uint32_t lim = total - hi > AS_UP_RING_BYTES ? hi + AS_UP_RING_BYTES : total;
        __atomic_store_n(&u->raw.limit, lim, __ATOMIC_RELEASE);
        // MORE <tag> <credit> <stored> (PF16): the new credit, and what the web app now holds -- Receive's progress.
        int n = snprintf(u->line, sizeof u->line, "MORE %s %lu %lu\n", u->tag, (unsigned long)(u->start + lim),
                         (unsigned long)u->posted);
        push(s, (const uint8_t *)u->line, n);
        if (!flush(s)) drop(s, 'u', "send");
        return true;
    }
    if (st == 401) { up_fail_drop(s, "auth", no_text("auth")); return true; }
    if (st == 404) { up_fail_drop(s, "gone", no_text("gone")); return true; }   // the row went: deleted on the web
    if (st >= 400 && st < 500 && st != 408 && st != 429) { up_fail_drop(s, "server", "the web app refused part of the file"); return true; }
    http_failed(s, "upload chunk", st);
    return true;
}
static bool up_close(amiga_send_t *s, uint32_t t, bool http) {
    as_up_t *u = s->up;
    if (s->out_n > 0) return false;
    if ((int32_t)(t - u->t_progress) > (int32_t)AS_UP_STALL_MS) { up_refuse(s, "offline", no_text("offline")); return true; }
    if (!http || in_backoff(s)) return false;
    snprintf(u->json, sizeof u->json, "{\"crc32\":%lu}", (unsigned long)u->crc);
    int st = s->ops->upload_close(s->ops->ctx, u->id, u->json, u->resp, sizeof u->resp);
    if (st == 200) {
        // The name as stored: UTF-8 from the server, Latin-1 on the wire. u->json and u->resp are scratch now.
        int nlen;
        if (json_str(u->resp, "name", u->json, sizeof u->json) && u->json[0]) nlen = as_utf8_to_latin1(u->json, u->resp, 256);
        else {
            as_put_t p;
            nlen = as_put_parse(u->put, &p) ? p.path_n : 0;
            if (nlen) memcpy(u->resp, p.path, (size_t)nlen);
            u->resp[nlen] = 0;
        }
        int n = snprintf(u->line, sizeof u->line, "DONE %s %d:%s\n", u->tag, nlen, u->resp);
        push(s, (const uint8_t *)u->line, n);
        wf_logf(WF_INFO, "up: %s stored %lu -> %s", u->tag, (unsigned long)u->size, u->resp);
        ar_got_t *g = s->req ? ar_got_by_tag(s->req, u->tag) : NULL;
        if (g) ar_got_remove(g);   // the server settles the GET when the upload closes
        up_reset(s);
        s->phase = AS_READY; s->up_last = true; s->backoff_ms = 0; s->t_ping = t;
        if (!flush(s)) drop(s, 'u', "send");
        return true;
    }
    if (st == 401) { up_refuse(s, "auth", no_text("auth")); return true; }
    if (st >= 400 && st < 500 && st != 408 && st != 429) {
        char code[17];
        if (!json_str(u->resp, "code", code, sizeof code) || (strcmp(code, "crc") != 0 && strcmp(code, "gone") != 0))
            snprintf(code, sizeof code, "server");
        up_refuse(s, code, no_text(code));
        return true;
    }
    http_failed(s, "upload close", st);
    return true;
}

// --- NET: volumes (spec 2026-10-30 section 3, fw 1.22.0) --------------------------------------------------------------
static bool up_busy(const amiga_send_t *s) { return s->up && (s->up->pending || up_moving(s)); }
// Final review I2 (amends plan ruling F9): while the held lines are only GETs -- a copy -- the board fetches once
// more before it relays each GET, so a listing from another pane goes next (ar_take prefers it) instead of after
// every file. Once per GET start: `refetched` is set by any fetch and cleared when a request is taken.
static bool req_refetch_owed(const amiga_send_t *s) {
    const as_req_t *r = s->req;
    return !r->refetched && !r->active && s->phase == AS_READY && !up_busy(s) && ar_only_gets(r) &&
           AR_FETCH_BYTES - r->fetched_len >= AR_REFETCH_ROOM;
}
static bool req_fetch_owed(const amiga_send_t *s) {
    const as_req_t *r = s->req;
    if (file_moving(s)) return false;
    return ar_pending(r) ? req_refetch_owed(s) : r->want_v != r->have_v;
}
// A reconnect is due within 5 s: a request waits for it rather than being answered norx (plan ruling F8).
static bool reconnect_soon(const amiga_send_t *s, uint32_t t) {
    return (int32_t)(s->t_retry - t) <= (int32_t)AS_RETRY_WAITING_MS;
}
static bool req_work(const amiga_send_t *s) {
    const as_req_t *r = s->req;
    return r->post_owed || ar_got_owed(r) != NULL || r->active || req_fetch_owed(s) ||
           (ar_pending(r) && (s->phase == AS_IDLE || s->phase == AS_READY));
}
static void req_log_take(int bad) { if (bad) wf_logf(WF_WARN, "req: %d malformed request lines skipped", bad); }

// At most one HTTPS request: an answer piece, then a late ERR, then the fetch.
static bool req_http(amiga_send_t *s, uint32_t t) {
    as_req_t *r = s->req;
    if (in_backoff(s)) return false;
    if (r->post_owed) {
        int st = s->ops->post_req(s->ops->ctx, r->rid, r->body, r->body_len);
        if (st >= 200 && st < 300) {
            s->backoff_ms = 0;
            if (r->post_last) wf_logf(WF_INFO, "req: %.8s answered, %lu lines in %lu pieces", r->rid,
                                      (unsigned long)r->lines_total, (unsigned long)r->piece + 1);
            ar_body_posted(r);
            r->t_last = t;
        } else if (st >= 400 && st < 500 && st != 401 && st != 408 && st != 429) {
            // Refused for good (a 4xx but 401/408/429: the request is gone, replaced by a Refresh, or failed): nothing more is posted for it,
            // and the rest of its answer is read and dropped (plan ruling F6).
            wf_logf(WF_WARN, "req: %.8s piece %lu refused (%d)", r->rid, (unsigned long)r->piece, st);
            ar_got_t *g = ar_got_by_rid(r, r->rid);
            if (g) ar_got_remove(g);
            if (r->post_last) ar_finish(r);
            else { r->post_owed = false; r->discard = true; r->t_last = t; }
            s->backoff_ms = 0;
        } else {
            http_failed(s, "answer", st);
        }
        return true;
    }
    ar_got_t *g = ar_got_owed(r);
    if (g) {
        int n = ar_late_body(r, g);
        int st = s->ops->post_req(s->ops->ctx, g->rid, r->late, n);
        if ((st >= 200 && st < 300) || (st >= 400 && st < 500 && st != 401 && st != 408 && st != 429)) {
            s->backoff_ms = 0;
            wf_logf(WF_INFO, "req: %.8s failed after GOT (%d)", g->rid, st);
            ar_got_remove(g);
        } else {
            http_failed(s, "late answer", st);
        }
        return true;
    }
    if (req_fetch_owed(s)) {
        const uint32_t v = r->want_v;   // the v the poll said, BEFORE the fetch (spec section 3): that is the ack
        const int room = ar_fetch_room(r);   // the new lines go after the held ones
        int n = s->ops->fetch_req(s->ops->ctx, r->fetched + r->fetched_len, room);
        if (n < 0) { http_failed(s, "requests", n); return true; }
        s->backoff_ms = 0;
        ar_fetched(r, n);
        r->have_v = v;
        r->refetched = true;
        return true;
    }
    return false;
}

// Requests the board answers itself (spec section 3): Transfer not connected, and no reconnect due within 5 s.
static bool req_board(amiga_send_t *s, uint32_t t) {
    as_req_t *r = s->req;
    int bad = 0;
    if (r->active || !ar_pending(r) || s->phase != AS_IDLE || reconnect_soon(s, t)) return false;
    const bool took = ar_take(r, &bad);
    req_log_take(bad);
    if (!took) return bad > 0;
    r->refetched = false;
    wf_logf(WF_INFO, "req: %.8s norx", r->rid);
    ar_end_err(r, "norx", AS_TXT_NORX);
    return true;
}

// In READY, when the arbitration gives requests the turn: the next request goes to Transfer (or, to a Transfer older
// than 2.3, is answered "old" by the board).
static bool req_start(amiga_send_t *s, uint32_t t) {
    as_req_t *r = s->req;
    int bad = 0;
    if (r->active || s->out_n > 0 || up_busy(s)) return false;   // a waiting PUT goes first (plan ruling F3)
    if (req_refetch_owed(s) && !in_backoff(s)) return false;      // the next GET waits for one fetch (final review I2)
    const bool took = ar_take(r, &bad);
    req_log_take(bad);
    if (!took) return false;
    r->refetched = false;
    if (s->peer_v < 3) {
        wf_logf(WF_INFO, "req: %.8s old (Transfer protocol %u)", r->rid, (unsigned)s->peer_v);
        ar_end_err(r, "old", AS_TXT_OLD);
        return true;
    }
    push(s, (const uint8_t *)r->out, r->out_n);
    r->sent = true;
    r->t_last = t;
    wf_logf(WF_INFO, "req: %.*s", r->out_n - 1 > 80 ? 80 : r->out_n - 1, r->out);
    if (!flush(s)) drop(s, 'u', "send");
    return true;
}

// Before reading the next line: false while the piece being gathered cannot take one more. It is closed and waits for
// its POST, and Transfer's lines wait in the socket meanwhile: its own buffer paces the drawer scan (spec section 2.2).
static bool req_room(amiga_send_t *s) {
    as_req_t *r = s->req;
    if (!r || !r->active || !r->sent || r->ended || r->discard) return true;
    if (r->post_owed) return false;
    if (ar_body_full(r)) { ar_body_close(r, false); return false; }
    return true;
}

// A line of Transfer's: true when it belonged to a request (consumed).
static bool req_line(amiga_send_t *s, uint32_t t) {
    as_req_t *r = s->req;
    char verb[5], rid[AR_RID_MAX + 1];
    if (!ar_line_verb(s->line, verb, rid)) return false;
    if (r->active && r->sent && !r->ended && strcmp(rid, r->rid) == 0) {
        const bool got = !strcmp(verb, "GOT");
        const bool end = got || !strcmp(verb, "DONE") || !strcmp(verb, "ERR");
        r->t_last = t;
        if (r->discard) { if (end) ar_finish(r); return true; }
        if (got && r->kind == AR_GET) {
            // "GOT <rid> <tag>": the file comes up later as the upload with this tag (spec section 3, GET).
            const char *sp = s->line + 4 + strlen(rid);
            if (*sp == ' ') {                // a rid that ends the line has no tag: never read past the NUL
                const char *tag = sp + 1;
                const size_t tn = strlen(tag);
                bool ok = tn >= 1 && tn <= AR_TAG_MAX;
                for (size_t i = 0; ok && i < tn; i++) ok = tag[i] >= '0' && tag[i] <= '9';
                if (ok) ar_got_add(r, rid, tag);
            }
        }
        (void)ar_body_add(r, s->line);       // req_room made room for any line before it was read
        if (end) ar_body_close(r, true);
        return true;
    }
    if (!strcmp(verb, "ERR")) {
        // After GOT (spec section 3): Transfer's late ERR for a GET already answered, routed by its rid.
        ar_got_t *g = ar_got_by_rid(r, rid);
        if (g) { ar_got_late(g, s->line); wf_logf(WF_INFO, "req: %.8s failed after GOT", rid); return true; }
    }
    return false;   // a download's ERR, or a line for an answer already ended: the usual handling
}

// Transfer silent mid-answer (spec section 3): ERR timeout, and the connection goes (plan ruling F4). The clock
// stands still while an upload is pending or moving (Transfer answers after it, ruling F3) and while a piece waits.
static bool req_silent(amiga_send_t *s, uint32_t t) {
    as_req_t *r = s->req;
    if (!r || !r->active || !r->sent || r->ended) return false;
    if (up_busy(s) || r->post_owed) { r->t_last = t; return false; }
    if ((int32_t)(t - r->t_last) <= (int32_t)AS_REQ_SILENT_MS) return false;
    wf_logf(WF_WARN, "req: %.8s timeout", r->rid);
    ar_end_err(r, "timeout", AS_TXT_SILENT);
    drop(s, 'u', "request timeout");
    return true;
}

// The connection went: the answer in progress ends "lost", and every GET answered GOT whose file has not finished
// fails the same way -- Transfer drops a GET's file with the connection (its ruling T4; plan ruling F5).
static void req_on_drop(amiga_send_t *s) {
    as_req_t *r = s->req;
    if (r->active && r->sent) ar_end_err(r, "norx", AS_TXT_LOST);
    for (int i = 0; i < AR_MAX; i++) if (r->got[i].used) ar_got_fail(&r->got[i], "norx", AS_TXT_LOST);
    r->browse = false;
    r->ping_held = false;
}

void as_set_req(amiga_send_t *s, as_req_t *r) { s->req = s->up ? r : NULL; if (s->req) ar_init(s->req); }
void as_set_req_version(amiga_send_t *s, uint32_t v) { if (s->req) s->req->want_v = v; }
bool as_req_capable(const amiga_send_t *s) { return s->req != NULL; }
uint32_t as_req_acked(const amiga_send_t *s) { return s->req ? (offline(s) ? s->req->want_v : s->req->have_v) : 0; }
int as_rx_proto(const amiga_send_t *s) { return s->phase >= AS_READY ? s->peer_v : 0; }
bool as_browse(const amiga_send_t *s) { return s->req && as_rx_proto(s) == 3 && s->req->browse; }

// The shared engine: as_tick runs it without HTTPS, as_step with at most one request.
static bool run(amiga_send_t *s, bool http) {
    if (!usable(s)) return false;
    if (!s->net_on || s->ip == 0) {
        if (s->phase != AS_IDLE) drop(s, '-', "Network off");
        s->rx = '-';
        return false;
    }
    bool moved = false;
    uint32_t t = now(s);

    // A PUT not yet answered with TAKE: its AS_UP_OPEN_GIVEUP_MS give-up (spec §8) runs from the PUT, paused only while a download
    // moves, and is checked here, before a failing outcome post can end the pass -- so nothing holds it longer.
    if (s->up && (s->up->pending || s->phase == AS_UP_OPEN)) {
        if (s->phase >= AS_FILE_SENT && s->phase <= AS_AWAIT_OK) s->up->t_open = t;
        else if ((s->phase == AS_READY || s->phase == AS_UP_OPEN) && s->out_n == 0 &&
                 (int32_t)(t - s->up->t_open) > (int32_t)AS_UP_OPEN_GIVEUP_MS) {
            up_refuse(s, "offline", no_text("offline"));
            return true;
        }
    }

    // The outcome first: nothing else happens until the server has it.
    if (s->done_owed) {
        if (!http) return false;
        if (in_backoff(s)) return false;
        int st = s->ops->post_done(s->ops->ctx, s->done_id, s->done_json);
        if ((st >= 200 && st < 300) || st == 409) {
            s->done_owed = false;
            s->force_fetch = true;
            s->backoff_ms = 0;
            if (strncmp(s->done_json, "{\"ok\":true", 10) == 0) wf_logf(WF_INFO, "send: %.8s delivered", s->done_id);
            else wf_logf(WF_INFO, "send: %.8s ERR %s", s->done_id, s->done_json);
        } else if (st >= 400 && st < 500 && st != 401 && st != 429) {
            // The server refused the outcome itself: posting it again would be refused again. Let it go; the row
            // stays as the server has it (and expires), the queue is refetched.
            wf_logf(WF_WARN, "send: %.8s outcome refused (%d), dropped", s->done_id, st);
            s->done_owed = false;
            s->force_fetch = true;
            s->backoff_ms = 0;
        } else {
            http_failed(s, "outcome", st);
        }
        return true;
    }
    // NET: volumes: an answer piece, a late ERR or the fetch -- before the send queue (someone waits in a browser).
    if (http && s->req && req_http(s, t)) return true;
    if (http && fetch_owed(s) && !file_moving(s) && !in_backoff(s)) {
        int n = s->ops->fetch_queue(s->ops->ctx, s->queue, AS_QUEUE_BYTES);
        if (n < 0) { http_failed(s, "queue", n); return true; }
        s->backoff_ms = 0;
        s->queue_len = n;
        s->queue[n] = 0;
        s->have_version = s->want_version;
        s->fetched_once = true;
        s->force_fetch = false;
        if (s->phase == AS_READY) s->list_owed = true;
        return true;
    }

    if (s->req && req_board(s, t)) return true;

    int sock = s->ops->sock_state(s->ops->ctx);
    switch (s->phase) {
    case AS_IDLE:
        if (!s->fetched_once) return false;   // know the queue first: it sets the retry cadence
        if ((int32_t)(t - s->t_retry) < 0) return false;
        if (s->req) s->req->quick = false;   // the quick reconnect is made (final review I1)
        if (s->ops->connect(s->ops->ctx, s->ip, AS_PORT) < 0) { s->rx = 'u'; s->t_retry = t + retry_ms(s); return false; }
        s->phase = AS_CONNECTING;
        s->t_phase = t;
        return true;
    case AS_CONNECTING:
        if (sock == AS_SOCK_OPEN) {
            if (s->up && s->up->key[0]) {   // protocol 2 (fw 1.19.0): uploads; protocol 3 (fw 1.22.0): requests too
                s->hello_v = s->req ? 3 : 2;
                int n = snprintf(s->up->line, sizeof s->up->line, "WEBADF %u %s\n", (unsigned)s->hello_v, s->up->key);
                push(s, (const uint8_t *)s->up->line, n);
            } else {
                push(s, (const uint8_t *)"WEBADF 1\n", 9);
                s->hello_v = 1;
            }
            if (!flush(s)) { drop(s, 'u', "send"); return true; }
            s->phase = AS_HELLO;
            s->t_phase = t;
            return true;
        }
        if (sock == AS_SOCK_REFUSED) { drop(s, 'r', "refused"); return true; }
        if (sock == AS_SOCK_CLOSED || t - s->t_phase > AS_CONNECT_MS) { drop(s, 'u', "connect"); return true; }
        return false;
    default:
        break;
    }

    // Connected phases: push what is pending, then read Receive's lines.
    if (!flush(s)) { drop(s, 'u', "send"); return true; }
    for (;;) {
        if (s->req && !req_room(s)) break;   // a full piece waits for its POST: the lines wait in the socket
        int r = s->ops->recv_line(s->ops->ctx, s->line, sizeof s->line);
        if (r < 0) { drop(s, 'u', "closed"); return true; }
        if (r == 0) break;
        moved = true;
        if (strcmp(s->line, "PONG") == 0) { s->ping_out = false; continue; }
        if (s->req && req_line(s, t)) continue;
        // Protocol 2 lines from Receive 2, in any phase (spec 2026-10-18 §3).
        if (strncmp(s->line, "PUT ", 4) == 0) { on_put(s); if (s->phase == AS_IDLE) return true; continue; }
        if (strncmp(s->line, "ABORT ", 6) == 0) { on_abort(s); continue; }
        if (strncmp(s->line, "END ", 4) == 0) { on_end(s); if (s->phase == AS_IDLE) return true; continue; }
        switch (s->phase) {
        case AS_HELLO:
            if (strncmp(s->line, "READY ", 6) == 0) {
                // Receive 1 says READY 1 to anything; READY 2 counts only as the answer to a protocol 2 or 3 hello
                // (Transfer 2.2 answers a protocol 3 hello READY 2), READY 3 <0|1> only as the answer to protocol 3.
                const char *v = s->line + 6;
                if (s->hello_v == 3 && v[0] == '3' && v[1] == ' ' && (v[2] == '0' || v[2] == '1') && v[3] == 0) {
                    s->peer_v = 3;
                    s->req->browse = v[2] == '1';
                } else {
                    s->peer_v = (s->hello_v >= 2 && v[0] == '2' && v[1] == 0) ? 2 : 1;
                }
                s->phase = AS_READY;
                s->rx = 'c';
                s->list_owed = true;
                s->t_ping = t;
                wf_logf(WF_INFO, "send: receiver connected %lu.%lu.%lu.%lu protocol %u%s", (unsigned long)(s->ip >> 24),
                        (unsigned long)((s->ip >> 16) & 255), (unsigned long)((s->ip >> 8) & 255), (unsigned long)(s->ip & 255),
                        (unsigned)s->peer_v, s->peer_v == 3 ? (s->req->browse ? ", browsing on" : ", browsing off") : "");
            }
            break;
        case AS_FILE_SENT:
            if (is_for_me(s, s->line, "GO ")) {
                s->phase = s->size ? AS_DATA : AS_AWAIT_OK;
                s->t_phase = t;
            } else if (is_for_me(s, s->line, "ERR ")) {
                take_err(s, s->line);
                s->phase = AS_READY;
            }
            break;
        case AS_AWAIT_OK:
            if (is_for_me(s, s->line, "OK ")) {
                const char *colon = strchr(s->line + 3 + strlen(s->id), ':');
                const char *path = colon ? colon + 1 : "";
                char esc[400];
                if (as_json_escape(esc, sizeof esc, path, (int)strlen(path)) < 0) esc[0] = 0;
                snprintf(s->done_json, sizeof s->done_json, "{\"ok\":true,\"savedAs\":\"%s\"}", esc);
                snprintf(s->done_id, sizeof s->done_id, "%s", s->id);
                s->done_owed = true;
                s->phase = AS_READY;
                wf_logf(WF_INFO, "send: %.8s sent %lu -> OK %s", s->id, (unsigned long)s->size, path);
            } else if (is_for_me(s, s->line, "ERR ")) {
                take_err(s, s->line);
                s->phase = AS_READY;
            }
            break;
        default:
            break;
        }
    }

    if (req_silent(s, t)) return true;
    switch (s->phase) {
    case AS_HELLO:
        if (t - s->t_phase > AS_HELLO_MS) { drop(s, 'u', "no READY"); return true; }
        break;
    case AS_READY:
        if (s->out_n > 0) break;
        if (s->list_owed) {
            int n;
            const char *lb = list_block(s, &n);
            push(s, (const uint8_t *)lb, n);
            s->list_owed = false;
            if (!flush(s)) { drop(s, 'u', "send"); return true; }
            return true;
        }
        if (s->up && s->up->pending && s->up->aborted) { up_refuse(s, "busy", "cancelled"); return true; }
        {
            // Spec §3 arbitration: a waiting PUT goes before the next download -- except right after an upload, when
            // a waiting download (or one the queue may hold: an outcome or a fetch is owed) goes first. Turns.
            // An active request is no download's rival for the PUT's turn: it cannot start one, and Transfer answers nothing while
            // its PUT waits for TAKE (ruling F3) -- so the PUT must not be held back by a download behind it.
            const bool down = !s->done_owed && !fetch_owed(s) && next_present(s) && !(s->req && s->req->active);
            // During a backoff nothing is sure to come: the PUT goes rather than wait the backoff out.
            const bool unsure = (s->done_owed || fetch_owed(s)) && !in_backoff(s);
            if (s->up && s->up->pending && !(s->up_last && (down || unsure))) {
                // A PONG still owed would cross the TAKE and land in the raw section as file data: the turn waits for
                // it (it is read as a line meanwhile). No PONG within AS_PONG_MS drops the connection, as ever.
                if (s->ping_out) {
                    if (t - s->t_ping > AS_PONG_MS) { drop(s, 'u', "no PONG"); return true; }
                    break;
                }
                s->up->pending = false;
                s->phase = AS_UP_OPEN;
                s->t_phase = t;
                s->t_ping = t;   // no PING in an upload (spec §3); the next is due AS_PING_MS after it ends
                return true;
            }
            // NET: volumes: a request goes before a download -- someone waits in a browser (spec section 3) -- but
            // never before a waiting PUT (req_start checks it, ruling F3); and a download waits for an answer.
            if (s->req && req_start(s, t)) return true;
            if (down && !(s->req && s->req->active)) { s->up_last = false; start_file(s); if (!flush(s)) drop(s, 'u', "send"); return true; }
        }
        // Lines held for an owed piece hold the PONG too (req_room). Transfer drops a connection silent for 75 s
        // (RX_IDLE_SECS), so the PINGs go on every AS_PING_MS, one outstanding or not, and only the PONG deadline is
        // suspended; it restarts when the hold ends (final review M2). The PONGs queue in Transfer's socket.
        if (s->req && s->req->active && s->req->sent && !s->req->ended && !s->req->discard && s->req->post_owed) {
            s->req->ping_held = true;
            if (t - s->t_ping > AS_PING_MS) {
                push(s, (const uint8_t *)"PING\n", 5);
                if (!flush(s)) { drop(s, 'u', "send"); return true; }
                s->ping_out = true;
                s->t_ping = t;
                return true;
            }
            break;
        }
        if (s->req && s->req->ping_held) { s->req->ping_held = false; s->t_ping = t; }   // the deadline restarts
        if (s->ping_out && t - s->t_ping > AS_PONG_MS) { drop(s, 'u', "no PONG"); return true; }
        if (!s->ping_out && t - s->t_ping > AS_PING_MS) {
            push(s, (const uint8_t *)"PING\n", 5);
            if (!flush(s)) { drop(s, 'u', "send"); return true; }
            s->ping_out = true;
            s->t_ping = t;
            return true;
        }
        break;
    case AS_FILE_SENT:
        if (t - s->t_phase > AS_GO_MS) { drop(s, 'u', "no GO"); return true; }
        break;
    case AS_DATA:
        if (s->out_n > 0) break;                     // the chunk is still going out
        if (s->off >= s->size) { s->phase = AS_AWAIT_OK; s->t_phase = t; return true; }
        if (!http) break;
        {
            uint32_t len = s->size - s->off < AS_CHUNK_BYTES ? s->size - s->off : AS_CHUNK_BYTES;
            int n = s->ops->fetch_chunk(s->ops->ctx, s->id, s->off, len, s->chunk);
            if (n != (int)len) {
                char why[24];
                snprintf(why, sizeof why, "chunk %d", n);
                drop(s, s->rx, why);
                return true;
            }
            s->chunk_len = (uint32_t)n;
            s->off += (uint32_t)n;
            push(s, s->chunk, n);
            if (!flush(s)) { drop(s, 'u', "send"); return true; }
            return true;
        }
    case AS_AWAIT_OK:
        if (t - s->t_phase > 60000u + s->size / 4) { drop(s, 'u', "no OK"); return true; }
        break;
    case AS_UP_OPEN: return up_open(s, t, http) || moved;
    case AS_UP_DATA: return up_data(s, t, http) || moved;
    case AS_UP_CLOSE: return up_close(s, t, http) || moved;
    default:
        break;
    }
    return moved;
}

void as_tick(amiga_send_t *s) { (void)run(s, false); }
bool as_step(amiga_send_t *s) { return run(s, true); }
