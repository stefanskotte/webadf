#include <stdlib.h>
#include <string.h>
#include "rx_crc.h"
#include "rx_names.h"
#include "rx_proto.h"

#define PROGRESS_STEP 16384UL

#ifdef RX_TEST_HOOKS   /* host tests: a malloc that fails on demand, and a count of what is held (plan ruling W16) */
long rx_test_fail_alloc, rx_test_live;
static void *rx_malloc(size_t n) {
    void *p;
    if (rx_test_fail_alloc > 0 && --rx_test_fail_alloc == 0) return NULL;
    p = malloc(n);
    if (p) rx_test_live++;
    return p;
}
static void rx_free(void *p) { if (p) { rx_test_live--; free(p); } }
#else
#define rx_malloc malloc
#define rx_free free
#endif

static void emit_full(rx_session *s, int kind, const char *id, const char *path, unsigned long size,
                      unsigned long bytes, const char *text, unsigned tag, const char *code, const char *key) {
    rx_event e;
    if (!s->on_event) return;
    e.kind = kind; e.id = id; e.path = path; e.size = size; e.bytes = bytes; e.text = text;
    e.tag = tag; e.code = code; e.key = key; e.to = 0;
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
/* "WEBADF <v> [<key>]": READY 1 to a protocol 1 board (or a stray WEBADF), READY 2 to a protocol 2 one, READY 3 <b> to
   protocol 3 and newer (spec 2026-10-30 §2.1: b = 1 while requests will be answered); then the key decides whether
   this connection may upload and browse. Downloads work either way. */
static void on_hello(rx_session *s, cur *c) {
    const char *t; unsigned n; unsigned long v = 1; const char *code = 0;
    if (tok(c, &t, &n) && !num(t, n, 10, &v)) v = 1;
    s->peer_key[0] = 0;
    if (v < 2) {
        s->peer_v = 1; s->trust = RX_TRUST_OLD;
        puts_(s, "READY 1\n");
        emit(s, RX_EV_HELLO, 0, 0, 0, 0, 0);
        if (s->upq) emit_trust(s, "old");
        return;
    }
    s->peer_v = v >= 5 ? 5 : v == 4 ? 4 : v == 3 ? 3 : 2;
    if (!tok(c, &t, &n) || !hex_key(t, n, s->peer_key)) s->peer_key[0] = 0;
    if (!s->upq) s->trust = RX_TRUST_NONE;
    else if (!s->peer_key[0]) { s->trust = RX_TRUST_OTHER; code = "other"; }
    else if (!s->upq->trusted[0] || s->upq->trust_next) {
        strcpy(s->upq->trusted, s->peer_key); s->upq->trust_next = 0;
        s->trust = RX_TRUST_OK; code = "new";
    } else if (strcmp(s->upq->trusted, s->peer_key) == 0) { s->trust = RX_TRUST_OK; code = "ok"; }
    else { s->trust = RX_TRUST_OTHER; code = "other"; }
    if (s->peer_v >= 4) {   /* spec 2026-10-31 §2.1: READY 4 <b> <w>, w only with b; §9: READY 5 alike */
        s->hello_browse = rx_browse_on(s); s->hello_write = rx_write_on(s);
        puts_(s, s->peer_v == 5 ? "READY 5 " : "READY 4 ");
        puts_(s, s->hello_write ? "1 1\n" : s->hello_browse ? "1 0\n" : "0 0\n");
    } else if (s->peer_v == 3) {
        s->hello_browse = rx_browse_on(s);
        puts_(s, s->hello_browse ? "READY 3 1\n" : "READY 3 0\n");
    } else puts_(s, "READY 2\n");
    emit(s, RX_EV_HELLO, 0, 0, 0, 0, 0);
    if (code) emit_trust(s, code);
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

/* --- protocol 3: requests (spec 2026-10-30 §2.2) --- */
static const char *const REQ_WORD[] = { "", "vols", "dir", "get", "mkdir", "rename", "delete", "protect", "note" };
static int is_write(int kind) { return kind >= RX_REQ_MKDIR; }
int rx_browse_on(const rx_session *s) { return s->upq && s->upq->browse && s->peer_v >= 3 && s->trust == RX_TRUST_OK; }
int rx_write_on(const rx_session *s) { return rx_browse_on(s) && s->upq->write && s->peer_v >= 4; }
/* A request starts only with nothing moving: a file being received or going up finishes first (spec §2.2 Order). */
static int req_idle(const rx_session *s) { return !s->in_data && s->up_phase == RX_UP_IDLE && !s->up_closing; }
int rx_hello_stale(const rx_session *s) {
    return s->peer_v >= 3 && (s->hello_browse != rx_browse_on(s) || (s->peer_v >= 4 && s->hello_write != rx_write_on(s))) && req_idle(s) &&
           s->req_kind == RX_REQ_NONE && s->wait_kind == RX_REQ_NONE && s->out_n == 0;
}
/* in, without control bytes (a newline would end the line early), into out[cap]. */
static void clean(const char *in, char *out, unsigned cap) {
    unsigned i;
    for (i = 0; in[i] && i + 1 < cap; i++) out[i] = (unsigned char)in[i] < 0x20 ? ' ' : in[i];
    out[i] = 0;
}
/* "ERR <id> <code> <len>:<text>" (unlike FILE's ERR, the text is length-prefixed). */
static void req_err(rx_session *s, const char *id, const char *code, const char *text) {
    char t[80];
    clean(text, t, sizeof t);
    puts_(s, "ERR "); puts_(s, id[0] ? id : "-"); puts_(s, " "); puts_(s, code); puts_(s, " "); put_lenstr(s, t); puts_(s, "\n");
}
static void emit_req_to(rx_session *s, int kind, const char *id, const char *path, const char *to, unsigned long count,
                        int cut, const char *why) {
    rx_event e;
    if (!s->on_event) return;
    memset(&e, 0, sizeof e);
    e.kind = RX_EV_REQ; e.id = id; e.path = path; e.size = count; e.bytes = (unsigned long)cut; e.text = why;
    e.code = REQ_WORD[kind]; e.to = to;
    s->on_event(s->uctx, &e);
}
static void emit_req(rx_session *s, int kind, const char *id, const char *path, unsigned long count, int cut, const char *why) {
    emit_req_to(s, kind, id, path, kind == RX_REQ_RENAME && kind == s->req_kind ? s->req_arg : 0, count, cut, why);
}
static void req_end(rx_session *s) {
    if (s->req_open) { s->fs->dir_close(s->fs->ctx); s->req_open = 0; }
    if (s->req_kind == RX_REQ_DELETE) s->req_path[s->del_top] = 0;   /* the walk's stack back to the named path */
    s->req_kind = RX_REQ_NONE; s->del_drawer = 0;
}
/* The request being answered fails: its ERR, the owner told, the drawer let go. */
static void req_fail_text(rx_session *s, const char *code, const char *text) {
    req_err(s, s->req_id, code, text);
    emit_req(s, s->req_kind, s->req_id, s->req_path, s->req_count, 0, text);
    req_end(s);
}
static void req_done(rx_session *s, int cut) {
    puts_(s, "DONE "); puts_(s, s->req_id); puts_(s, " "); put_dec(s, s->req_count);
    if (cut) puts_(s, " cut");
    puts_(s, "\n");
    emit_req(s, s->req_kind, s->req_id, s->req_path, s->req_count, cut, 0);
    req_end(s);
}
/* The server takes only ^\d{1,6}\.\d{1,5}\.\d{1,5}$: a damaged date goes out as 0.0.0, so one bad entry cannot fail a
   whole VOLS or DIR answer (final review 1). */
static void put_date(rx_session *s, unsigned long d, unsigned long m, unsigned long t) {
    if (d > 999999UL || m > 99999UL || t > 99999UL) d = m = t = 0;
    put_dec(s, d); puts_(s, "."); put_dec(s, m); puts_(s, "."); put_dec(s, t);
}
const char *rx_err_code(long err, int want_dir) {
    switch (err) {
    case RX_DOS_NOT_FOUND: case RX_DOS_DIR_NOT_FOUND: return "notfound";
    case RX_DOS_IN_USE: return "busy";
    case RX_DOS_READ_PROTECTED: case 222: case 223: return "denied";   /* 222 delete-, 223 write-protected (W13) */
    case RX_DOS_WRONG_TYPE: return want_dir ? "notdir" : "isdir";
    case 203: return "exists";
    case 214: return "wprot";
    case 215: return "xvol";
    case 221: return "full";
    default: return "io";
    }
}
/* A DOS error ends the request, in AmigaDOS's own words (Fault()). */
static void req_fail(rx_session *s, long err, int want_dir) {
    char text[80];
    text[0] = 0;
    s->fs->fault(s->fs->ctx, err, text, sizeof text);
    if (!text[0]) strcpy(text, "error");
    req_fail_text(s, rx_err_code(err, want_dir), text);
}
static void put_ent(rx_session *s, const rx_dent *e) {
    char cm[RX_COMMENT_MAX + 1];
    clean(e->comment, cm, sizeof cm);
    puts_(s, "ENT "); puts_(s, s->req_id); puts_(s, e->is_dir ? " d " : " f "); put_dec(s, e->is_dir ? 0 : e->size);
    puts_(s, " "); put_hex(s, e->prot); puts_(s, " "); put_date(s, e->days, e->mins, e->ticks);
    puts_(s, " "); put_lenstr(s, e->name); puts_(s, " "); put_lenstr(s, cm); puts_(s, "\n");
}
/* GET (spec §2.2): checked now, then GOT and the file first in the up-queue; it goes up by protocol 2 as soon as
   nothing else moves. */
static void get_start(rx_session *s) {
    rx_finfo info; int is_dir = 0; long e; char name[RX_PART_MAX + 1]; unsigned tag;
    memset(&info, 0, sizeof info);
    e = s->fs->stat(s->fs->ctx, s->req_path, &info, &is_dir);
    if (e) { req_fail(s, e, 0); return; }
    if (is_dir) { req_fail(s, RX_DOS_WRONG_TYPE, 0); return; }
    if (info.prot & 8UL) { req_fail(s, RX_DOS_READ_PROTECTED, 0); return; }   /* FIBF_READ set: not readable */
    if (info.size > RX_FILE_MAX) { req_fail_text(s, "toolarge", "file too large (4 MB at most)"); return; }
    rx_base_name(s->req_path, name);
    tag = rx_up_add_front(s->upq, s->req_path, name, s->req_id);
    if (!tag) {
        if (s->upq->n >= RX_UP_MAX) req_fail_text(s, "busy", "too many files waiting");
        else if (!rx_path_ok(name)) req_fail_text(s, "io", "cannot send that name");   /* plan ruling T7 */
        else req_fail_text(s, "busy", "not enough memory on the Amiga");   /* the item's malloc failed */
        return;
    }
    puts_(s, "GOT "); puts_(s, s->req_id); puts_(s, " "); put_dec(s, tag); puts_(s, "\n");
    emit_req(s, RX_REQ_GET, s->req_id, s->req_path, 0, 0, 0);
    req_end(s);
}
/* The volume list: file-static, not in each session (final review 5; the Shell and the window each have a session).
   One connection is answered at a time and its requests one at a time, so a DIR/GET check never runs while a VOLS
   answer is walking this list. */
static rx_vol g_vols[RX_VOLS_MAX];
static int ascii_eq_n(const char *a, const char *b, unsigned n) {
    unsigned i;
    for (i = 0; i < n; i++) {
        unsigned char x = (unsigned char)a[i], y = (unsigned char)b[i];
        if (x >= 'a' && x <= 'z') x = (unsigned char)(x - 32);
        if (y >= 'a' && y <= 'z') y = (unsigned char)(y - 32);
        if (x != y) return 0;
    }
    return 1;
}
/* 1 if the part of path before its first ':' names a mounted volume VOLS would send, by its name or its device name
   (ASCII case folded); 0 if not, -1 if the list cannot be read. Keeps CON:, PIPE: and assigns (ENVARC:, SYS:, C:)
   out: a handler that is not a filesystem can open a window on the Amiga or block Transfer (spec V2; final review 3). */
/* The index in g_vols (k entries, as read) of the volume path names, or -1. */
static int vol_find(const char *path, int k) {
    unsigned n = (unsigned)(strchr(path, ':') - path); int i;
    for (i = 0; i < k; i++) {
        const rx_vol *v = &g_vols[i];
        size_t dn = strlen(v->device);
        if (!rx_name_sendable(v->name) || !rx_device_sendable(v->device)) continue;   /* as VOLS (rulings T2, T11) */
        if (strlen(v->name) == n && ascii_eq_n(v->name, path, n)) return i;
        if (dn == n + 1 && v->device[n] == ':' && ascii_eq_n(v->device, path, n)) return i;
    }
    return -1;
}
static int vol_known(rx_session *s, const char *path) {
    int k = s->fs->vols(s->fs->ctx, g_vols, RX_VOLS_MAX);
    if (k < 0) return -1;
    return vol_find(path, k) >= 0;
}
static void cat(char *out, unsigned cap, const char *str) {
    size_t n = strlen(out);
    while (*str && n + 1 < cap) out[n++] = *str++;
    out[n] = 0;
}
static void short_path(const char *path, char *p) {   /* p[44]: a path over 40 bytes ends "..." */
    if (strlen(path) > 40) { memcpy(p, path, 37); strcpy(p + 37, "..."); }
    else strcpy(p, path);
}
void rx_req_words(const rx_event *e, char *out, unsigned cap) {
    /* the verb when it worked, and after "could not " when it failed (spec 2026-10-30 §2.3, 2026-10-31 §2.3) */
    static const char *const OK[] = { "listed ", "copying ", "made ", "renamed ", "deleted ", "protected ", "comment on " };
    static const char *const NO[] = { "list ", "copy ", "make ", "rename ", "delete ", "protect ", "comment on " };
    static const char *const CODE[] = { "dir", "get", "mkdir", "rename", "delete", "protect", "note" };
    char p[44]; unsigned w;
    if (!cap) return;
    out[0] = 0;
    for (w = 0; w < 6 && strcmp(e->code, CODE[w]) != 0; w++) ;
    if (w == 6 && strcmp(e->code, CODE[6]) != 0) w = 0;   /* vols: listed */
    if (strcmp(e->code, "vols") == 0) strcpy(p, "volumes"); else short_path(e->path, p);
    if (e->text) { cat(out, cap, "could not "); cat(out, cap, NO[w]); cat(out, cap, p); cat(out, cap, ": "); cat(out, cap, e->text); return; }
    cat(out, cap, OK[w]); cat(out, cap, p);   /* get: GOT, the file is only queued */
    if (w == 0 && e->bytes) cat(out, cap, " (first 1000)");
    if (w == 3 && e->to) { cat(out, cap, " to "); short_path(e->to, p); cat(out, cap, p); }
    if (w == 4) { char d[12]; rx_utoa(e->size, d); cat(out, cap, " ("); cat(out, cap, d); cat(out, cap, ")"); }
}
/* --- protocol 4: the writes (spec 2026-10-31 §2.3) --- */
/* "DEL <rid> <n>": a drawer delete's progress. */
static void put_del(rx_session *s) { puts_(s, "DEL "); puts_(s, s->req_id); puts_(s, " "); put_dec(s, s->req_count); puts_(s, "\n"); }
/* A drawer delete stops at the entry at (req_path, deeper than the named path when it is inside): DEL with the count so
   far (drawers only: plan ruling W6), then ERR naming the entry under the named drawer (W7). */
/* Protocol 5 (spec §9; plan rulings X1, X2): before it is emptied, the drawer at req_path is renamed within its parent
   to .webadf-del-<8 hex digits from the rid>, so nothing saved by its old path meanwhile is deleted with it. A taken
   name (DOS 203) tries the next of eight; any other refusal, or a hidden path over 255 bytes, deletes in place. */
static void del_hide(rx_session *s) {
    static const char HEX[] = "0123456789abcdef";
    char *p = s->req_path; const char *slash = strrchr(p, '/');
    size_t cut = (size_t)((slash ? slash : strchr(p, ':')) - p) + 1;
    unsigned long h = rx_crc32_update(0, (const unsigned char *)s->req_id, (unsigned long)strlen(s->req_id));
    unsigned i, k;
    if (cut + sizeof ".webadf-del-" - 1 + 8 > RX_LOCAL_MAX) return;
    strcpy(s->req_arg, p);
    for (i = 0; i < 8; i++) {
        unsigned long v = (h + i) & 0xFFFFFFFFUL; long r;
        strcpy(p + cut, ".webadf-del-");
        for (k = 0; k < 8; k++) p[cut + 12 + k] = HEX[(v >> (28 - 4 * k)) & 15];
        p[cut + 20] = 0;
        r = s->fs->w_rename(s->fs->ctx, s->req_arg, p);
        if (r == 0) { s->del_hidden = 1; return; }
        if (r != 203) break;   /* DOS 203: object exists */
    }
    strcpy(p, s->req_arg);
}
/* The walk ends: req_path back to the named path, and a hidden drawer back to its name (X4). 1 when that rename failed
   (the old name taken meanwhile): where[cap] then says where the rest is (X5). The owner hears the old name (X6). */
static int del_unhide(rx_session *s, char *where, unsigned cap) {
    int bad = 0;
    s->req_path[s->del_top] = 0;
    if (!s->del_hidden) return 0;
    s->del_hidden = 0;
    if (s->fs->w_rename(s->fs->ctx, s->req_path, s->req_arg) != 0) {
        const char *slash = strrchr(s->req_path, '/');
        where[0] = 0; cat(where, cap, "the rest is in "); cat(where, cap, slash ? slash + 1 : strchr(s->req_path, ':') + 1);
        bad = 1;
    }
    strcpy(s->req_path, s->req_arg); s->del_top = (unsigned)strlen(s->req_path);
    return bad;
}
static void del_stop_text(rx_session *s, const char *code, const char *why) {
    static char text[80], where[80];   /* static: the Amiga's stack is small; one request runs at a time */
    text[0] = 0;
    if (strlen(s->req_path) > s->del_top) { cat(text, sizeof text, s->req_path + s->del_top + 1); cat(text, sizeof text, ": "); }
    cat(text, sizeof text, why);
    if (s->del_drawer) put_del(s);
    if (del_unhide(s, where, sizeof where)) { cat(where, sizeof where, ": "); cat(where, sizeof where, text); req_fail_text(s, code, where); }
    else req_fail_text(s, code, text);
}
static void del_stop(rx_session *s, long err) {
    char f[80];
    f[0] = 0;
    s->fs->fault(s->fs->ctx, err, f, sizeof f);
    del_stop_text(s, rx_err_code(err, 1), f[0] ? f : "error");
}
/* One step of a drawer delete: one object removed (plan ruling W5). The current drawer's first entry is taken afresh
   each time (nothing is held between steps, and deleting under an ExNext is never needed): a drawer is descended into,
   a file deleted; an empty drawer is deleted and the walk goes back up. */
static void del_step(rx_session *s) {
    static rx_dent e;   /* static: the Amiga's stack is small; one request runs at a time */
    char *p = s->req_path;
    if (!rx_write_on(s)) { del_stop_text(s, "readonly", "writing is off in Transfer"); return; }   /* W12 */
    for (;;) {
        size_t n = strlen(p), k;
        long r = s->fs->dir_open(s->fs->ctx, p);
        if (r) { del_stop(s, r); return; }
        memset(&e, 0, sizeof e);
        r = s->fs->dir_next(s->fs->ctx, &e);
        s->fs->dir_close(s->fs->ctx);
        if (r < 0) { del_stop(s, -r); return; }
        if (r == 0) {   /* p is empty now */
            if ((r = s->fs->w_delete(s->fs->ctx, p)) != 0) { del_stop(s, r); return; }
            s->req_count++;
            if (n == s->del_top) {   /* the named drawer itself: gone; the owner hears its own name (X6) */
                if (s->del_hidden) { strcpy(p, s->req_arg); s->del_top = (unsigned)strlen(p); s->del_hidden = 0; }
                req_done(s, 0); return;
            }
            *strrchr(p, '/') = 0;   /* below the named path there is always a '/' */
            break;
        }
        k = strlen(e.name);
        if (!k || strchr(e.name, '/') || strchr(e.name, ':')) { del_stop_text(s, "io", "bad name"); return; }
        if (n + 1 + k > RX_LOCAL_MAX) { del_stop_text(s, "io", "path too long"); return; }
        p[n] = '/'; memcpy(p + n + 1, e.name, k + 1);
        if (e.is_dir && !e.is_link) continue;   /* down a level; a link is removed, never entered (final review C1) */
        if ((r = s->fs->w_delete(s->fs->ctx, p)) != 0) { del_stop(s, r); return; }
        p[n] = 0;
        s->req_count++;
        break;
    }
    if (s->req_count % RX_DEL_EVERY == 0) put_del(s);
}
/* AmigaDOS's case rule for names: ASCII, and Latin-1's letters (the international file systems; a superset of OFS/FFS). */
static unsigned char fold(unsigned char c) {
    return (unsigned char)(((c >= 'a' && c <= 'z') || (c >= 0xe0 && c <= 0xfe && c != 0xf7)) ? c - 32 : c);
}
static int name_eq(const char *a, const char *b) {
    while (*a && *b && fold((unsigned char)*a) == fold((unsigned char)*b)) { a++; b++; }
    return !*a && !*b;
}
/* What path names, without following it (final review C1): a Lock or Examine of a link reaches its target, so the entry
   is looked up in its drawer's listing. 0, or a DOS error (RX_DOS_NOT_FOUND when the drawer has no such name). */
static long entry_kind(rx_session *s, const char *path, int *is_dir, int *is_link) {
    static char parent[RX_LOCAL_MAX + 1]; static rx_dent e;   /* static: the Amiga's stack is small */
    const char *slash = strrchr(path, '/'), *name;
    long r;
    size_t n = slash ? (size_t)(slash - path) : (size_t)(strchr(path, ':') - path + 1);
    name = path + n + (slash ? 1 : 0);
    memcpy(parent, path, n); parent[n] = 0;
    if ((r = s->fs->dir_open(s->fs->ctx, parent)) != 0) return r == RX_DOS_WRONG_TYPE ? RX_DOS_NOT_FOUND : r;
    for (;;) {
        memset(&e, 0, sizeof e);
        r = s->fs->dir_next(s->fs->ctx, &e);
        if (r <= 0) break;
        if (name_eq(e.name, name)) { *is_dir = e.is_dir; *is_link = e.is_link; break; }
    }
    s->fs->dir_close(s->fs->ctx);
    return r < 0 ? -r : r == 0 ? RX_DOS_NOT_FOUND : 0;
}
/* A write request starts (checked once more: switched off, or a volume gone since it arrived). */
static void write_start(rx_session *s) {
    long e; int k, i, j;
    if (!rx_write_on(s)) { req_fail_text(s, "readonly", "writing is off in Transfer"); return; }
    k = s->fs->vols(s->fs->ctx, g_vols, RX_VOLS_MAX);
    if (k < 0) { req_fail_text(s, "io", "cannot read the volume list"); return; }
    if ((i = vol_find(s->req_path, k)) < 0) { req_fail(s, RX_DOS_NOT_FOUND, 1); return; }
    s->req_count = 1;
    switch (s->req_kind) {
    case RX_REQ_MKDIR: e = s->fs->w_mkdir(s->fs->ctx, s->req_path); break;
    case RX_REQ_RENAME:
        if ((j = vol_find(s->req_arg, k)) < 0) { req_fail(s, RX_DOS_NOT_FOUND, 1); return; }
        /* W10: two volumes are two devices; a volume and its own device name are one */
        if (strlen(g_vols[i].device) != strlen(g_vols[j].device) || !ascii_eq_n(g_vols[i].device, g_vols[j].device, (unsigned)strlen(g_vols[i].device))) {
            req_fail_text(s, "xvol", "rename works within one volume"); return;
        }
        e = s->fs->w_rename(s->fs->ctx, s->req_path, s->req_arg); break;
    case RX_REQ_PROTECT: e = s->fs->w_protect(s->fs->ctx, s->req_path, s->req_num); break;
    case RX_REQ_NOTE: e = s->fs->w_note(s->fs->ctx, s->req_path, s->req_arg); break;
    default: {   /* DELETE: a file (or a link) at once; a drawer step by step in req_pump */
        int is_dir = 0, is_link = 0;
        if (s->req_num) {   /* "one" (spec §9; plan ruling X3): AmigaDOS itself refuses a drawer that is not empty */
            if ((e = s->fs->w_delete(s->fs->ctx, s->req_path)) == RX_DOS_NOT_EMPTY) {
                char f[80];
                f[0] = 0; s->fs->fault(s->fs->ctx, e, f, sizeof f);
                s->req_count = 0; req_fail_text(s, "notempty", f[0] ? f : "drawer is not empty"); return;
            }
            break;
        }
        if ((e = entry_kind(s, s->req_path, &is_dir, &is_link)) == 0 && (!is_dir || is_link)) e = s->fs->w_delete(s->fs->ctx, s->req_path);
        else if (e == 0) {
            s->req_count = 0;
            if (s->peer_v >= 5) del_hide(s);   /* spec §9: hidden first; protocol 4 deletes in place as 2.5 */
            s->del_top = (unsigned)strlen(s->req_path); s->del_drawer = 1; return;
        }
        break;
    }
    }
    if (e) { s->req_count = 0; req_fail(s, e, 1); } else req_done(s, 0);
}
static void req_start(rx_session *s) {
    s->req_kind = s->wait_kind; strcpy(s->req_id, s->wait_id); strcpy(s->req_path, s->wait_path);
    strcpy(s->req_arg, s->wait_arg); s->req_num = s->wait_num;
    s->wait_kind = RX_REQ_NONE;
    s->req_i = 0; s->req_count = 0; s->req_open = 0; s->del_drawer = 0; s->del_hidden = 0; s->del_top = (unsigned)strlen(s->req_path);
    if (is_write(s->req_kind)) { write_start(s); return; }
    /* switched off (or no longer trusted) since it was accepted: the owner's word wins (final review 2) */
    if (!rx_browse_on(s)) { req_fail_text(s, "off", "browsing is off in Transfer"); return; }
    if (s->req_kind != RX_REQ_VOLS) {
        int k = vol_known(s, s->req_path);
        if (k < 0) { req_fail_text(s, "io", "cannot read the volume list"); return; }
        if (!k) { req_fail(s, RX_DOS_NOT_FOUND, s->req_kind == RX_REQ_DIR); return; }
    }
    if (s->req_kind == RX_REQ_VOLS) {
        int k = s->fs->vols(s->fs->ctx, g_vols, RX_VOLS_MAX);
        if (k < 0) { req_fail_text(s, "io", "cannot read the volume list"); return; }
        s->req_nvols = k;
    }
    else if (s->req_kind == RX_REQ_DIR) {
        long e = s->fs->dir_open(s->fs->ctx, s->req_path);
        if (e) { req_fail(s, e, 1); return; }
        s->req_open = 1;
    }
    else get_start(s);
}
/* The answer goes out a line at a time, only while the buffer has room for one (spec §2.2 Long drawers): the rest
   waits for the next pass, so memory stays flat however long the answer. */
static void req_pump(rx_session *s) {
    if (s->req_kind == RX_REQ_NONE && s->wait_kind != RX_REQ_NONE && req_idle(s)) req_start(s);
    while (s->req_kind == RX_REQ_VOLS && RX_OUT_MAX - s->out_n >= RX_REQ_ROOM) {
        const rx_vol *v;
        if (s->req_i >= (unsigned)s->req_nvols) { req_done(s, 0); break; }
        v = &g_vols[s->req_i++];
        if (!rx_name_sendable(v->name) || !rx_device_sendable(v->device)) continue;   /* plan rulings T2, T11 */
        puts_(s, "VOL "); puts_(s, s->req_id); puts_(s, " "); put_lenstr(s, v->name); puts_(s, " "); put_lenstr(s, v->device);
        puts_(s, " "); put_dec(s, v->size); puts_(s, " "); put_dec(s, v->free); puts_(s, " ");
        put_date(s, v->days, v->mins, v->ticks); puts_(s, "\n");
        s->req_count++;
    }
    while (s->req_kind == RX_REQ_DIR && RX_OUT_MAX - s->out_n >= RX_REQ_ROOM) {
        static rx_dent e;   /* static: the Amiga's stack is small */
        long r;
        memset(&e, 0, sizeof e);
        r = s->fs->dir_next(s->fs->ctx, &e);
        if (r < 0) { req_fail(s, -r, 1); break; }
        if (r == 0) { req_done(s, 0); break; }
        if (!rx_name_sendable(e.name)) continue;                 /* plan ruling T2 */
        if (s->req_count == RX_ENT_MAX) { req_done(s, 1); break; }   /* a 1001st entry: cut (spec §2.2) */
        put_ent(s, &e);
        s->req_count++;
    }
    { int steps;
      for (steps = 0; steps < RX_DEL_PASS && s->req_kind == RX_REQ_DELETE && s->del_drawer && RX_OUT_MAX - s->out_n >= RX_REQ_ROOM; steps++)
          del_step(s); }
}
static int req_due(const rx_session *s) {
    if (s->req_kind != RX_REQ_NONE) return RX_OUT_MAX - s->out_n >= RX_REQ_ROOM;
    return s->wait_kind != RX_REQ_NONE && req_idle(s);
}
/* An Amiga path to read: "<volume>:<rest>", no control byte. */
static int local_path_ok(const char *p) {
    const char *q;
    if (!p[0] || p[0] == ':' || !strchr(p, ':')) return 0;
    for (q = p; *q; q++) if ((unsigned char)*q < 0x20 || (unsigned char)*q == 0x7f) return 0;
    return 1;
}
static void refuse_req(rx_session *s, int kind, const char *id, const char *path, const char *code, const char *text) {
    req_err(s, id, code, text);
    emit_req(s, kind, id[0] ? id : "-", path, 0, 0, text);
}
static int no_control(const char *p) { for (; *p; p++) if ((unsigned char)*p < 0x20 || (unsigned char)*p == 0x7f) return 0; return 1; }
/* A write request's arguments after its path (protocol 4): RENAME's target, PROTECT's bits, NOTE's comment. */
static int write_args(const rx_session *s, cur *c, int kind, const char *path, char *arg, unsigned long *bits) {
    const char *t; unsigned n;
    arg[0] = 0; *bits = 0;
    if (!rx_abs_path_ok(path)) return 0;   /* a volume and a name: never a volume's root (plan ruling W4) */
    if (kind == RX_REQ_RENAME) return lenstr(c, arg, RX_LOCAL_MAX + 1, 0) && rx_abs_path_ok(arg);
    if (kind == RX_REQ_PROTECT) return tok(c, &t, &n) && num(t, n, 16, bits);
    if (kind == RX_REQ_NOTE) return lenstr(c, arg, RX_COMMENT_MAX + 1, 0) && no_control(arg);
    /* spec §9: protocol 5's "DELETE <rid> <path> one" deletes that object only; on protocol 4 the token is junk */
    if (kind == RX_REQ_DELETE && s->peer_v >= 5 && c->p < c->end) { *bits = 1; return tok(c, &t, &n) && is(t, n, "one"); }
    return 1;
}
/* "VOLS <rid>", "DIR <rid> <len>:<path>", "GET <rid> <len>:<path>", and the writes (protocol 4): refused at once, or
   kept to be answered when nothing moves (at most one waits: plan ruling T6). */
static void on_request(rx_session *s, cur *c, int kind) {
    const char *t; unsigned n; char id[RX_ID_MAX + 1], path[RX_LOCAL_MAX + 1];
    static char arg[RX_LOCAL_MAX + 1]; unsigned long nm = 0;   /* static: the Amiga's stack is small */
    id[0] = 0; path[0] = 0; arg[0] = 0;
    /* no readable id: junk such as a scanner's "GET / HTTP/1.0"; answered, but not the owner's news (final review 4) */
    if (!tok(c, &t, &n) || !id_ok(t, n)) { req_err(s, "", "bad", "bad request"); return; }
    memcpy(id, t, n); id[n] = 0;
    if ((kind != RX_REQ_VOLS && (!lenstr(c, path, sizeof path, 0) || !local_path_ok(path))) ||
        (is_write(kind) && !write_args(s, c, kind, path, arg, &nm)) || c->p < c->end) {
        refuse_req(s, kind, id, path, "bad", "bad request"); return;
    }
    if (is_write(kind) && !rx_write_on(s)) { refuse_req(s, kind, id, path, "readonly", "writing is off in Transfer"); return; }
    if (!rx_browse_on(s)) { refuse_req(s, kind, id, path, "off", "browsing is off in Transfer"); return; }
    if (s->wait_kind != RX_REQ_NONE) { refuse_req(s, kind, id, path, "busy", "another request is waiting"); return; }
    s->wait_kind = kind; strcpy(s->wait_id, id); strcpy(s->wait_path, path); strcpy(s->wait_arg, arg); s->wait_num = nm;
}

/* --- protocol 2: the queue (in memory only: spec §2) --- */
void rx_upq_init(rx_upq *q, const char *trusted) {
    if (q->n <= RX_UP_MAX) rx_upq_clear(q);   /* a queue used before: its items go (spec 2026-10-31 §2.5) */
    memset(q, 0, sizeof *q);
    if (trusted && !hex_key(trusted, (unsigned)strlen(trusted), q->trusted)) q->trusted[0] = 0;
}
void rx_upq_clear(rx_upq *q) { while (q->n) rx_free(q->q[--q->n]); }
static unsigned up_add_at(rx_upq *q, unsigned at, const char *local, const char *name, const char *rid) {
    rx_up_item *it;
    if (q->n >= RX_UP_MAX) { q->why = RX_ADD_FULL; return 0; }
    if (!local[0] || strlen(local) > RX_LOCAL_MAX || !rx_path_ok(name)) { q->why = RX_ADD_NAME; return 0; }
    if (!(it = rx_malloc(sizeof *it))) { q->why = RX_ADD_NOMEM; return 0; }
    q->why = RX_ADD_OK;
    memmove(&q->q[at + 1], &q->q[at], (q->n - at) * sizeof q->q[0]);
    q->n++;
    q->q[at] = it;
    if (++q->next_tag > 999999999U) q->next_tag = 1;   /* the board reads 1-9 digits */
    it->tag = q->next_tag;
    strcpy(it->local, local);
    strcpy(it->name, name);
    strcpy(it->rid, rid);
    return it->tag;
}
unsigned rx_up_add(rx_upq *q, const char *local, const char *name) { return up_add_at(q, q->n, local, name, ""); }
unsigned rx_up_add_front(rx_upq *q, const char *local, const char *name, const char *rid) { return up_add_at(q, 0, local, name, rid); }
int rx_upq_remove(rx_upq *q, unsigned tag) {
    unsigned i;
    for (i = 0; i < q->n; i++) if (q->q[i]->tag == tag) {
        rx_free(q->q[i]);
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
        if (w->added) w->added(w->u, w->q->q[w->q->n - 1]);
    } else if (w->q->why == RX_ADD_NOMEM) w->q->lost++;
    w->local[ll] = 0;
    w->name[nl] = 0;
}
int rx_up_add_tree(rx_upq *q, const rx_fs *fs, const char *local, const char *name, rx_added_fn added, void *u) {
    static rx_walk w;   /* static: the Amiga's stack is small, and a walk is never nested */
    int d;
    q->lost = 0;
    if (strlen(local) > RX_LOCAL_MAX || strlen(name) > RX_PATH_MAX) return -1;
    d = fs->is_dir(fs->ctx, local);
    if (d < 0) return -1;
    if (d == 0) {
        if (!rx_up_add(q, local, name)) { if (q->why == RX_ADD_NOMEM) q->lost = 1; return 0; }
        if (added) added(u, q->q[q->n - 1]);
        return 1;
    }
    memset(&w, 0, sizeof w);
    w.q = q; w.fs = fs; w.added = added; w.u = u;
    strcpy(w.local, local); strcpy(w.name, name);
    if (fs->list(fs->ctx, local, walk_each, &w) != 0) return -1;
    return w.n;
}


/* --- protocol 2: the file going up (spec §3; plan ruling P7) --- */
static int req_due(const rx_session *s);
static void req_pump(rx_session *s);
static void clean(const char *in, char *out, unsigned cap);
static int put_due(const rx_session *s) {
    return s->upq && s->upq->n > 0 && s->up_phase == RX_UP_IDLE && !s->in_data && !s->up_closing && rx_uploads_on(s) &&
           s->req_kind == RX_REQ_NONE && s->wait_kind == RX_REQ_NONE;   /* requests first (plan ruling T5) */
}
/* Ends the file going up: closed, and the front end told. */
static void up_finish(rx_session *s, int kind, const char *text, const char *code, const char *stored) {
    rx_up_item it = s->up_cur;
    unsigned long size = s->up_info.size;
    unsigned long acked = s->up_stored;   /* stored on the web app (PF16): the TAKE offset, then MORE's field; 0 before TAKE */
    s->fs->close_r(s->fs->ctx);
    s->up_phase = RX_UP_IDLE;
    s->up_cancel = 0;
    if (kind == RX_EV_UP_DONE) emit_up(s, kind, &it, stored, size, size, 0, 0);
    else emit_up(s, kind, &it, 0, size, acked, text, code);
}
static void protocol_error(rx_session *s, const char *why) {
    if (s->up_phase != RX_UP_IDLE) up_finish(s, RX_EV_UP_FAILED, why, "local", 0);
    s->proto_err = 1;
}
static void up_put(rx_session *s) {
    while (put_due(s)) {
        rx_up_item it = *s->upq->q[0];
        rx_upq_remove(s->upq, it.tag);
        if (it.rid[0] && !rx_browse_on(s)) {   /* a GOT file, switched off before its turn: never opened (final review 2) */
            req_err(s, it.rid, "off", "browsing is off in Transfer");
            emit_up(s, RX_EV_UP_FAILED, &it, 0, 0, 0, "browsing is off", "local");
            continue;
        }
        memset(&s->up_info, 0, sizeof s->up_info);
        if (s->fs->open_r(s->fs->ctx, it.local, &s->up_info) != 0) {
            if (it.rid[0]) req_err(s, it.rid, "io", "cannot read the file");
            emit_up(s, RX_EV_UP_FAILED, &it, 0, 0, 0, "cannot read the file", "local");
            continue;
        }
        if (s->up_info.size > RX_FILE_MAX) {
            s->fs->close_r(s->fs->ctx);
            if (it.rid[0]) req_err(s, it.rid, "toolarge", "file too large (4 MB at most)");
            emit_up(s, RX_EV_UP_FAILED, &it, 0, s->up_info.size, 0, "file too large (4 MB at most)", "local");
            continue;
        }
        s->up_cur = it; s->up_phase = RX_UP_ASKED; s->up_cancel = 0; s->up_sent = 0; s->up_stored = 0;
        puts_(s, "PUT "); put_dec(s, it.tag); puts_(s, " "); put_dec(s, s->up_info.size); puts_(s, " ");
        put_dec(s, s->up_info.days); puts_(s, "."); put_dec(s, s->up_info.mins); puts_(s, "."); put_dec(s, s->up_info.ticks);
        puts_(s, " "); put_hex(s, s->up_info.prot); puts_(s, " "); put_lenstr(s, it.name); puts_(s, " ");
        { char cm[RX_COMMENT_MAX + 1]; clean(s->up_info.comment, cm, sizeof cm); put_lenstr(s, cm); }
        puts_(s, "\n");
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
    s->up_off = s->up_sent = off; s->up_credit = credit; s->up_stored = off; s->up_crc = 0; s->up_skip = off;
    emit_up(s, RX_EV_UP_BEGIN, &s->up_cur, 0, s->up_info.size, off, 0, 0);
    if (off) s->up_phase = RX_UP_SKIP; else up_data_begins(s);
}
static void on_more(rx_session *s, cur *c) {
    const char *t; unsigned n; unsigned long v, stored;
    if ((s->up_phase != RX_UP_SKIP && s->up_phase != RX_UP_DATA && s->up_phase != RX_UP_ENDED) || !tag_is(s, c)) return;
    if (!tok(c, &t, &n) || !num(t, n, 10, &v) || v > s->up_info.size ||
        !tok(c, &t, &n) || !num(t, n, 10, &stored) || stored > s->up_info.size) {   /* MORE <tag> <credit> <stored> (PF16) */
        protocol_error(s, "the board answered out of range"); return;
    }
    if (v > s->up_credit) s->up_credit = v;
    if (stored > s->up_stored) s->up_stored = stored;
    emit_up(s, RX_EV_UP_PROGRESS, &s->up_cur, 0, s->up_info.size, s->up_stored, 0, 0);
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
    req_pump(s);
    if (s->out_n == 0) up_put(s);
    return (int)take_lines(s, dst, cap);
}
int rx_want_output(const rx_session *s) {
    if (s->up_closing || s->up_phase == RX_UP_SKIP) return 1;
    if (s->up_phase == RX_UP_DATA) return s->up_sent < s->up_credit;
    return s->out_n > 0 || put_due(s) || req_due(s);
}
int rx_up_cancel(rx_session *s, rx_upq *q, unsigned tag) {
    unsigned i;
    for (i = 0; q && i < q->n; i++) if (q->q[i]->tag == tag) {
        rx_up_item it = *q->q[i];
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
int rx_up_reading_ahead(const rx_session *s) { return s->up_phase == RX_UP_SKIP && !s->up_closing; }

/* --- files --- */
/* The drawer part of path, with its separator: "a/b/" of "a/b/c", "Work:" of "Work:c" (protocol 4). */
static void parent_of(const char *path, char *dst) {
    const char *last = strrchr(path, '/'), *colon = strrchr(path, ':');
    if (colon && (!last || colon > last)) last = colon;
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
const char *rx_file_code(long err) {
    switch (err) {
    case 214: return "wprot";
    case 221: return "full";
    case 222: case 223: case 224: return "denied";
    case RX_DOS_IN_USE: return "busy";
    default: return "write";
    }
}
/* The DOS error of the last failed file hook (0 when the glue keeps none). */
static long rx_ferr(const rx_session *s) { return s->fs->err ? s->fs->err(s->fs->ctx) : 0; }
static void fault_text(rx_session *s, long err, const char *dflt, char *out, unsigned cap) {
    char t[80];
    t[0] = 0;
    if (err) s->fs->fault(s->fs->ctx, err, t, sizeof t);
    clean(t[0] ? t : dflt, out, cap);
}
static void fail_file(rx_session *s, const char *code, const char *text) {
    if (s->cur_open) { s->fs->close_w(s->fs->ctx); s->cur_open = 0; }
    s->fs->remove(s->fs->ctx, s->cur_tmp);
    reply_err(s, s->cur_id, code, text);
    s->in_data = 0;
    emit(s, RX_EV_FAILED, s->cur_id, s->cur_path, s->cur_size, 0, text);
}
/* An absolute FILE's failure: the code and AmigaDOS's words for the DOS error (plan ruling W9). */
static void fail_file_err(rx_session *s, long err, const char *dflt) {
    char t[80];
    fault_text(s, err, dflt, t, sizeof t);
    fail_file(s, rx_file_code(err), t);
}
static void finish_file(rx_session *s) {
    char saved[RX_PATH_MAX + 1], digits[12];
    unsigned n;
    int closed = s->fs->close_w(s->fs->ctx);
    long cerr = closed != 0 ? rx_ferr(s) : 0;
    s->cur_open = 0;
    if (s->cur_write_failed || closed != 0) {
        if (s->cur_mode) fail_file_err(s, s->cur_write_failed ? s->cur_err : cerr, "cannot write");
        else fail_file(s, "write", "cannot write");
        return;
    }
    if (s->cur_crc != s->cur_crc_want) { fail_file(s, "crc", "checksum mismatch"); return; }
    if (s->cur_mode == RX_MODE_REPLACE) {   /* spec §2.2: the old file goes only now, after the CRC matched */
        strcpy(saved, s->cur_path);
        if (s->fs->exists(s->fs->ctx, saved) && s->fs->remove(s->fs->ctx, saved) != 0) { fail_file_err(s, rx_ferr(s), "cannot delete"); return; }
        if (s->fs->rename(s->fs->ctx, s->cur_tmp, saved) != 0) {
            /* The old file is gone: the new one must not go too (final review I1). A free name, as keep does; failing
               that, the temporary file stays and the answer says where. */
            long e = rx_ferr(s);
            for (n = 2; n <= 99; n++) {
                if (rx_candidate(s->cur_path, n, saved) != 0) { n = 100; break; }
                if (!s->fs->exists(s->fs->ctx, saved) && s->fs->rename(s->fs->ctx, s->cur_tmp, saved) == 0) break;
            }
            if (n > 99) {
                static char t[80 + sizeof s->cur_tmp + 20];
                fault_text(s, e, "cannot write", t, 80);
                strcat(t, "; the new copy is "); strcat(t, s->cur_tmp);
                reply_err(s, s->cur_id, rx_file_code(e), t);
                s->in_data = 0;
                emit(s, RX_EV_FAILED, s->cur_id, s->cur_path, s->cur_size, 0, t);
                return;
            }
        }
        n = 1;
    } else for (n = 1; n <= 99; n++) {
        if (rx_candidate(s->cur_path, n, saved) != 0) { n = 100; break; }
        if (!s->fs->exists(s->fs->ctx, saved)) break;
    }
    if (n > 99) { fail_file(s, "name", "no free name"); return; }
    if (s->cur_mode != RX_MODE_REPLACE && s->fs->rename(s->fs->ctx, s->cur_tmp, saved) != 0) {
        if (s->cur_mode) fail_file_err(s, rx_ferr(s), "cannot write"); else fail_file(s, "write", "cannot write");
        return;
    }
    s->fs->set_meta(s->fs->ctx, saved, s->cur_prot, s->cur_comment);
    puts_(s, "OK "); puts_(s, s->cur_id); puts_(s, " ");
    rx_utoa((unsigned long)strlen(saved), digits); puts_(s, digits); puts_(s, ":"); puts_(s, saved); puts_(s, "\n");
    s->in_data = 0;
    emit(s, RX_EV_DONE, s->cur_id, saved, s->cur_size, s->cur_size, 0);
}

static int vol_known(rx_session *s, const char *path);
/* An absolute FILE (protocol 4, spec 2026-10-31 §2.2): checked, then the temporary file opened in the target drawer.
   0: GO may follow; -1: answered (refused or skipped). */
static int abs_file_start(rx_session *s, const char *id, unsigned long size) {
    rx_finfo info; int is_dir = 0, k; unsigned long fr; char t[80];
    if (!rx_abs_path_ok(s->cur_path)) { refuse(s, id, s->cur_path, "name", "bad name"); return -1; }
    if (!rx_write_on(s)) { refuse(s, id, s->cur_path, "readonly", "writing is off in Transfer"); return -1; }
    k = vol_known(s, s->cur_path);
    if (k < 0) { refuse(s, id, s->cur_path, "folder", "cannot read the volume list"); return -1; }
    if (!k) { refuse(s, id, s->cur_path, "folder", "no such volume"); return -1; }
    memset(&info, 0, sizeof info);
    k = (int)s->fs->stat(s->fs->ctx, s->cur_path, &info, &is_dir);
    if (k == 0 || k == RX_DOS_IN_USE) {   /* in use (open for writing): it cannot be examined, but it exists */
        if (k) is_dir = 0;
        if (s->cur_mode == RX_MODE_SKIP) {
            puts_(s, "SKIP "); puts_(s, id); puts_(s, "\n");
            emit(s, RX_EV_SKIP, id, s->cur_path, size, 0, 0);
            return -1;
        }
        if (is_dir && s->cur_mode == RX_MODE_REPLACE) { refuse(s, id, s->cur_path, "denied", "a drawer has that name"); return -1; }
    }
    fr = s->fs->free_at(s->fs->ctx, s->cur_path);
    if (fr < 8192UL || fr - 8192UL < size) { refuse(s, id, s->cur_path, "full", "not enough space"); return -1; }
    if (make_parents(s, s->cur_path) != 0) {
        long e = rx_ferr(s);
        fault_text(s, e, "cannot create folder", t, sizeof t); refuse(s, id, s->cur_path, rx_file_code(e), t); return -1;
    }
    parent_of(s->cur_path, s->cur_tmp);
    strcat(s->cur_tmp, RX_TMP_NAME);
    if (s->fs->open_w(s->fs->ctx, s->cur_tmp) != 0) {
        long e = rx_ferr(s);
        fault_text(s, e, "cannot write", t, sizeof t); refuse(s, id, s->cur_path, rx_file_code(e), t); return -1;
    }
    return 0;
}
static void on_file(rx_session *s, cur *c) {
    const char *t; unsigned n;
    unsigned long size, crc, prot;
    char id[RX_ID_MAX + 1];
    int mode = RX_MODE_NONE;
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
    if (c->p < c->end) {   /* protocol 4: keep|replace|skip, and nothing after it */
        if (!tok(c, &t, &n)) mode = -1;
        else if (is(t, n, "keep")) mode = RX_MODE_KEEP;
        else if (is(t, n, "replace")) mode = RX_MODE_REPLACE;
        else if (is(t, n, "skip")) mode = RX_MODE_SKIP;
        else mode = -1;
        if (c->p < c->end) mode = -1;
    }
    /* plan ruling W2: an absolute path needs a mode, and a mode an absolute path */
    if (mode < 0 || (mode != RX_MODE_NONE) != (strchr(s->cur_path, ':') != NULL)) { refuse(s, id, s->cur_path, "name", "bad request"); return; }
    s->cur_mode = mode;
    if (mode) {
        if (abs_file_start(s, id, size) != 0) return;
    } else {
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
    }
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
    else if (is(t, n, "VOLS")) on_request(s, &c, RX_REQ_VOLS);
    else if (is(t, n, "DIR")) on_request(s, &c, RX_REQ_DIR);
    else if (is(t, n, "GET")) on_request(s, &c, RX_REQ_GET);
    else if (is(t, n, "MKDIR")) on_request(s, &c, RX_REQ_MKDIR);
    else if (is(t, n, "RENAME")) on_request(s, &c, RX_REQ_RENAME);
    else if (is(t, n, "DELETE")) on_request(s, &c, RX_REQ_DELETE);
    else if (is(t, n, "PROTECT")) on_request(s, &c, RX_REQ_PROTECT);
    else if (is(t, n, "NOTE")) on_request(s, &c, RX_REQ_NOTE);
    /* anything else: ignored, for newer boards and stray clients */
}

int rx_feed(rx_session *s, const unsigned char *data, unsigned long n) {
    while (n) {
        if (s->in_data) {
            unsigned long done0 = s->cur_size - s->cur_left;
            unsigned long room = PROGRESS_STEP - (done0 % PROGRESS_STEP);   /* cross one 16 KB mark per pass */
            unsigned long take = n < s->cur_left ? n : s->cur_left;
            if (take > room) take = room;
            if (!s->cur_write_failed && s->fs->write(s->fs->ctx, data, take) != 0) { s->cur_write_failed = 1; s->cur_err = rx_ferr(s); }
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
    if (s->req_kind == RX_REQ_DELETE) {   /* a walk mid-way: back to its name (X4), and the owner hears the named path */
        static char where[80];
        if (del_unhide(s, where, sizeof where)) { cat(where, sizeof where, ": connection lost"); }
        else strcpy(where, "connection lost");
        emit_req(s, s->req_kind, s->req_id, s->req_path, s->req_count, 0, where); req_end(s);
    }
    if (s->req_kind != RX_REQ_NONE) { emit_req(s, s->req_kind, s->req_id, s->req_path, s->req_count, 0, "connection lost"); req_end(s); }
    s->wait_kind = RX_REQ_NONE; s->hello_browse = 0;
    if (s->upq) {   /* a GET's file not yet gone up: after a reconnect the board no longer knows its tag (ruling T4) */
        unsigned i = s->upq->n;
        while (i-- > 0) if (s->upq->q[i]->rid[0]) {
            rx_up_item it = *s->upq->q[i];
            rx_upq_remove(s->upq, it.tag);
            emit_up(s, RX_EV_UP_FAILED, &it, 0, 0, 0, "connection lost", "local");
        }
    }
    s->up_closing = 0; s->proto_err = 0;
    s->peer_v = 0; s->trust = RX_TRUST_NONE;
    s->line_n = 0; s->list_expect = 0; s->out_n = 0;
}
