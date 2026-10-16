/* bsdsocket glue shared by both front ends: one listener on RX_PORT, one connection at a time, WaitSelect on the
   sockets plus the front end's signals (Ctrl-C always). */
#include <string.h>
#include <proto/exec.h>
#include <proto/dos.h>
#include <proto/socket.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <netinet/in.h>
#include <dos/dos.h>
#include "net.h"

struct Library *SocketBase;

int net_open(void) { SocketBase = OpenLibrary((STRPTR)"bsdsocket.library", 3); return SocketBase ? 0 : -1; }
void net_close(void) { if (SocketBase) { CloseLibrary(SocketBase); SocketBase = NULL; } }

static int send_all(LONG fd, const char *p, LONG n) {
    while (n > 0) { LONG w = send(fd, (APTR)p, n, 0); if (w <= 0) return -1; p += w; n -= w; }
    return 0;
}
/* Seconds since 1978 from the system clock: enough to tell a connection that went silent. */
static ULONG now_secs(void) {
    struct DateStamp ds;
    DateStamp(&ds);
    return (ULONG)ds.ds_Days * 86400UL + (ULONG)ds.ds_Minute * 60UL + (ULONG)ds.ds_Tick / TICKS_PER_SECOND;
}

static net_ui *cur_ui;
static rx_session *cur_s;
static void relay(void *u, const rx_event *e) { (void)u; cur_ui->on_event(cur_ui->u, e, cur_s); }

int net_run(net_ui *ui, afs_ctx *ctx, rx_fs *fs, rx_session *s) {
    static unsigned char buf[4096];
    struct sockaddr_in a;
    LONG one = 1, ls, cl = -1;
    ULONG last = 0;
    (void)ctx;
    cur_ui = ui; cur_s = s;
    ls = socket(AF_INET, SOCK_STREAM, 0);
    if (ls < 0) return -1;
    setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET; a.sin_port = htons(RX_PORT); a.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(ls, (struct sockaddr *)&a, sizeof a) != 0 || listen(ls, 2) != 0) { CloseSocket(ls); return -1; }
    ui->on_status(ui->u, "Listening on port 6800");
    for (;;) {
        fd_set r;
        ULONG sigs = SIGBREAKF_CTRL_C | ui->extra_sigs;
        struct timeval tv;
        LONG n, maxfd = ls;
        FD_ZERO(&r); FD_SET(ls, &r);
        if (cl >= 0) { FD_SET(cl, &r); if (cl > maxfd) maxfd = cl; }
        tv.tv_secs = 1; tv.tv_micro = 0;
        n = WaitSelect(maxfd + 1, &r, NULL, NULL, &tv, &sigs);
        if (sigs & SIGBREAKF_CTRL_C) break;
        if ((sigs & ui->extra_sigs) && ui->on_signal(ui->u, sigs)) break;
        /* A peer that went silent (a rebooted board sends no FIN; a scanner just waits) must not hold the slot. */
        if (cl >= 0 && (n <= 0 || !FD_ISSET(cl, &r)) && now_secs() - last > RX_IDLE_SECS) {
            rx_disconnected(s); CloseSocket(cl); cl = -1; continue;
        }
        if (n <= 0) continue;
        /* The connection first: a board's close (EOF) is handled before its reconnect is accepted. */
        if (cl >= 0 && FD_ISSET(cl, &r)) {
            LONG got = recv(cl, buf, sizeof buf, 0);
            int bad = got <= 0 || rx_feed(s, buf, (unsigned long)got) != 0;
            last = now_secs();
            char o[RX_OUT_MAX];
            unsigned k;
            while ((k = rx_take_output(s, o, sizeof o)) > 0) if (send_all(cl, o, (LONG)k) != 0) bad = 1;
            if (bad) { rx_disconnected(s); CloseSocket(cl); cl = -1; }
        }
        if (FD_ISSET(ls, &r)) {
            LONG ns = accept(ls, NULL, NULL);
            if (ns >= 0) {
                if (cl >= 0) { send_all(ns, "ERR - busy receiver busy\n", 25); CloseSocket(ns); }
                else { cl = ns; last = now_secs(); rx_init(s, fs, relay, NULL); }
            }
        }
    }
    if (cl >= 0) { rx_disconnected(s); CloseSocket(cl); }
    CloseSocket(ls);
    return 0;
}
