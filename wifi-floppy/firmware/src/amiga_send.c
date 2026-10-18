// PaulaNET Phase 4: the board's side of sending files to Receive on the Amiga. See amiga_send.h.
#include "amiga_send.h"
#include "wf_log.h"
#include <stdio.h>
#include <string.h>

static uint32_t now(const amiga_send_t *s) { return s->ops->now_ms(s->ops->ctx); }
static void http_failed(amiga_send_t *s, const char *what, int st);

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
    if (s->phase >= AS_FILE_SENT && s->phase <= AS_AWAIT_OK) wf_logf(WF_WARN, "send: %.8s aborted (%s)", s->id, why);
    s->ops->close(s->ops->ctx);
    s->phase = AS_IDLE;
    s->rx = rx;
    s->out_n = 0;
    s->ping_out = false;
    s->list_owed = false;
    s->t_retry = now(s) + retry_ms(s);
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
static bool file_moving(const amiga_send_t *s) { return s->phase >= AS_FILE_SENT && s->phase <= AS_AWAIT_OK; }

void as_init(amiga_send_t *s, const as_ops_t *ops, char *queue_buf, uint8_t *chunk_buf) {
    memset(s, 0, sizeof *s);
    s->ops = ops;
    s->rx = '-';
    s->queue = queue_buf;
    s->chunk = chunk_buf;
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
        || (s->phase == AS_READY && (s->list_owed || s->out_n > 0 || next_present(s)));
}

char as_rx(const amiga_send_t *s) { return s->rx; }
uint32_t as_acked_version(const amiga_send_t *s) { return s->have_version; }

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

    int sock = s->ops->sock_state(s->ops->ctx);
    switch (s->phase) {
    case AS_IDLE:
        if (!s->fetched_once) return false;   // know the queue first: it sets the retry cadence
        if ((int32_t)(t - s->t_retry) < 0) return false;
        if (s->ops->connect(s->ops->ctx, s->ip, AS_PORT) < 0) { s->rx = 'u'; s->t_retry = t + retry_ms(s); return false; }
        s->phase = AS_CONNECTING;
        s->t_phase = t;
        return true;
    case AS_CONNECTING:
        if (sock == AS_SOCK_OPEN) {
            push(s, (const uint8_t *)"WEBADF 1\n", 9);
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
        int r = s->ops->recv_line(s->ops->ctx, s->line, sizeof s->line);
        if (r < 0) { drop(s, 'u', "closed"); return true; }
        if (r == 0) break;
        moved = true;
        if (strcmp(s->line, "PONG") == 0) { s->ping_out = false; continue; }
        switch (s->phase) {
        case AS_HELLO:
            if (strncmp(s->line, "READY ", 6) == 0) {
                s->phase = AS_READY;
                s->rx = 'c';
                s->list_owed = true;
                s->t_ping = t;
                wf_logf(WF_INFO, "send: receiver connected %lu.%lu.%lu.%lu", (unsigned long)(s->ip >> 24),
                        (unsigned long)((s->ip >> 16) & 255), (unsigned long)((s->ip >> 8) & 255), (unsigned long)(s->ip & 255));
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
        if (!s->done_owed && !fetch_owed(s) && next_present(s)) { start_file(s); if (!flush(s)) drop(s, 'u', "send"); return true; }
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
    default:
        break;
    }
    return moved;
}

void as_tick(amiga_send_t *s) { (void)run(s, false); }
bool as_step(amiga_send_t *s) { return run(s, true); }
