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
#include "pnet_lwip_hooks.h"   // amiga_tcp_ooseq_limit's declaration (lwIP's TCP_OOSEQ_BYTES_LIMIT hook)
#include "wf_log.h"
#include "pico/time.h"
#include "lwip/tcp.h"
#include "lwip/netif.h"
#include "lwip/ip_addr.h"
#include <string.h>

#define RING 1024   // Receive's lines (replies, PUT, END); an upload's raw bytes go to the PSRAM ring instead

static struct {
    struct tcp_pcb *pcb;
    volatile int state;          // AS_SOCK_*
    uint8_t ring[RING];
    volatile int head, tail;     // bytes [tail, head) are unread
    as_raw_t *volatile raw;      // an upload's raw section (fw 1.19.0): its bytes go to the PSRAM ring first
} T;

static device_client_t *g_dc;

static int ring_used(void) { return (T.head - T.tail + RING) % RING; }

static err_t on_recv(void *arg, struct tcp_pcb *pcb, struct pbuf *p, err_t err) {
    (void)arg; (void)err;
    if (!p) { T.state = AS_SOCK_CLOSED; return ERR_OK; }   // the Amiga closed (Receive quit)
    // T.raw is read once per pbuf, here in lwIP's context; t_raw_arm and t_close change it only under
    // net_radio_lock(), which this callback runs inside, so a disarm on core1 never lands mid-feed.
    for (struct pbuf *q = p; q; q = q->next) {
        const uint8_t *b = q->payload;
        u16_t i = 0;
        as_raw_t *w = T.raw;
        if (w) {   // spec 2026-10-18 §5: into PSRAM, and the pbuf is freed below before the next frame is input
            const int k = as_raw_feed(w, b, q->len);
            if (k < 0) { T.state = AS_SOCK_CLOSED; break; }   // past the credit: amiga_send drops the connection
            i = (u16_t)k;
            if (w->got == w->total) T.raw = NULL;              // the raw section is over: lines again
        }
        for (; i < q->len; i++) {
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
    // lwIP has freed the pcb already. Logged: an upload must survive a Wi-Fi drop, and this says why it did not
    // (ERR_ABRT -13: lwIP aborted it, e.g. the netif address changed; ERR_RST -14: a reset came; ERR_CLSD -15).
    const struct netif *n = net_radio_sta_netif();
    wf_logf(WF_WARN, "amiga tcp: lost, err %d, state %d, netif %s link %s addr %s", (int)err, T.state,
            netif_is_up(n) ? "up" : "DOWN", netif_is_link_up(n) ? "up" : "DOWN", ip4addr_ntoa(netif_ip4_addr(n)));
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
    T.raw = NULL;
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
    // At most 4 MSS queued at once (review I7): the Amiga drains slowly over the floppy path, and every queued byte
    // is a copied segment in lwIP's 16 KB heap, which TLS's sends and the Amiga's ACKs (pnet_bridge.c) share.
    int queued = (int)(TCP_SND_BUF - tcp_sndbuf(T.pcb));
    int room = 4 * TCP_MSS - queued;
    if (room > (int)tcp_sndbuf(T.pcb)) room = (int)tcp_sndbuf(T.pcb);
    if (room < 0) room = 0;
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

// Arm or disarm the raw section (amiga_send.c: before the TAKE, and NULL on every end -- up_reset, drop). Under the
// lwIP lock: on_recv runs with that lock held, so once this returns no callback is still feeding the old section, and
// the engine may reset its fields at once (plan 2026-10-19 Task 10 concern).
static void t_raw_arm(void *ctx, as_raw_t *w) {
    (void)ctx;
    net_radio_lock();
    T.raw = (w && w->got < w->total) ? w : NULL;   // an empty section (a resume at the end) is never armed
    net_radio_unlock();
}
// lwIP's TCP_OOSEQ_BYTES_LIMIT hook (pnet_lwip_hooks.h), in lwIP's context: the Amiga's connection may queue
// AS_UP_OOSEQ_BYTES of out-of-order data in the 16 KB heap; every other pcb (TLS) keeps lwIP's default, no limit.
uint32_t amiga_tcp_ooseq_limit(const struct tcp_pcb *pcb) { return pcb == T.pcb ? AS_UP_OOSEQ_BYTES : 0xFFFFFFFFu; }
static int h_up_open(void *ctx, const char *json, char *resp, int cap) { (void)ctx; return dc_upload_open(g_dc, json, resp, cap); }
static int h_up_chunk(void *ctx, const char *id, uint32_t off, const uint8_t *b, uint32_t n, char *resp, int cap) {
    (void)ctx; return dc_upload_chunk(g_dc, id, off, b, (int)n, resp, cap);
}
static int h_up_close(void *ctx, const char *id, const char *json, char *resp, int cap) { (void)ctx; return dc_upload_close(g_dc, id, json, resp, cap); }

static int h_queue(void *ctx, char *buf, int cap) { (void)ctx; return dc_fetch_send_queue(g_dc, buf, cap); }
static int h_chunk(void *ctx, const char *id, uint32_t off, uint32_t len, uint8_t *buf) {
    (void)ctx; return dc_fetch_send_chunk(g_dc, id, off, len, buf);
}
static int h_done(void *ctx, const char *id, const char *json) { (void)ctx; return dc_post_send_done(g_dc, id, json); }
static int h_req_fetch(void *ctx, char *buf, int cap) { (void)ctx; return dc_fetch_req(g_dc, buf, cap); }
static int h_req_post(void *ctx, const char *rid, const char *json, int n) { (void)ctx; return dc_post_req(g_dc, rid, json, n); }
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
    ops->upload_open = h_up_open; ops->upload_chunk = h_up_chunk; ops->upload_close = h_up_close; ops->raw_arm = t_raw_arm;
    ops->fetch_req = h_req_fetch; ops->post_req = h_req_post;   // NET: volumes (fw 1.22.0)
}
