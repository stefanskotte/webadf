#include <string.h>
#include "rx_crc.h"
#include "rx_names.h"
#include "rx_proto.h"

#define PROGRESS_STEP 16384UL

static void emit(rx_session *s, int kind, const char *id, const char *path, unsigned long size,
                 unsigned long bytes, const char *text) {
    rx_event e;
    if (!s->on_event) return;
    e.kind = kind; e.id = id; e.path = path; e.size = size; e.bytes = bytes; e.text = text;
    s->on_event(s->uctx, &e);
}

static void put(rx_session *s, const char *p, unsigned n) {
    if (s->out_n + n > RX_OUT_MAX) return; /* replies are short; a full buffer means the peer stopped reading */
    memcpy(s->out + s->out_n, p, n);
    s->out_n += n;
}
static void puts_(rx_session *s, const char *p) { put(s, p, (unsigned)strlen(p)); }

static void reply_err(rx_session *s, const char *id, const char *code, const char *text) {
    puts_(s, "ERR "); puts_(s, id[0] ? id : "-"); puts_(s, " "); puts_(s, code); puts_(s, " ");
    puts_(s, text); puts_(s, "\n");
}

void rx_init(rx_session *s, const rx_fs *fs, rx_event_fn on_event, void *uctx) {
    memset(s, 0, sizeof *s);
    s->fs = fs; s->on_event = on_event; s->uctx = uctx;
}

int rx_busy(const rx_session *s) { return s->in_data; }

unsigned rx_take_output(rx_session *s, char *dst, unsigned cap) {
    unsigned n = s->out_n < cap ? s->out_n : cap;
    memcpy(dst, s->out, n);
    memmove(s->out, s->out + n, s->out_n - n);
    s->out_n -= n;
    return n;
}

/* --- line parsing --- */
typedef struct { const char *p, *end; } cur;

static int tok(cur *c, const char **t, unsigned *n) {
    if (c->p >= c->end) return 0;
    *t = c->p;
    while (c->p < c->end && *c->p != ' ') c->p++;
    *n = (unsigned)(c->p - *t);
    if (c->p < c->end) c->p++;
    return *n > 0;
}
static int num(const char *t, unsigned n, int base, unsigned long *v) {
    unsigned long x = 0;
    unsigned i;
    if (n == 0 || n > (base == 16 ? 8u : 10u)) return 0;
    for (i = 0; i < n; i++) {
        int d;
        char ch = t[i];
        if (ch >= '0' && ch <= '9') d = ch - '0';
        else if (base == 16 && ch >= 'a' && ch <= 'f') d = ch - 'a' + 10;
        else if (base == 16 && ch >= 'A' && ch <= 'F') d = ch - 'A' + 10;
        else return 0;
        x = x * (unsigned long)base + (unsigned long)d;
    }
    *v = x & 0xFFFFFFFFUL;
    return 1;
}
/* "<len>:<bytes>" into dst (cap includes the NUL); cut to cap-1 when cut != 0, else refused when longer. */
static int lenstr(cur *c, char *dst, unsigned cap, int cut) {
    unsigned long len = 0;
    const char *q = c->p;
    while (q < c->end && *q >= '0' && *q <= '9') q++;
    if (q == c->p || q >= c->end || *q != ':' || !num(c->p, (unsigned)(q - c->p), 10, &len)) return 0;
    q++;
    if ((unsigned long)(c->end - q) < len) return 0;
    if (memchr(q, 0, len)) return 0;
    if (len > cap - 1) { if (!cut) return 0; memcpy(dst, q, cap - 1); dst[cap - 1] = 0; }
    else { memcpy(dst, q, len); dst[len] = 0; }
    c->p = q + len;
    if (c->p < c->end) { if (*c->p != ' ') return 0; c->p++; }
    return 1;
}
static int id_ok(const char *t, unsigned n) {
    unsigned i;
    if (n < 1 || n > RX_ID_MAX) return 0;
    for (i = 0; i < n; i++) {
        char ch = t[i];
        if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_'))
            return 0;
    }
    return 1;
}
static int is(const char *t, unsigned n, const char *word) { return n == strlen(word) && memcmp(t, word, n) == 0; }

/* --- files --- */
static void parent_of(const char *path, char *dst) {
    const char *last = strrchr(path, '/');
    size_t n = last ? (size_t)(last - path + 1) : 0;
    memcpy(dst, path, n);
    dst[n] = 0;
}
static int make_parents(rx_session *s, const char *path) {
    char buf[RX_PATH_MAX + 1];
    const char *q;
    for (q = strchr(path, '/'); q; q = strchr(q + 1, '/')) {
        size_t n = (size_t)(q - path);
        memcpy(buf, path, n); buf[n] = 0;
        if (!s->fs->exists(s->fs->ctx, buf) && s->fs->make_dir(s->fs->ctx, buf) != 0) return -1;
    }
    return 0;
}
static void fail_file(rx_session *s, const char *code, const char *text) {
    if (s->cur_open) { s->fs->close_w(s->fs->ctx); s->cur_open = 0; }
    s->fs->remove(s->fs->ctx, s->cur_tmp);
    reply_err(s, s->cur_id, code, text);
    s->in_data = 0;
    emit(s, RX_EV_FAILED, s->cur_id, s->cur_path, s->cur_size, 0, text);
}
static void finish_file(rx_session *s) {
    char saved[RX_PATH_MAX + 1], digits[12];
    unsigned n;
    int closed = s->fs->close_w(s->fs->ctx);
    s->cur_open = 0;
    if (s->cur_write_failed || closed != 0) { fail_file(s, "write", "cannot write"); return; }
    if (s->cur_crc != s->cur_crc_want) { fail_file(s, "crc", "checksum mismatch"); return; }
    for (n = 1; n <= 99; n++) {
        if (rx_candidate(s->cur_path, n, saved) != 0) { n = 100; break; }
        if (!s->fs->exists(s->fs->ctx, saved)) break;
    }
    if (n > 99) { fail_file(s, "name", "no free name"); return; }
    if (s->fs->rename(s->fs->ctx, s->cur_tmp, saved) != 0) { fail_file(s, "write", "cannot write"); return; }
    s->fs->set_meta(s->fs->ctx, saved, s->cur_prot, s->cur_comment);
    puts_(s, "OK "); puts_(s, s->cur_id); puts_(s, " ");
    rx_utoa((unsigned long)strlen(saved), digits); puts_(s, digits); puts_(s, ":"); puts_(s, saved); puts_(s, "\n");
    s->in_data = 0;
    emit(s, RX_EV_DONE, s->cur_id, saved, s->cur_size, s->cur_size, 0);
}

static void on_file(rx_session *s, cur *c) {
    const char *t; unsigned n;
    unsigned long size, crc, prot;
    char id[RX_ID_MAX + 1];
    id[0] = 0;
    if (!tok(c, &t, &n) || !id_ok(t, n)) { reply_err(s, "", "name", "bad request"); return; }
    memcpy(id, t, n); id[n] = 0;
    if (!tok(c, &t, &n) || !num(t, n, 10, &size)) { reply_err(s, id, "name", "bad request"); return; }
    if (size > RX_FILE_MAX) { reply_err(s, id, "size", "file too large"); return; }
    if (!tok(c, &t, &n) || !num(t, n, 16, &crc)) { reply_err(s, id, "name", "bad request"); return; }
    if (!tok(c, &t, &n) || !num(t, n, 16, &prot)) { reply_err(s, id, "name", "bad request"); return; }
    if (!lenstr(c, s->cur_path, sizeof s->cur_path, 0) || !lenstr(c, s->cur_comment, sizeof s->cur_comment, 1)) {
        reply_err(s, id, "name", "bad request"); return;
    }
    if (!rx_path_ok(s->cur_path)) { reply_err(s, id, "name", "bad name"); return; }
    if (!s->fs->folder_ok(s->fs->ctx)) { reply_err(s, id, "folder", "folder not found"); return; }
    {
        unsigned long fr = s->fs->free_bytes(s->fs->ctx);
        if (fr < 8192UL || fr - 8192UL < size) { reply_err(s, id, "space", "not enough space"); return; }
    }
    if (make_parents(s, s->cur_path) != 0) { reply_err(s, id, "write", "cannot create folder"); return; }
    parent_of(s->cur_path, s->cur_tmp);
    strcat(s->cur_tmp, RX_TMP_NAME);
    if (s->fs->open_w(s->fs->ctx, s->cur_tmp) != 0) { reply_err(s, id, "write", "cannot write"); return; }
    strcpy(s->cur_id, id);
    s->cur_size = s->cur_left = size; s->cur_crc_want = crc; s->cur_crc = 0; s->cur_prot = prot;
    s->cur_mark = 0; s->cur_open = 1; s->cur_write_failed = 0; s->in_data = 1;
    puts_(s, "GO "); puts_(s, id); puts_(s, "\n");
    emit(s, RX_EV_BEGIN, s->cur_id, s->cur_path, size, 0, 0);
    if (size == 0) finish_file(s);
}

static void on_list_item(rx_session *s, cur *c) {
    const char *t; unsigned n;
    rx_item it;
    if (!tok(c, &t, &n) || !id_ok(t, n)) return;
    memcpy(it.id, t, n); it.id[n] = 0;
    if (!tok(c, &t, &n) || !num(t, n, 10, &it.size)) return;
    if (!lenstr(c, it.path, sizeof it.path, 0) || !rx_path_ok(it.path)) return;
    if (s->list_n < RX_LIST_MAX) s->list[s->list_n++] = it;
}

static void on_line(rx_session *s, const char *line, unsigned len) {
    cur c; const char *t; unsigned n;
    c.p = line; c.end = line + len;
    if (s->list_expect) {
        on_list_item(s, &c);
        if (--s->list_expect == 0) emit(s, RX_EV_LIST, 0, 0, 0, 0, 0);
        return;
    }
    if (!tok(&c, &t, &n)) return;
    if (is(t, n, "WEBADF")) { puts_(s, "READY 1\n"); emit(s, RX_EV_HELLO, 0, 0, 0, 0, 0); }
    else if (is(t, n, "PING")) puts_(s, "PONG\n");
    else if (is(t, n, "LIST")) {
        unsigned long k;
        if (!tok(&c, &t, &n) || !num(t, n, 10, &k) || k > 1000) return;
        s->list_n = 0;
        s->list_expect = (unsigned)k;
        if (k == 0) emit(s, RX_EV_LIST, 0, 0, 0, 0, 0);
    }
    else if (is(t, n, "FILE")) on_file(s, &c);
    /* anything else: ignored, for newer boards and stray clients */
}

int rx_feed(rx_session *s, const unsigned char *data, unsigned long n) {
    while (n) {
        if (s->in_data) {
            unsigned long done0 = s->cur_size - s->cur_left;
            unsigned long room = PROGRESS_STEP - (done0 % PROGRESS_STEP);   /* cross one 16 KB mark per pass */
            unsigned long take = n < s->cur_left ? n : s->cur_left;
            if (take > room) take = room;
            if (!s->cur_write_failed && s->fs->write(s->fs->ctx, data, take) != 0) s->cur_write_failed = 1;
            s->cur_crc = rx_crc32_update(s->cur_crc, data, take);
            s->cur_left -= take; data += take; n -= take;
            {
                unsigned long done = s->cur_size - s->cur_left;
                if (s->cur_left && done / PROGRESS_STEP > s->cur_mark) {
                    s->cur_mark = done / PROGRESS_STEP;
                    emit(s, RX_EV_PROGRESS, s->cur_id, s->cur_path, s->cur_size, done, 0);
                }
            }
            if (s->cur_left == 0) finish_file(s);
            continue;
        }
        if (*data == '\n') {
            unsigned len = s->line_n;
            if (len && s->line[len - 1] == '\r') len--;
            s->line[len] = 0;
            s->line_n = 0;
            data++; n--;
            on_line(s, s->line, len);
            continue;
        }
        if (s->line_n >= RX_LINE_MAX) return -1;
        s->line[s->line_n++] = (char)*data++;
        n--;
    }
    return 0;
}

void rx_disconnected(rx_session *s) {
    if (s->in_data) {
        if (s->cur_open) { s->fs->close_w(s->fs->ctx); s->cur_open = 0; }
        s->fs->remove(s->fs->ctx, s->cur_tmp);
        s->in_data = 0;
        emit(s, RX_EV_FAILED, s->cur_id, s->cur_path, s->cur_size, 0, "connection lost");
    }
    s->line_n = 0; s->list_expect = 0; s->out_n = 0;
}
