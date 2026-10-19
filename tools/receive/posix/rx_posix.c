/* Receive's host front end: the core over BSD sockets and POSIX files. For tests and CI, not for users.
   Usage: rx_posix <folder> <port> [<key file>]   (port 0 = any; prints "LISTEN <port>")
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
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <time.h>
#include <unistd.h>
#include "rx_proto.h"

typedef struct { const char *root; FILE *fh; FILE *rh; } pctx;

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
static int p_is_dir(void *x, const char *local) { struct stat st; (void)x; if (stat(local, &st) != 0) return -1; return S_ISDIR(st.st_mode) ? 1 : 0; }
static int p_list(void *x, const char *local, rx_list_fn each, void *u) {
    DIR *d = opendir(local); struct dirent *e; char p[1024]; struct stat st;
    (void)x;
    if (!d) return -1;
    while ((e = readdir(d)) != NULL) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        snprintf(p, sizeof p, "%s/%s", local, e->d_name);
        if (stat(p, &st) != 0) continue;
        each(u, e->d_name, S_ISDIR(st.st_mode));   /* host names as they are: the scenarios' drawers are ASCII */
    }
    closedir(d);
    return 0;
}
static int p_open_r(void *x, const char *local, rx_finfo *info) {
    pctx *c = x; struct stat st;
    if (stat(local, &st) != 0 || S_ISDIR(st.st_mode)) return -1;
    c->rh = fopen(local, "rb");
    if (!c->rh) return -1;
    long t = (long)st.st_mtime - 252460800L;   /* AmigaDOS counts from 1978-01-01 */
    if (t < 0) t = 0;
    info->size = (unsigned long)st.st_size; info->prot = 0;
    info->days = (unsigned long)(t / 86400); info->mins = (unsigned long)(t % 86400 / 60); info->ticks = (unsigned long)(t % 60 * 50);
    info->comment[0] = 0;
    return 0;
}
static long p_read(void *x, unsigned char *b, unsigned long n) { size_t k = fread(b, 1, n, ((pctx *)x)->rh); return ferror(((pctx *)x)->rh) ? -1 : (long)k; }
static void p_close_r(void *x) { pctx *c = x; if (c->rh) { fclose(c->rh); c->rh = NULL; } }

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
    }
}

int main(int argc, char **argv) {
    static rx_session S;
    static rx_upq Q;
    static unsigned char buf[8192];
    static char o[8192], in[1024];
    static unsigned in_n;
    pctx ctx = { 0 };
    rx_fs fs = { &ctx, p_folder_ok, p_free, p_exists, p_make_dir, p_open_w, p_write, p_close_w, p_rename, p_remove, p_set_meta,
                 p_is_dir, p_list, p_open_r, p_read, p_close_r };
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
