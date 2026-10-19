// See a2b_discard.h. Every pbuf is freed in the receive callback with tcp_recved at once (spec U9): the frame's lwIP
// heap is released before the next frame is input, which is the property increment 0 measures.
#include "a2b_discard.h"
#include "net_radio.h"
#include "wf_log.h"
#include "pico/time.h"
#include "lwip/tcp.h"
#include "lwip/priv/tcp_priv.h"   // struct tcp_seg: the out-of-order queue is walked to measure it
#include "lwip/stats.h"

// The image marker: scripts/firmware-release.ts (src/lib/firmware-manifest.ts) refuses an image carrying it unless
// the notes start "TEST build". Read by the start log line, which keeps it in the image.
const char wf_a2b_discard_marker[] = "wf-a2b-discard-test";

static struct {
    struct tcp_pcb *listen, *conn;
    uint32_t bytes, t0_ms, t_last_ms, chunk_max, ooseq_max, ooseq_pbufs_max, conns;
} D;

// The out-of-order queue's bytes and pbufs, kept as peaks. Sampled in the receive callback and every 2 s by
// a2b_discard_stats(); tcp_receive drains or coalesces the queue before the callback runs, so this is a lower bound
// on the true peak (fix round 1).
static void ooseq_sample(const struct tcp_pcb *pcb) {
#if TCP_QUEUE_OOSEQ
    uint32_t n = 0, k = 0;
    for (const struct tcp_seg *s = pcb->ooseq; s; s = s->next) { n += s->p->tot_len; k += pbuf_clen(s->p); }
    if (n > D.ooseq_max) D.ooseq_max = n;
    if (k > D.ooseq_pbufs_max) D.ooseq_pbufs_max = k;
#else
    (void)pcb;
#endif
}

static err_t on_recv(void *arg, struct tcp_pcb *pcb, struct pbuf *p, err_t err) {
    (void)arg; (void)err;
    if (!p) {                                   // the Amiga closed: the totals stay for the log
        tcp_recv(pcb, NULL); tcp_err(pcb, NULL);
        D.conn = NULL;
        if (tcp_close(pcb) != ERR_OK) { tcp_abort(pcb); return ERR_ABRT; }   // lwIP's contract after an abort
        return ERR_OK;
    }
    const uint32_t now = to_ms_since_boot(get_absolute_time());
    if (D.bytes == 0) D.t0_ms = now;
    D.bytes += p->tot_len;
    D.t_last_ms = now;
    if (p->tot_len > D.chunk_max) D.chunk_max = p->tot_len;   // the most delivered in one callback
    ooseq_sample(pcb);
    tcp_recved(pcb, p->tot_len);
    pbuf_free(p);
    return ERR_OK;
}

static void on_err(void *arg, err_t err) { (void)arg; (void)err; D.conn = NULL; }   // lwIP freed the pcb

static err_t on_accept(void *arg, struct tcp_pcb *pcb, err_t err) {
    (void)arg;
    if (err != ERR_OK || !pcb) return ERR_VAL;
    if (D.conn) { tcp_abort(pcb); return ERR_ABRT; }   // one copy at a time
    D.conn = pcb;
    D.bytes = 0; D.t0_ms = D.t_last_ms = 0; D.chunk_max = 0; D.ooseq_max = 0; D.ooseq_pbufs_max = 0; D.conns++;
    tcp_recv(pcb, on_recv);
    tcp_err(pcb, on_err);
    return ERR_OK;
}

void a2b_discard_start(void) {
    net_radio_lock();
    struct tcp_pcb *pcb = tcp_new_ip_type(IPADDR_TYPE_V4);
    if (pcb && tcp_bind(pcb, IP_ANY_TYPE, A2B_DISCARD_PORT) == ERR_OK) {
        D.listen = tcp_listen(pcb);
        if (D.listen) tcp_accept(D.listen, on_accept);
    } else if (pcb) {
        tcp_close(pcb);
    }
    net_radio_unlock();
    if (D.listen) wf_logf(WF_WARN, "a2b: %s -- discard service on port %u", wf_a2b_discard_marker, A2B_DISCARD_PORT);
    else wf_logf(WF_ERR, "a2b: no discard service on port %u", A2B_DISCARD_PORT);
}

void a2b_discard_stats(a2b_stats_t *o) {
    net_radio_lock();
    if (D.conn) ooseq_sample(D.conn);
    o->bytes = D.bytes;
    o->ms = D.t_last_ms - D.t0_ms;
    o->chunk_max = D.chunk_max;
    o->ooseq_max = D.ooseq_max;
    o->ooseq_pbufs_max = D.ooseq_pbufs_max;
    o->conns = D.conns;
    o->open = D.conn != NULL;
#if MEM_STATS
    o->mem_max = (uint32_t)lwip_stats.mem.max;
    o->mem_err = (uint32_t)lwip_stats.mem.err;
#else
    o->mem_max = 0; o->mem_err = 0;
#endif
    net_radio_unlock();
}
