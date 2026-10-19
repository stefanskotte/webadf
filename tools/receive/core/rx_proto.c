#include <string.h>
#include "rx_crc.h"
#include "rx_names.h"
#include "rx_proto.h"

#define PROGRESS_STEP 16384UL

static void emit_full(rx_session *s, int kind, const char *id, const char *path, unsigned long size,
                      unsigned long bytes, const char *text, unsigned tag, const char *code, const char *key) {
    rx_event e;
    if (!s->on_event) return;
    e.kind = kind; e.id = id; e.path = path; e.size = size; e.bytes = bytes; e.text = text;
    e.tag = tag; e.code = code; e.key = key;
    s->on_event(s->uctx, &e);
}
static void emit(rx_session *s, int kind, const char *id, const char *path, unsigned long size,
                 unsigned long bytes, const char *text) {
    emit_full(s, kind, id, path, size, bytes, text, 0, 0, 0);
}

static void put(rx_session *s, const char *p, unsigned n) {
    if (s->out_n + n > RX_OUT_MAX) return; /* replies are short; a full buffer means the peer stopped reading */
    memcpy(s->out + s->out_n, p, n);
    s->out_n += n;
}
static void puts_(rx_session *s, const char *p) { put(s, p, (unsigned)strlen(p)); }

static void emit_up(rx_session *s, int kind, const rx_up_item *it, const char *path, unsigned long size,
                    unsigned long bytes, const char *text, const char *code) {
    emit_full(s, kind, 0, path ? path : it->name, size, bytes, text, it->tag, code, 0);
}
static void put_dec(rx_session *s, unsigned long v) { char b[12]; rx_utoa(v, b); puts_(s, b); }
static void put_hex(rx_session *s, unsigned long v) {
    char b[9]; int i = 8;
    b[8] = 0;
    do { b[--i] = "0123456789abcdef"[v & 15UL]; v >>= 4; } while (v && i > 0);
    puts_(s, b + i);
}
static void put_lenstr(rx_session *s, const char *str) { put_dec(s, (unsigned long)strlen(str)); puts_(s, ":"); puts_(s, str); }

static void reply_err(rx_session *s, const char *id, const char *code, const char *text) {
    puts_(s, "ERR "); puts_(s, id[0] ? id : "-"); puts_(s, " "); puts_(s, code); puts_(s, " ");
    puts_(s, text); puts_(s, "\n");
}
/* A FILE refused before GO: the board gets the ERR, and the Amiga's window or Shell shows why. */
static void refuse(rx_session *s, const char *id, const char *path, const char *code, const char *text) {
    reply_err(s, id, code, text);
    emit(s, RX_EV_FAILED, id[0] ? id : "-", path, 0, 0, text);
}

void rx_init(rx_session *s, const rx_fs *fs, rx_event_fn on_event, void *uctx) {
    memset(s, 0, sizeof *s);
    s->fs = fs; s->on_event = on_event; s->uctx = uctx;
}

int rx_busy(const rx_session *s) { return s->in_data; }

static unsigned take_lines(rx_session *s, char *dst, unsigned cap) {
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
        if (x > (0xFFFFFFFFUL - (unsigned long)d) / (unsigned long)base) return 0;   /* over 32 bits: refused */
        x = x * (unsigned long)base + (unsigned long)d;
    }
    *v = x;
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

/* --- protocol 2: the hello and the board key (spec 2026-10-18 §3, §6) --- */
static int hex_key(const char *t, unsigned n, char *out) {
    unsigned i;
    if (n != RX_KEY_HEX) return 0;
    for (i = 0; i < n; i++) {
        char ch = t[i];
        if (ch >= 'A' && ch <= 'F') ch = (char)(ch - 'A' + 'a');
        if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return 0;
        out[i] = ch;
    }
    out[n] = 0;
    return 1;
}
static void emit_trust(rx_session *s, const char *code) { emit_full(s, RX_EV_TRUST, 0, 0, 0, 0, 0, 0, code, s->peer_key); }
/* "WEBADF <v> [<key>]": READY 1 to a protocol 1 board (or a stray WEBADF), READY 2 to a protocol 2 one; then the key
   decides whether this connection may upload. Downloads work either way. */
static void on_hello(rx_session *s, cur *c) {
    const char *t; unsigned n; unsigned long v = 1;
    if (tok(c, &t, &n) && !num(t, n, 10, &v)) v = 1;
    s->peer_key[0] = 0;
    if (v < 2) {
        s->peer_v = 1; s->trust = RX_TRUST_OLD;
        puts_(s, "READY 1\n");
        emit(s, RX_EV_HELLO, 0, 0, 0, 0, 0);
        if (s->upq) emit_trust(s, "old");
        return;
    }
    s->peer_v = 2;
    puts_(s, "READY 2\n");
    if (!tok(c, &t, &n) || !hex_key(t, n, s->peer_key)) s->peer_key[0] = 0;
    emit(s, RX_EV_HELLO, 0, 0, 0, 0, 0);
    if (!s->upq) { s->trust = RX_TRUST_NONE; return; }
    if (!s->peer_key[0]) { s->trust = RX_TRUST_OTHER; emit_trust(s, "other"); }
    else if (!s->upq->trusted[0] || s->upq->trust_next) {
        strcpy(s->upq->trusted, s->peer_key); s->upq->trust_next = 0;
        s->trust = RX_TRUST_OK; emit_trust(s, "new");
    } else if (strcmp(s->upq->trusted, s->peer_key) == 0) { s->trust = RX_TRUST_OK; emit_trust(s, "ok"); }
    else { s->trust = RX_TRUST_OTHER; emit_trust(s, "other"); }
}

void rx_attach(rx_session *s, rx_upq *q) { s->upq = q; }
int rx_uploads_on(const rx_session *s) { return s->upq && s->peer_v >= 2 && s->trust == RX_TRUST_OK; }
int rx_trust_now(rx_session *s) {
    if (!s->upq || s->peer_v < 2 || !s->peer_key[0]) return -1;
    strcpy(s->upq->trusted, s->peer_key);
    s->upq->trust_next = 0;
    s->trust = RX_TRUST_OK;
    emit_trust(s, "new");
    return 0;
}
void rx_key4(const char *key, char out[5]) {
    unsigned i;
    for (i = 0; i < 4 && key && key[i]; i++) out[i] = (char)(key[i] >= 'a' && key[i] <= 'f' ? key[i] - 'a' + 'A' : key[i]);
    out[i] = 0;
}

/* --- protocol 2: the queue (in memory only: spec §2) --- */
void rx_upq_init(rx_upq *q, const char *trusted) {
    memset(q, 0, sizeof *q);
    if (trusted && !hex_key(trusted, (unsigned)strlen(trusted), q->trusted)) q->trusted[0] = 0;
}
unsigned rx_up_add(rx_upq *q, const char *local, const char *name) {
    rx_up_item *it;
    if (q->n >= RX_UP_MAX || !local[0] || strlen(local) > RX_LOCAL_MAX || !rx_path_ok(name)) return 0;
    it = &q->q[q->n++];
    if (++q->next_tag > 999999999U) q->next_tag = 1;   /* the board reads 1-9 digits */
    it->tag = q->next_tag;
    strcpy(it->local, local);
    strcpy(it->name, name);
    return it->tag;
}
int rx_upq_remove(rx_upq *q, unsigned tag) {
    unsigned i;
    for (i = 0; i < q->n; i++) if (q->q[i].tag == tag) {
        memmove(&q->q[i], &q->q[i + 1], (q->n - i - 1) * sizeof q->q[0]);
        q->n--;
        return 1;
    }
    return 0;
}

/* A dropped drawer (spec §2): each file joins with its path under the drawer ("Drawer/sub/file"), 64 at most; an .info
   file only when the icon itself was dropped. */
typedef struct { rx_upq *q; const rx_fs *fs; rx_added_fn added; void *u;
                 char local[RX_LOCAL_MAX + 1]; char name[RX_PATH_MAX + 1]; int n, depth; } rx_walk;
static int ends_info(const char *nm) {
    size_t k = strlen(nm);
    return k >= 5 && nm[k - 5] == '.' && (nm[k - 4] | 0x20) == 'i' && (nm[k - 3] | 0x20) == 'n' &&
           (nm[k - 2] | 0x20) == 'f' && (nm[k - 1] | 0x20) == 'o';
}
static void walk_each(void *u, const char *nm, int is_dir) {
    rx_walk *w = u;
    size_t ll = strlen(w->local), nl = strlen(w->name), k = strlen(nm);
    size_t sep = (ll && w->local[ll - 1] != ':' && w->local[ll - 1] != '/') ? 1 : 0;
    if (w->n >= RX_UP_MAX || (!is_dir && ends_info(nm))) return;
    if (ll + sep + k > RX_LOCAL_MAX || nl + 1 + k > RX_PATH_MAX) return;
    if (sep) w->local[ll] = '/';
    memcpy(w->local + ll + sep, nm, k + 1);
    w->name[nl] = '/';
    memcpy(w->name + nl + 1, nm, k + 1);
    if (is_dir) {
        if (w->depth < RX_TREE_DEPTH) { w->depth++; w->fs->list(w->fs->ctx, w->local, walk_each, w); w->depth--; }
    } else if (rx_up_add(w->q, w->local, w->name)) {
        w->n++;
        if (w->added) w->added(w->u, &w->q->q[w->q->n - 1]);
    }
    w->local[ll] = 0;
    w->name[nl] = 0;
}
int rx_up_add_tree(rx_upq *q, const rx_fs *fs, const char *local, const char *name, rx_added_fn added, void *u) {
    static rx_walk w;   /* static: the Amiga's stack is small, and a walk is never nested */
    int d;
    if (strlen(local) > RX_LOCAL_MAX || strlen(name) > RX_PATH_MAX) return -1;
    d = fs->is_dir(fs->ctx, local);
    if (d < 0) return -1;
    if (d == 0) {
        if (!rx_up_add(q, local, name)) return 0;
        if (added) added(u, &q->q[q->n - 1]);
        return 1;
    }
    memset(&w, 0, sizeof w);
    w.q = q; w.fs = fs; w.added = added; w.u = u;
    strcpy(w.local, local); strcpy(w.name, name);
    if (fs->list(fs->ctx, local, walk_each, &w) != 0) return -1;
    return w.n;
}


/* --- protocol 2: the file going up (spec §3; plan ruling P7) --- */
static int put_due(const rx_session *s) {
    return s->upq && s->upq->n > 0 && s->up_phase == RX_UP_IDLE && !s->in_data && !s->up_closing && rx_uploads_on(s);
}
/* Ends the file going up: closed, and the front end told. */
static void up_finish(rx_session *s, int kind, const char *text, const char *code, const char *stored) {
    rx_up_item it = s->up_cur;
    unsigned long size = s->up_info.size, sent = s->up_sent;
    s->fs->close_r(s->fs->ctx);
    s->up_phase = RX_UP_IDLE;
    s->up_cancel = 0;
    if (kind == RX_EV_UP_DONE) emit_up(s, kind, &it, stored, size, size, 0, 0);
    else emit_up(s, kind, &it, 0, size, sent, text, code);
}
static void protocol_error(rx_session *s, const char *why) {
    if (s->up_phase != RX_UP_IDLE) up_finish(s, RX_EV_UP_FAILED, why, "local", 0);
    s->proto_err = 1;
}
static void up_put(rx_session *s) {
    while (put_due(s)) {
        rx_up_item it = s->upq->q[0];
        rx_upq_remove(s->upq, it.tag);
        memset(&s->up_info, 0, sizeof s->up_info);
        if (s->fs->open_r(s->fs->ctx, it.local, &s->up_info) != 0) {
            emit_up(s, RX_EV_UP_FAILED, &it, 0, 0, 0, "cannot read the file", "local");
            continue;
        }
        if (s->up_info.size > RX_FILE_MAX) {
            s->fs->close_r(s->fs->ctx);
            emit_up(s, RX_EV_UP_FAILED, &it, 0, s->up_info.size, 0, "file too large (4 MB at most)", "local");
            continue;
        }
        s->up_cur = it; s->up_phase = RX_UP_ASKED; s->up_cancel = 0; s->up_sent = 0;
        puts_(s, "PUT "); put_dec(s, it.tag); puts_(s, " "); put_dec(s, s->up_info.size); puts_(s, " ");
        put_dec(s, s->up_info.days); puts_(s, "."); put_dec(s, s->up_info.mins); puts_(s, "."); put_dec(s, s->up_info.ticks);
        puts_(s, " "); put_hex(s, s->up_info.prot); puts_(s, " "); put_lenstr(s, it.name); puts_(s, " ");
        put_lenstr(s, s->up_info.comment); puts_(s, "\n");
        return;
    }
}
static void up_end(rx_session *s) {
    s->up_phase = RX_UP_ENDED;
    puts_(s, "END "); put_dec(s, s->up_cur.tag); puts_(s, " "); put_hex(s, s->up_crc); puts_(s, "\n");
}
static void up_data_begins(rx_session *s) {
    s->up_phase = RX_UP_DATA;
    if (s->up_sent == s->up_info.size) up_end(s);
}
/* Mid-file nothing can stop the raw section but closing (ruling P7). */
static int up_read_failed(rx_session *s) {
    up_finish(s, RX_EV_UP_FAILED, "cannot read the file", "local", 0);
    s->up_closing = 1;
    return -1;
}
/* One block: the resumed part's CRC (nothing to send), or bytes within the credit. */
static int up_bytes(rx_session *s, unsigned char *dst, unsigned cap) {
    unsigned long want;
    if (cap > RX_UP_BLOCK) cap = (unsigned)RX_UP_BLOCK;
    if (s->up_phase == RX_UP_SKIP) {
        want = s->up_skip < cap ? s->up_skip : cap;
        if (s->fs->read(s->fs->ctx, dst, want) != (long)want) return up_read_failed(s);
        s->up_crc = rx_crc32_update(s->up_crc, dst, want);
        s->up_skip -= want;
        if (s->up_skip == 0) up_data_begins(s);
        return 0;
    }
    want = s->up_credit - s->up_sent;
    if (want > cap) want = cap;
    if (want == 0) return 0;
    if (s->fs->read(s->fs->ctx, dst, want) != (long)want) return up_read_failed(s);
    s->up_crc = rx_crc32_update(s->up_crc, dst, want);
    s->up_sent += want;
    if (s->up_sent == s->up_info.size) up_end(s);   /* END goes out with the next take */
    return (int)want;
}
static int tag_is(const rx_session *s, cur *c) {
    const char *t; unsigned n; unsigned long v;
    return s->up_phase != RX_UP_IDLE && tok(c, &t, &n) && num(t, n, 10, &v) && v == s->up_cur.tag;
}
static void on_take(rx_session *s, cur *c) {
    const char *t; unsigned n; unsigned long off, credit;
    if (s->up_phase != RX_UP_ASKED || !tag_is(s, c)) return;
    if (!tok(c, &t, &n) || !num(t, n, 10, &off) || !tok(c, &t, &n) || !num(t, n, 10, &credit) ||
        off > s->up_info.size || credit < off || credit > s->up_info.size) {
        protocol_error(s, "the board answered out of range");
        return;
    }
    if (s->up_cancel) {   /* our ABORT crossed this TAKE: the board treats every byte as data now */
        up_finish(s, RX_EV_UP_FAILED, "cancelled", "local", 0);
        s->up_closing = 1;
        return;
    }
    s->up_off = s->up_sent = off; s->up_credit = credit; s->up_window = credit - off; s->up_crc = 0; s->up_skip = off;
    emit_up(s, RX_EV_UP_BEGIN, &s->up_cur, 0, s->up_info.size, off, 0, 0);
    if (off) s->up_phase = RX_UP_SKIP; else up_data_begins(s);
}
static void on_more(rx_session *s, cur *c) {
    const char *t; unsigned n; unsigned long v;
    if ((s->up_phase != RX_UP_SKIP && s->up_phase != RX_UP_DATA && s->up_phase != RX_UP_ENDED) || !tag_is(s, c)) return;
    if (!tok(c, &t, &n) || !num(t, n, 10, &v) || v > s->up_info.size) { protocol_error(s, "the board answered out of range"); return; }
    if (v > s->up_credit) s->up_credit = v;
    emit_up(s, RX_EV_UP_PROGRESS, &s->up_cur, 0, s->up_info.size, s->up_credit - s->up_window, 0, 0);
}
static void on_done(rx_session *s, cur *c) {
    char name[RX_PATH_MAX + 1];
    if (s->up_phase != RX_UP_ENDED || !tag_is(s, c)) return;
    if (!lenstr(c, name, sizeof name, 1)) strcpy(name, s->up_cur.name);
    up_finish(s, RX_EV_UP_DONE, 0, 0, name);
}
static void on_no(rx_session *s, cur *c) {
    const char *t; unsigned n; char code[17], text[80];
    int raw = s->up_phase == RX_UP_SKIP || s->up_phase == RX_UP_DATA;
    if (!tag_is(s, c)) return;
    if (!tok(c, &t, &n) || n > 16) { t = "server"; n = 6; }
    memcpy(code, t, n); code[n] = 0;
    if (!lenstr(c, text, sizeof text, 1)) strcpy(text, "refused");
    up_finish(s, RX_EV_UP_FAILED, (s->up_cancel && strcmp(code, "busy") == 0) ? "cancelled" : text, code, 0);
    if (raw) s->up_closing = 1;   /* the stream's place is lost: the board closes too */
}

int rx_take_output(rx_session *s, char *dst, unsigned cap) {
    if (s->up_closing) return -1;
    if (s->up_phase == RX_UP_SKIP || s->up_phase == RX_UP_DATA) return up_bytes(s, (unsigned char *)dst, cap);
    if (s->out_n == 0) up_put(s);
    return (int)take_lines(s, dst, cap);
}
int rx_want_output(const rx_session *s) {
    if (s->up_closing || s->up_phase == RX_UP_SKIP) return 1;
    if (s->up_phase == RX_UP_DATA) return s->up_sent < s->up_credit;
    return s->out_n > 0 || put_due(s);
}
int rx_up_cancel(rx_session *s, rx_upq *q, unsigned tag) {
    unsigned i;
    for (i = 0; q && i < q->n; i++) if (q->q[i].tag == tag) {
        rx_up_item it = q->q[i];
        rx_upq_remove(q, tag);
        emit_up(s, RX_EV_UP_FAILED, &it, 0, 0, 0, "cancelled", "local");
        return 0;
    }
    if (s->up_phase == RX_UP_IDLE || s->up_cur.tag != tag) return -1;
    if (s->up_phase == RX_UP_ASKED) {
        if (!s->up_cancel) { puts_(s, "ABORT "); put_dec(s, tag); puts_(s, "\n"); s->up_cancel = 1; }
        return 0;
    }
    if (s->up_phase == RX_UP_ENDED) return 0;   /* the last byte is out: the web app has it in a moment */
    up_finish(s, RX_EV_UP_FAILED, "cancelled", "local", 0);
    s->up_closing = 1;
    return 1;
}
int rx_idle_secs(const rx_session *s) { return s->up_phase != RX_UP_IDLE ? RX_UP_IDLE_SECS : RX_IDLE_SECS; }

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
    if (!tok(c, &t, &n) || !id_ok(t, n)) { refuse(s, "", "", "name", "bad request"); return; }
    memcpy(id, t, n); id[n] = 0;
    if (!tok(c, &t, &n) || !num(t, n, 10, &size)) { refuse(s, id, "", "name", "bad request"); return; }
    if (size > RX_FILE_MAX) { refuse(s, id, "", "size", "file too large"); return; }
    if (!tok(c, &t, &n) || !num(t, n, 16, &crc)) { refuse(s, id, "", "name", "bad request"); return; }
    if (!tok(c, &t, &n) || !num(t, n, 16, &prot)) { refuse(s, id, "", "name", "bad request"); return; }
    if (!lenstr(c, s->cur_path, sizeof s->cur_path, 0) || !lenstr(c, s->cur_comment, sizeof s->cur_comment, 1)) {
        refuse(s, id, "", "name", "bad request"); return;
    }
    if (!rx_path_ok(s->cur_path)) { refuse(s, id, s->cur_path, "name", "bad name"); return; }
    if (!s->fs->folder_ok(s->fs->ctx)) { refuse(s, id, s->cur_path, "folder", "folder not found"); return; }
    {
        unsigned long fr = s->fs->free_bytes(s->fs->ctx);
        if (fr < 8192UL || fr - 8192UL < size) { refuse(s, id, s->cur_path, "space", "not enough space"); return; }
    }
    if (make_parents(s, s->cur_path) != 0) { refuse(s, id, s->cur_path, "write", "cannot create folder"); return; }
    parent_of(s->cur_path, s->cur_tmp);
    strcat(s->cur_tmp, RX_TMP_NAME);
    if (s->fs->open_w(s->fs->ctx, s->cur_tmp) != 0) { refuse(s, id, s->cur_path, "write", "cannot write"); return; }
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
    if (is(t, n, "WEBADF")) on_hello(s, &c);
    else if (is(t, n, "PING")) puts_(s, "PONG\n");
    else if (is(t, n, "LIST")) {
        unsigned long k;
        if (!tok(&c, &t, &n) || !num(t, n, 10, &k) || k > 1000) return;
        s->list_n = 0;
        s->list_expect = (unsigned)k;
        if (k == 0) emit(s, RX_EV_LIST, 0, 0, 0, 0, 0);
    }
    else if (is(t, n, "FILE")) {
        if (s->up_phase == RX_UP_SKIP || s->up_phase == RX_UP_DATA) protocol_error(s, "the board sent a file mid-upload");
        else on_file(s, &c);
    }
    else if (is(t, n, "TAKE")) on_take(s, &c);
    else if (is(t, n, "MORE")) on_more(s, &c);
    else if (is(t, n, "DONE")) on_done(s, &c);
    else if (is(t, n, "NO")) on_no(s, &c);
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
            if (s->proto_err) return -1;
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
    if (s->up_phase != RX_UP_IDLE) up_finish(s, RX_EV_UP_FAILED, s->up_cancel ? "cancelled" : "connection lost", "local", 0);
    s->up_closing = 0; s->proto_err = 0;
    s->peer_v = 0; s->trust = RX_TRUST_NONE;
    s->line_n = 0; s->list_expect = 0; s->out_n = 0;
}
