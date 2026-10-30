/* Receive's host front end: the core over BSD sockets and POSIX files. For tests and CI, not for users.
   Usage: rx_posix <folder> <port> [<key file>]   (port 0 = any; prints "LISTEN <port>")
   env: RX_VOLS="<name>|<device>|<host folder>;..." (protocol 3 volumes), RX_BROWSE=1 (browsing on at start);
   stdin also: "BROWSE 1" / "BROWSE 0" (spec 2026-10-30 §2.3).
   stdin: "SEND <host path>" (a file or a folder, as a drop), "TRUST", "CANCEL <tag>" (protocol 2, spec 2026-10-18). */
#define _POSIX_C_SOURCE 200809L
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <time.h>
#include <unistd.h>
#include "rx_proto.h"

typedef struct { const char *root; FILE *fh; FILE *rh; DIR *dh; char dpath[1024]; } pctx;

/* folder + "/" + rel, with Latin-1 bytes >= 0x80 as UTF-8 (a host name must be UTF-8 on macOS). */
static void join(pctx *c, const char *rel, char *out, size_t cap) {
    size_t n = (size_t)snprintf(out, cap, "%s/", c->root);
    for (const unsigned char *p = (const unsigned char *)rel; *p && n + 3 < cap; p++) {
        if (*p < 0x80) out[n++] = (char)*p;
        else { out[n++] = (char)(0xC0 | (*p >> 6)); out[n++] = (char)(0x80 | (*p & 0x3F)); }
    }
    out[n] = 0;
}
/* A host name (UTF-8) as the Amiga would name it (Latin-1): two-byte sequences up to U+00FF, anything else '_'. */
static void to_latin1(const char *in, char *out, size_t cap) {
    size_t n = 0;
    for (const unsigned char *p = (const unsigned char *)in; *p && n + 1 < cap; ) {
        if (*p < 0x80) out[n++] = (char)*p++;
        else if ((*p == 0xC2 || *p == 0xC3) && (p[1] & 0xC0) == 0x80) { out[n++] = (char)(((*p & 3) << 6) | (p[1] & 0x3F)); p += 2; }
        else { out[n++] = '_'; p++; while ((*p & 0xC0) == 0x80) p++; }
    }
    out[n] = 0;
}
/* Protocol 3: the volumes this host build pretends to have (RX_VOLS). "Work:x/y" or "DF2:x" is that folder's x/y. */
typedef struct { char name[64], dev[32], dir[512]; } pvol;
static pvol g_vols[8]; static int g_nvols;
static void vols_load(void) {
    const char *e = getenv("RX_VOLS"); char buf[4096], *p, *save = NULL;
    if (!e) return;
    snprintf(buf, sizeof buf, "%s", e);
    for (p = strtok_r(buf, ";", &save); p && g_nvols < 8; p = strtok_r(NULL, ";", &save)) {
        char *a = strchr(p, '|'), *b = a ? strchr(a + 1, '|') : NULL;
        if (!a || !b) continue;
        *a = 0; *b = 0;
        snprintf(g_vols[g_nvols].name, 64, "%s", p); snprintf(g_vols[g_nvols].dev, 32, "%s", a + 1);
        snprintf(g_vols[g_nvols].dir, 512, "%s", b + 1);
        g_nvols++;
    }
}
/* An Amiga path as a host path; a path without ':' is a host path already (SEND). -1: no such volume. The first
   volume of a name wins, as in AmigaDOS. */
static int host_path(const char *local, char *out, size_t cap) {
    const char *colon = strchr(local, ':');
    if (!colon) { snprintf(out, cap, "%s", local); return 0; }
    size_t n = (size_t)(colon - local);
    for (int i = 0; i < g_nvols; i++) {
        size_t dn = strlen(g_vols[i].dev) - 1;
        if ((strlen(g_vols[i].name) == n && strncasecmp(g_vols[i].name, local, n) == 0) ||
            (dn == n && strncasecmp(g_vols[i].dev, local, n) == 0)) {
            snprintf(out, cap, "%s/%s", g_vols[i].dir, colon + 1);
            return 0;
        }
    }
    return -1;
}
static void amiga_date(time_t mtime, unsigned long *d, unsigned long *m, unsigned long *t) {
    long s = (long)mtime - 252460800L;   /* AmigaDOS counts from 1978-01-01 */
    if (s < 0) s = 0;
    *d = (unsigned long)(s / 86400); *m = (unsigned long)(s % 86400 / 60); *t = (unsigned long)(s % 60 * 50);
}
static int p_folder_ok(void *x) { struct stat st; return stat(((pctx *)x)->root, &st) == 0 && S_ISDIR(st.st_mode); }
static unsigned long p_free(void *x) {
    const char *e = getenv("RX_FREE_BYTES");
    struct statvfs v;
    if (e) return strtoul(e, NULL, 10);
    if (statvfs(((pctx *)x)->root, &v) != 0) return 0xFFFFFFFFUL;
    unsigned long long f = (unsigned long long)v.f_bavail * v.f_frsize;
    return f > 0xFFFFFFFFULL ? 0xFFFFFFFFUL : (unsigned long)f;
}
static int p_exists(void *x, const char *rel) { char p[1024]; struct stat st; join(x, rel, p, sizeof p); return lstat(p, &st) == 0; }
static int p_make_dir(void *x, const char *rel) {
    char p[1024]; struct stat st; join(x, rel, p, sizeof p);
    if (mkdir(p, 0755) == 0) return 0;
    return (errno == EEXIST && stat(p, &st) == 0 && S_ISDIR(st.st_mode)) ? 0 : -1;
}
static int p_open_w(void *x, const char *rel) { pctx *c = x; char p[1024]; join(c, rel, p, sizeof p); c->fh = fopen(p, "wb"); return c->fh ? 0 : -1; }
static int p_write(void *x, const unsigned char *b, unsigned long n) { return fwrite(b, 1, n, ((pctx *)x)->fh) == n ? 0 : -1; }
static int p_close_w(void *x) { pctx *c = x; int r = fclose(c->fh); c->fh = NULL; return r == 0 ? 0 : -1; }
static int p_rename(void *x, const char *from, const char *to) {
    char a[1024], b[1024]; join(x, from, a, sizeof a); join(x, to, b, sizeof b);
    if (access(b, F_OK) == 0) return -1;
    return rename(a, b) == 0 ? 0 : -1;
}
static int p_remove(void *x, const char *rel) { char p[1024]; join(x, rel, p, sizeof p); return unlink(p) == 0 ? 0 : -1; }
static int p_set_meta(void *x, const char *rel, unsigned long prot, const char *comment) {
    (void)x; printf("META %s %lx %s\n", rel, prot, comment); return 0;
}
/* Protocol 2: host paths are given as they are (absolute or from the working folder). */
static int p_is_dir(void *x, const char *local) {
    struct stat st; char hp[1024]; (void)x;
    if (host_path(local, hp, sizeof hp) != 0 || stat(hp, &st) != 0) return -1; return S_ISDIR(st.st_mode) ? 1 : 0; }
static int p_list(void *x, const char *local, rx_list_fn each, void *u) {
    DIR *d; struct dirent *e; char p[1024], hp[1024]; struct stat st;
    (void)x;
    if (host_path(local, hp, sizeof hp) != 0 || !(d = opendir(hp))) return -1;
    while ((e = readdir(d)) != NULL) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        snprintf(p, sizeof p, "%s/%s", hp, e->d_name);
        if (stat(p, &st) != 0) continue;
        each(u, e->d_name, S_ISDIR(st.st_mode));   /* host names as they are: the scenarios' drawers are ASCII */
    }
    closedir(d);
    return 0;
}
static int p_open_r(void *x, const char *local, rx_finfo *info) {
    pctx *c = x; struct stat st; char hp[1024];
    if (host_path(local, hp, sizeof hp) != 0 || stat(hp, &st) != 0 || S_ISDIR(st.st_mode)) return -1;
    c->rh = fopen(hp, "rb");
    if (!c->rh) return -1;
    info->size = (unsigned long)st.st_size; info->prot = 0;
    amiga_date(st.st_mtime, &info->days, &info->mins, &info->ticks);
    info->comment[0] = 0;
    return 0;
}
static long p_read(void *x, unsigned char *b, unsigned long n) { size_t k = fread(b, 1, n, ((pctx *)x)->rh); return ferror(((pctx *)x)->rh) ? -1 : (long)k; }
static void p_close_r(void *x) { pctx *c = x; if (c->rh) { fclose(c->rh); c->rh = NULL; } }

static int p_vols(void *x, rx_vol *out, int max) {
    (void)x;
    int n = g_nvols < max ? g_nvols : max;
    for (int i = 0; i < n; i++) {
        memset(&out[i], 0, sizeof out[i]);
        snprintf(out[i].name, sizeof out[i].name, "%s", g_vols[i].name);
        snprintf(out[i].device, sizeof out[i].device, "%s", g_vols[i].dev);
        out[i].size = 901120; out[i].free = 450560; out[i].days = 17000;
    }
    return n;
}
static long p_dir_open(void *x, const char *path) {
    pctx *c = x; struct stat st;
    if (host_path(path, c->dpath, sizeof c->dpath) != 0 || stat(c->dpath, &st) != 0) return RX_DOS_NOT_FOUND;
    if (!S_ISDIR(st.st_mode)) return RX_DOS_WRONG_TYPE;
    c->dh = opendir(c->dpath);
    return c->dh ? 0 : RX_DOS_READ_PROTECTED;
}
static long p_dir_next(void *x, rx_dent *e) {
    pctx *c = x; struct dirent *d; char p[1200]; struct stat st;
    while ((d = readdir(c->dh)) != NULL) {
        if (!strcmp(d->d_name, ".") || !strcmp(d->d_name, "..")) continue;
        snprintf(p, sizeof p, "%s/%s", c->dpath, d->d_name);
        if (stat(p, &st) != 0) continue;
        memset(e, 0, sizeof *e);
        to_latin1(d->d_name, e->name, sizeof e->name);
        e->is_dir = S_ISDIR(st.st_mode); e->size = e->is_dir ? 0 : (unsigned long)st.st_size;
        amiga_date(st.st_mtime, &e->days, &e->mins, &e->ticks);
        return 1;
    }
    return 0;
}
static void p_dir_close(void *x) { pctx *c = x; if (c->dh) { closedir(c->dh); c->dh = NULL; } }
static long p_stat(void *x, const char *path, rx_finfo *info, int *is_dir) {
    char hp[1024]; struct stat st;
    (void)x;
    if (host_path(path, hp, sizeof hp) != 0 || stat(hp, &st) != 0) return RX_DOS_NOT_FOUND;
    *is_dir = S_ISDIR(st.st_mode);
    info->size = (unsigned long)st.st_size; info->prot = access(hp, R_OK) == 0 ? 0 : 8;
    amiga_date(st.st_mtime, &info->days, &info->mins, &info->ticks);
    info->comment[0] = 0;
    return 0;
}
static void p_fault(void *x, long err, char *text, unsigned cap) {
    (void)x;
    if (err == RX_DOS_NOT_FOUND) snprintf(text, cap, "object not found");
    else if (err == RX_DOS_WRONG_TYPE) snprintf(text, cap, "object is wrong type");
    else if (err == RX_DOS_READ_PROTECTED) snprintf(text, cap, "file is read protected");
    else snprintf(text, cap, "error %ld", err);
}

static const char *g_keyfile;
static void on_event(void *u, const rx_event *e) {
    rx_session *s = u;
    char k4[5];
    switch (e->kind) {
    case RX_EV_HELLO: printf("HELLO\n"); break;
    case RX_EV_LIST: printf("LIST %u\n", s->list_n); break;
    case RX_EV_BEGIN: printf("BEGIN %s %s\n", e->id, e->path); break;
    case RX_EV_DONE: printf("DONE %s %s\n", e->id, e->path); break;
    case RX_EV_FAILED: printf("FAILED %s %s\n", e->id, e->text); break;
    case RX_EV_TRUST:
        rx_key4(e->key, k4);
        printf("TRUST %s %s\n", e->code, k4);
        if (!strcmp(e->code, "new") && g_keyfile) { FILE *f = fopen(g_keyfile, "w"); if (f) { fprintf(f, "%s\n", e->key); fclose(f); } }
        break;
    case RX_EV_UP_BEGIN: printf("UP_BEGIN %u %s %lu\n", e->tag, e->path, e->bytes); break;
    case RX_EV_UP_DONE: printf("UP_DONE %u %s\n", e->tag, e->path); break;
    case RX_EV_UP_FAILED: printf("UP_FAILED %u %s %s\n", e->tag, e->code ? e->code : "-", e->text ? e->text : ""); break;
    case RX_EV_REQ:
        printf("REQ %s %s %lu%s %s\n", e->code, e->path && e->path[0] ? e->path : "-", e->size, e->bytes ? " cut" : "",
               e->text ? e->text : "ok");
        break;
    default: break;
    }
}
static int send_all(int fd, const char *p, size_t n) {
    while (n) { ssize_t w = send(fd, p, n, 0); if (w <= 0) return -1; p += w; n -= (size_t)w; }
    return 0;
}
static void on_added(void *u, const rx_up_item *it) { (void)u; printf("QUEUED %u %s\n", it->tag, it->name); }

/* One stdin command. */
static void command(char *l, rx_upq *q, rx_fs *fs, rx_session *s, int connected) {
    size_t n = strlen(l);
    while (n && (l[n - 1] == '\n' || l[n - 1] == '\r')) l[--n] = 0;
    if (!strncmp(l, "SEND ", 5)) {
        const char *p = l + 5, *base = strrchr(p, '/');
        char name[256];
        to_latin1(base ? base + 1 : p, name, sizeof name);
        if (rx_up_add_tree(q, fs, p, name, on_added, NULL) <= 0) printf("UP_FAILED 0 local cannot read %s\n", p);
    } else if (!strcmp(l, "TRUST")) {
        if (!connected || rx_trust_now(s) != 0) q->trust_next = 1;
    } else if (!strncmp(l, "CANCEL ", 7)) {
        rx_up_cancel(s, q, (unsigned)strtoul(l + 7, NULL, 10));
    } else if (!strcmp(l, "BROWSE 1") || !strcmp(l, "BROWSE 0")) q->browse = l[7] == '1';
}

int main(int argc, char **argv) {
    static rx_session S;
    static rx_upq Q;
    static unsigned char buf[8192];
    static char o[8192], in[1024];
    static unsigned in_n;
    pctx ctx = { 0 };
    rx_fs fs = { &ctx, p_folder_ok, p_free, p_exists, p_make_dir, p_open_w, p_write, p_close_w, p_rename, p_remove, p_set_meta,
                 p_is_dir, p_list, p_open_r, p_read, p_close_r,
                 p_vols, p_dir_open, p_dir_next, p_dir_close, p_stat, p_fault };   /* protocol 3, used only while Q.browse */
    struct sockaddr_in a;
    socklen_t al = sizeof a;
    int one = 1, ls, cl = -1, stdin_open = 1;
    time_t last = 0;
    long idle_env = getenv("RX_IDLE_SECS") ? atol(getenv("RX_IDLE_SECS")) : 0;
    char key[80] = "";
    if (argc != 3 && argc != 4) { fprintf(stderr, "usage: rx_posix <folder> <port> [<key file>]\n"); return 2; }
    setvbuf(stdout, NULL, _IOLBF, 0);
    signal(SIGPIPE, SIG_IGN);   /* a board that dropped mid-file must be an error from send(), not a death */
    ctx.root = argv[1];
    if (argc == 4) {
        FILE *f = fopen(argv[3], "r");
        g_keyfile = argv[3];
        if (f) { if (fgets(key, sizeof key, f)) key[strcspn(key, "\r\n")] = 0; fclose(f); }
    }
    rx_upq_init(&Q, key);
    vols_load();
    Q.browse = getenv("RX_BROWSE") && getenv("RX_BROWSE")[0] == '1';
    rx_init(&S, &fs, on_event, &S);
    ls = socket(AF_INET, SOCK_STREAM, 0);
    setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(0x7F000001UL) /* 127.0.0.1; INADDR_LOOPBACK is hidden by _POSIX_C_SOURCE on macOS */; a.sin_port = htons((unsigned short)atoi(argv[2]));
    if (bind(ls, (struct sockaddr *)&a, sizeof a) != 0 || listen(ls, 2) != 0) { perror("listen"); return 1; }
    getsockname(ls, (struct sockaddr *)&a, &al);
    printf("LISTEN %d\n", ntohs(a.sin_port));
    for (;;) {
        fd_set r;
        int maxfd = ls, bad = 0;
        FD_ZERO(&r); FD_SET(ls, &r);
        if (stdin_open) FD_SET(0, &r);
        if (cl >= 0) { FD_SET(cl, &r); if (cl > maxfd) maxfd = cl; }
        struct timeval tv = { (cl >= 0 && rx_want_output(&S)) ? 0 : 1, 0 };
        if (select(maxfd + 1, &r, NULL, NULL, &tv) < 0) { if (errno == EINTR) continue; return 1; }
        if (stdin_open && FD_ISSET(0, &r)) {
            ssize_t k = read(0, in + in_n, sizeof in - 1 - in_n);
            if (k <= 0) stdin_open = 0;
            else {
                char *nl;
                in_n += (unsigned)k; in[in_n] = 0;
                while ((nl = strchr(in, '\n')) != NULL) {
                    *nl = 0; command(in, &Q, &fs, &S, cl >= 0);
                    memmove(in, nl + 1, strlen(nl + 1) + 1); in_n = (unsigned)strlen(in);
                }
            }
        }
        /* A resume's pre-read is our own silence, not the board's: it does not count (as net.c). */
        if (cl >= 0 && rx_up_reading_ahead(&S)) last = time(NULL);
        /* A peer that went silent (a rebooted board sends no FIN; a scanner just waits) must not hold the slot. */
        if (cl >= 0 && !FD_ISSET(cl, &r) && time(NULL) - last > (idle_env ? idle_env : rx_idle_secs(&S))) {
            rx_disconnected(&S); close(cl); cl = -1; continue;
        }
        /* The connection first: a board's close (EOF) is handled before its reconnect is accepted. */
        if (cl >= 0 && FD_ISSET(cl, &r)) {
            ssize_t n = recv(cl, buf, sizeof buf, 0);
            bad = n <= 0 || rx_feed(&S, buf, (unsigned long)n) != 0;
            last = time(NULL);
        }
        if (cl >= 0 && !bad) {
            while (!bad && rx_want_output(&S)) {
                int k = rx_take_output(&S, o, sizeof o);
                if (k < 0) bad = 1;
                else if (k > 0 && send_all(cl, o, (size_t)k) != 0) bad = 1;
            }
        }
        if (cl >= 0 && !bad && rx_hello_stale(&S)) bad = 1;   /* the switch changed: the board reconnects (ruling T1) */
        if (cl >= 0 && bad) { rx_disconnected(&S); close(cl); cl = -1; }
        if (FD_ISSET(ls, &r)) {
            int ns = accept(ls, NULL, NULL);
            if (ns >= 0) {
                if (cl >= 0) { send_all(ns, "ERR - busy receiver busy\n", 25); close(ns); }
                else { cl = ns; last = time(NULL); rx_init(&S, &fs, on_event, &S); rx_attach(&S, &Q); }
            }
        }
    }
}
