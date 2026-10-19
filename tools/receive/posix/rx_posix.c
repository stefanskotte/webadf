/* Receive's host front end: the core over BSD sockets and POSIX files. For tests and CI, not for users.
   Usage: rx_posix <folder> <port>   (port 0 = any; prints "LISTEN <port>") */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <time.h>
#include <unistd.h>
#include "rx_proto.h"

typedef struct { const char *root; FILE *fh; } pctx;

/* folder + "/" + rel, with Latin-1 bytes >= 0x80 as UTF-8 (a host name must be UTF-8 on macOS). */
static void join(pctx *c, const char *rel, char *out, size_t cap) {
    size_t n = (size_t)snprintf(out, cap, "%s/", c->root);
    for (const unsigned char *p = (const unsigned char *)rel; *p && n + 3 < cap; p++) {
        if (*p < 0x80) out[n++] = (char)*p;
        else { out[n++] = (char)(0xC0 | (*p >> 6)); out[n++] = (char)(0x80 | (*p & 0x3F)); }
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
static void on_event(void *u, const rx_event *e) {
    rx_session *s = u;
    switch (e->kind) {
    case RX_EV_HELLO: printf("HELLO\n"); break;
    case RX_EV_LIST: printf("LIST %u\n", s->list_n); break;
    case RX_EV_BEGIN: printf("BEGIN %s %s\n", e->id, e->path); break;
    case RX_EV_DONE: printf("DONE %s %s\n", e->id, e->path); break;
    case RX_EV_FAILED: printf("FAILED %s %s\n", e->id, e->text); break;
    default: break;
    }
}
static int send_all(int fd, const char *p, size_t n) {
    while (n) { ssize_t w = send(fd, p, n, 0); if (w <= 0) return -1; p += w; n -= (size_t)w; }
    return 0;
}

int main(int argc, char **argv) {
    static rx_session S;
    static unsigned char buf[8192];
    pctx ctx = { 0 };
    rx_fs fs = { &ctx, p_folder_ok, p_free, p_exists, p_make_dir, p_open_w, p_write, p_close_w, p_rename, p_remove, p_set_meta, NULL, NULL, NULL, NULL, NULL };   /* the read side (protocol 2) arrives with the Amiga front ends */
    struct sockaddr_in a;
    socklen_t al = sizeof a;
    int one = 1, ls, cl = -1;
    time_t last = 0;
    long idle = getenv("RX_IDLE_SECS") ? atol(getenv("RX_IDLE_SECS")) : RX_IDLE_SECS;
    if (argc != 3) { fprintf(stderr, "usage: rx_posix <folder> <port>\n"); return 2; }
    setvbuf(stdout, NULL, _IOLBF, 0);
    ctx.root = argv[1];
    ls = socket(AF_INET, SOCK_STREAM, 0);
    setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(0x7F000001UL) /* 127.0.0.1; INADDR_LOOPBACK is hidden by _POSIX_C_SOURCE on macOS */; a.sin_port = htons((unsigned short)atoi(argv[2]));
    if (bind(ls, (struct sockaddr *)&a, sizeof a) != 0 || listen(ls, 2) != 0) { perror("listen"); return 1; }
    getsockname(ls, (struct sockaddr *)&a, &al);
    printf("LISTEN %d\n", ntohs(a.sin_port));
    for (;;) {
        fd_set r;
        int maxfd = ls;
        FD_ZERO(&r); FD_SET(ls, &r);
        if (cl >= 0) { FD_SET(cl, &r); if (cl > maxfd) maxfd = cl; }
        struct timeval tv = { 1, 0 };
        if (select(maxfd + 1, &r, NULL, NULL, &tv) < 0) { if (errno == EINTR) continue; return 1; }
        /* A peer that went silent (a rebooted board sends no FIN; a scanner just waits) must not hold the slot. */
        if (cl >= 0 && !FD_ISSET(cl, &r) && time(NULL) - last > idle) { rx_disconnected(&S); close(cl); cl = -1; continue; }
        /* The connection first: a board's close (EOF) is handled before its reconnect is accepted. */
        if (cl >= 0 && FD_ISSET(cl, &r)) {
            ssize_t n = recv(cl, buf, sizeof buf, 0);
            int bad = n <= 0 || rx_feed(&S, buf, (unsigned long)n) != 0;
            last = time(NULL);
            char o[RX_OUT_MAX];
            while (!bad && rx_want_output(&S)) {
                int k = rx_take_output(&S, o, sizeof o);
                if (k < 0) bad = 1;
                else if (k > 0 && send_all(cl, o, (size_t)k) != 0) bad = 1;
            }
            if (bad) { rx_disconnected(&S); close(cl); cl = -1; }
        }
        if (FD_ISSET(ls, &r)) {
            int ns = accept(ls, NULL, NULL);
            if (ns >= 0) {
                if (cl >= 0) { send_all(ns, "ERR - busy receiver busy\n", 25); close(ns); }
                else { cl = ns; last = time(NULL); rx_init(&S, &fs, on_event, &S); }
            }
        }
    }
}
