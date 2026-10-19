/* bsdsocket glue shared by both front ends: one listener on RX_PORT, one connection at a time, WaitSelect on the
   sockets plus the front end's signals (Ctrl-C always). The connection is non-blocking, and what the core gives to
   send -- lines, a PUT, one 8 KB block of a file going up -- goes out as the socket takes it, so a slow link never
   freezes the window or Ctrl-C (spec 2026-10-18 §2). */
#include <string.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include <proto/socket.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <sys/time.h>
#include <sys/errno.h>
#include <netinet/in.h>
#include <dos/dos.h>
#include "clock.h"
#include "net.h"

struct Library *SocketBase;

int net_open(void) { SocketBase = OpenLibrary((STRPTR)"bsdsocket.library", 3); return SocketBase ? 0 : -1; }
void net_close(void) { if (SocketBase) { CloseLibrary(SocketBase); SocketBase = NULL; } }

static int send_all(LONG fd, const char *p, LONG n) {
    while (n > 0) { LONG w = send(fd, (APTR)p, n, 0); if (w <= 0) return -1; p += w; n -= w; }
    return 0;
}

static net_ui *cur_ui;
static rx_session *cur_s;
static void relay(void *u, const rx_event *e) { (void)u; cur_ui->on_event(cur_ui->u, e, cur_s); }

static char o[RX_UP_BLOCK];      /* the block going out */
static LONG o_len, o_off;

static void drop(net_ui *ui, rx_session *s, LONG *cl) {
    rx_disconnected(s);
    CloseSocket(*cl);
    *cl = -1;
    o_len = o_off = 0;
    if (ui->on_link) ui->on_link(ui->u, 0);
}

int net_run(net_ui *ui, afs_ctx *ctx, rx_fs *fs, rx_session *s, rx_upq *q) {
    static unsigned char buf[4096];
    struct sockaddr_in a;
    LONG one = 1, ls, cl = -1;
    ULONG last = 0;
    (void)ctx;
    cur_ui = ui; cur_s = s;
    o_len = o_off = 0;
    rx_init(s, fs, relay, NULL);   /* idle until the board connects */
    ls = socket(AF_INET, SOCK_STREAM, 0);
    if (ls < 0) return -1;
    setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET; a.sin_port = htons(RX_PORT); a.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(ls, (struct sockaddr *)&a, sizeof a) != 0 || listen(ls, 2) != 0) { CloseSocket(ls); return -1; }
    ui->on_status(ui->u, "Listening on port 6800");
    for (;;) {
        fd_set r, w;
        ULONG sigs = SIGBREAKF_CTRL_C | ui->extra_sigs;
        struct timeval tv;
        LONG n, maxfd = ls;
        int bad = 0, round;
        FD_ZERO(&r); FD_ZERO(&w); FD_SET(ls, &r);
        if (cl >= 0) { FD_SET(cl, &r); if (o_off < o_len) FD_SET(cl, &w); if (cl > maxfd) maxfd = cl; }
        tv.tv_secs = (cl >= 0 && o_off == o_len && rx_want_output(s)) ? 0 : 1; tv.tv_micro = 0;
        n = WaitSelect(maxfd + 1, &r, &w, NULL, &tv, &sigs);
        if (sigs & SIGBREAKF_CTRL_C) break;
        if ((sigs & ui->extra_sigs) && ui->on_signal(ui->u, sigs)) break;
        if (ui->on_pass && ui->on_pass(ui->u, s, cl >= 0)) break;
        /* A peer that went silent (a rebooted board sends no FIN; a scanner just waits) must not hold the slot. */
        if (cl >= 0 && (n <= 0 || !FD_ISSET(cl, &r)) && rx_now_secs() - last > (ULONG)rx_idle_secs(s)) { drop(ui, s, &cl); continue; }
        /* The connection first: a board's close (EOF) is handled before its reconnect is accepted. */
        if (cl >= 0 && n > 0 && FD_ISSET(cl, &r)) {
            LONG got = recv(cl, buf, sizeof buf, 0);
            if (got > 0) bad = rx_feed(s, buf, (unsigned long)got) != 0;
            else if (got == 0 || Errno() != EWOULDBLOCK) bad = 1;
            last = rx_now_secs();
        }
        for (round = 0; cl >= 0 && !bad && round < 4; round++) {
            if (o_off == o_len) {
                int k;
                if (!rx_want_output(s)) break;
                k = rx_take_output(s, o, sizeof o);
                if (k < 0) { bad = 1; break; }
                o_len = k; o_off = 0;
                if (k == 0) continue;   /* a block read only for the CRC */
            }
            {
                LONG sent = send(cl, (APTR)(o + o_off), o_len - o_off, 0);
                if (sent > 0) o_off += sent;
                else { if (sent < 0 && Errno() != EWOULDBLOCK) bad = 1; break; }
            }
        }
        if (cl >= 0 && bad) drop(ui, s, &cl);
        if (n > 0 && FD_ISSET(ls, &r)) {
            LONG ns = accept(ls, NULL, NULL);
            if (ns >= 0) {
                if (cl >= 0) { send_all(ns, "ERR - busy receiver busy\n", 25); CloseSocket(ns); }
                else {
                    LONG nb = 1;
                    /* A blocking socket would freeze the loop on a full send buffer: refuse rather than risk it. */
                    if (IoctlSocket(ns, FIONBIO, (char *)&nb) != 0) { CloseSocket(ns); continue; }
                    cl = ns; last = rx_now_secs(); o_len = o_off = 0;
                    rx_init(s, fs, relay, NULL); rx_attach(s, q);
                    if (ui->on_link) ui->on_link(ui->u, 1);
                }
            }
        }
    }
    if (cl >= 0) drop(ui, s, &cl);
    CloseSocket(ls);
    return 0;
}
