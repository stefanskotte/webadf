// PaulaNET Phase 4: lwIP raw-API TCP to Receive on the Amiga, plus the HTTPS ops, for amiga_send.c. Device-only
// (test/run.sh excludes it): every decision lives in amiga_send.c, which is host-tested; this file is lwIP calls.
//
// Threading (NO_SYS=1, pico_cyw43_arch_lwip_threadsafe_background): the callbacks below run in the network
// context with lwIP locked; core1 calls the ops under net_radio_lock() and never holds it across a wait. The
// callbacks only set state and copy bytes into a small ring -- everything else happens on core1.
//
// PCBs: MEMP_NUM_TCP_PCB is lwIP's default (5); TLS uses one, this connection one, the portal none in STA mode.
#include "amiga_tcp.h"
#include "net_radio.h"
#include "wf_log.h"
#include "pico/time.h"
#include "lwip/tcp.h"
#include "lwip/ip_addr.h"
#include <string.h>

#define RING 1024   // Receive's replies are short lines; the board never reads bulk data from the Amiga

static struct {
    struct tcp_pcb *pcb;
    volatile int state;          // AS_SOCK_*
    uint8_t ring[RING];
    volatile int head, tail;     // bytes [tail, head) are unread
} T;

static device_client_t *g_dc;

static int ring_used(void) { return (T.head - T.tail + RING) % RING; }

static err_t on_recv(void *arg, struct tcp_pcb *pcb, struct pbuf *p, err_t err) {
    (void)arg; (void)err;
    if (!p) { T.state = AS_SOCK_CLOSED; return ERR_OK; }   // the Amiga closed (Receive quit)
    for (struct pbuf *q = p; q; q = q->next) {
        const uint8_t *b = q->payload;
        for (u16_t i = 0; i < q->len; i++) {
            if (ring_used() == RING - 1) { T.state = AS_SOCK_CLOSED; break; }   // a peer that floods: give up
            T.ring[T.head] = b[i];
            T.head = (T.head + 1) % RING;
        }
    }
    tcp_recved(pcb, p->tot_len);
    pbuf_free(p);
    return ERR_OK;
}

static void on_err(void *arg, err_t err) {
    (void)arg;
    // lwIP has freed the pcb already.
    T.pcb = NULL;
    T.state = (err == ERR_RST && T.state == AS_SOCK_CONNECTING) ? AS_SOCK_REFUSED : AS_SOCK_CLOSED;
}

static err_t on_connected(void *arg, struct tcp_pcb *pcb, err_t err) {
    (void)arg; (void)pcb;
    T.state = err == ERR_OK ? AS_SOCK_OPEN : AS_SOCK_CLOSED;
    return ERR_OK;
}

static void t_close(void *ctx) {
    (void)ctx;
    net_radio_lock();
    if (T.pcb) {
        tcp_arg(T.pcb, NULL);
        tcp_recv(T.pcb, NULL);
        tcp_err(T.pcb, NULL);
        if (tcp_close(T.pcb) != ERR_OK) tcp_abort(T.pcb);
        T.pcb = NULL;
    }
    T.head = T.tail = 0;
    T.state = AS_SOCK_CLOSED;
    net_radio_unlock();
}

static int t_connect(void *ctx, uint32_t ip, uint16_t port) {
    t_close(ctx);
    ip_addr_t a;
    IP4_ADDR(ip_2_ip4(&a), (ip >> 24) & 255, (ip >> 16) & 255, (ip >> 8) & 255, ip & 255);
    IP_SET_TYPE_VAL(a, IPADDR_TYPE_V4);
    net_radio_lock();
    struct tcp_pcb *pcb = tcp_new_ip_type(IPADDR_TYPE_V4);
    if (!pcb) { net_radio_unlock(); return -1; }
    tcp_arg(pcb, NULL);
    tcp_recv(pcb, on_recv);
    tcp_err(pcb, on_err);
    T.pcb = pcb;
    T.state = AS_SOCK_CONNECTING;
    err_t e = tcp_connect(pcb, &a, port, on_connected);
    if (e != ERR_OK) { tcp_abort(pcb); T.pcb = NULL; T.state = AS_SOCK_CLOSED; }
    net_radio_unlock();
    return e == ERR_OK ? 0 : -1;
}

static int t_state(void *ctx) { (void)ctx; return T.state; }

static int t_send(void *ctx, const uint8_t *b, int n) {
    (void)ctx;
    net_radio_lock();
    if (!T.pcb || T.state != AS_SOCK_OPEN) { net_radio_unlock(); return -1; }
    int room = (int)tcp_sndbuf(T.pcb);
    int k = n < room ? n : room;
    if (k > 0) {
        err_t e = tcp_write(T.pcb, b, (u16_t)k, TCP_WRITE_FLAG_COPY);
        if (e == ERR_MEM) k = 0;                       // queue full: try again next pass
        else if (e != ERR_OK) { net_radio_unlock(); return -1; }
        else tcp_output(T.pcb);
    }
    net_radio_unlock();
    return k;
}

static int t_recv_line(void *ctx, char *out, int cap) {
    (void)ctx;
    net_radio_lock();
    int used = ring_used();
    int lf = -1;
    for (int i = 0; i < used; i++) if (T.ring[(T.tail + i) % RING] == '\n') { lf = i; break; }
    int r;
    if (lf < 0) {
        r = (T.state == AS_SOCK_CLOSED) ? -1 : 0;
    } else {
        int n = 0;
        for (int i = 0; i < lf; i++) {
            char ch = (char)T.ring[(T.tail + i) % RING];
            if (ch != '\r' && n < cap - 1) out[n++] = ch;
        }
        out[n] = 0;
        T.tail = (T.tail + lf + 1) % RING;
        r = 1;
    }
    net_radio_unlock();
    return r;
}

static int h_queue(void *ctx, char *buf, int cap) { (void)ctx; return dc_fetch_send_queue(g_dc, buf, cap); }
static int h_chunk(void *ctx, const char *id, uint32_t off, uint32_t len, uint8_t *buf) {
    (void)ctx; return dc_fetch_send_chunk(g_dc, id, off, len, buf);
}
static int h_done(void *ctx, const char *id, const char *json) { (void)ctx; return dc_post_send_done(g_dc, id, json); }
static uint32_t h_now(void *ctx) { (void)ctx; return to_ms_since_boot(get_absolute_time()); }

void amiga_tcp_ops(as_ops_t *ops, device_client_t *c) {
    g_dc = c;
    T.state = AS_SOCK_CLOSED;
    ops->ctx = NULL;
    ops->connect = t_connect;
    ops->sock_state = t_state;
    ops->send = t_send;
    ops->recv_line = t_recv_line;
    ops->close = t_close;
    ops->fetch_queue = h_queue;
    ops->fetch_chunk = h_chunk;
    ops->post_done = h_done;
    ops->now_ms = h_now;
}
