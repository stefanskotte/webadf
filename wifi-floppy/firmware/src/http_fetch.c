// Raw-lwIP streaming HTTP GET. Used once per disk, at mount, to pull the
// whole image into PSRAM - the bus never waits on the network afterwards.
// Runs on core 1 under cyw43_arch_lwip_threadsafe_background.
#include "http_fetch.h"
#include "pico/cyw43_arch.h"
#include "lwip/tcp.h"
#include <stdio.h>
#include <string.h>

typedef struct {
    http_sink_fn sink;
    void        *ctx;
    int          len;               // body bytes seen
    bool         done, header_done;
    int          hdr_scan;
    absolute_time_t last_rx;        // for the idle timeout
} xfer_t;

static err_t on_recv(void *arg, struct tcp_pcb *pcb, struct pbuf *p, err_t err) {
    xfer_t *x = arg;
    if (!p) { x->done = true; return ERR_OK; }         // remote closed
    for (struct pbuf *q = p; q; q = q->next) {
        const char *d = q->payload;
        for (int i = 0; i < q->len; i++) {
            if (!x->header_done) {                     // find \r\n\r\n
                static const char sep[4] = "\r\n\r\n";
                x->hdr_scan = (d[i] == sep[x->hdr_scan]) ? x->hdr_scan + 1 : (d[i]=='\r');
                if (x->hdr_scan == 4) x->header_done = true;
            } else {
                // hand the remainder of this pbuf to the sink in one go
                int n = q->len - i;
                x->sink(x->ctx, (const uint8_t *)d + i, n);
                x->len += n;
                break;
            }
        }
    }
    x->last_rx = get_absolute_time();
    tcp_recved(pcb, p->tot_len);
    pbuf_free(p);
    return ERR_OK;
}

// Blocking streaming fetch (core 1 only). Returns body length or <0.
int http_get_stream(const char *path, http_sink_fn sink, void *ctx,
                    int idle_timeout_ms) {
    xfer_t x = { .sink = sink, .ctx = ctx, .last_rx = get_absolute_time() };
    ip_addr_t ip;
    if (!ipaddr_aton(TRACK_SERVER_IP, &ip)) return -1;

    cyw43_arch_lwip_begin();
    struct tcp_pcb *pcb = tcp_new();
    tcp_arg(pcb, &x);
    tcp_recv(pcb, on_recv);
    err_t e = tcp_connect(pcb, &ip, TRACK_SERVER_PORT, NULL);
    cyw43_arch_lwip_end();
    if (e != ERR_OK) return -2;

    // wait for connect, then send request
    sleep_ms(2);
    char req[160];
    snprintf(req, sizeof req,
        "GET %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n",
        path, TRACK_SERVER_IP);
    cyw43_arch_lwip_begin();
    tcp_write(pcb, req, strlen(req), TCP_WRITE_FLAG_COPY);
    tcp_output(pcb);
    cyw43_arch_lwip_end();

    // Idle timeout, not a total deadline: a 2 MB image legitimately takes
    // seconds, but a stalled link should still give up.
    while (!x.done &&
           absolute_time_diff_us(x.last_rx, get_absolute_time())
               < (int64_t)idle_timeout_ms * 1000)
        sleep_ms(1);

    cyw43_arch_lwip_begin();
    tcp_arg(pcb, NULL); tcp_recv(pcb, NULL);
    tcp_close(pcb);
    cyw43_arch_lwip_end();
    return x.header_done ? x.len : -3;
}

int http_post_track(int track, const uint8_t *mfm, int len) {
    // TODO write-back path: POST /tracks/<n> with decoded/encoded payload.
    (void)track; (void)mfm; (void)len;
    return -1;
}
