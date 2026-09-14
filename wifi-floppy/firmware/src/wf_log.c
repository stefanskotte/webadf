#include "wf_log.h"
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#ifndef WFMF_HOST_TEST
#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "pico/stdio_usb.h"
#include "hardware/sync.h"
#endif

// 64 slots is about 8 KB of SRAM. Sized against the burst that actually
// matters: a seek across the disk delivers one STEP interrupt per cylinder
// with only the Amiga's step rate (3 ms typical) between them, so core0's
// 1 ms drain keeps up comfortably. The ring exists for the case core0 is
// busy servicing a track change, which is a PSRAM->SRAM copy, not for
// sustained overload.
#ifndef WF_LOG_SLOTS          // WF_BUS_SNIFF builds raise it: one record per bus change
#define WF_LOG_SLOTS 64
#endif
#define WF_LOG_MSG   88

typedef struct {
    uint64_t us;
    uint32_t a, b;
    uint16_t ev;          // WF_EV__COUNT == "formatted, see msg"
    uint8_t  lvl;
    uint8_t  core;
    char     msg[WF_LOG_MSG];
} rec_t;

static rec_t ring[WF_LOG_SLOTS];
static volatile uint32_t r_head;      // next slot to write
static volatile uint32_t r_tail;      // next slot to read
static volatile uint32_t r_dropped;

// ---------------------------------------------------------------- platform
#ifndef WFMF_HOST_TEST

static spin_lock_t *g_lock;

#define WF_LOCK()    uint32_t _sv = spin_lock_blocking(g_lock)
#define WF_UNLOCK()  spin_unlock(g_lock, _sv)

static uint64_t wf_now_us(void) { return time_us_64(); }
static unsigned wf_core(void)   { return get_core_num(); }
static void     wf_sink(const char *line) { puts(line); }
// DTR, in effect: pico-sdk's stdio_usb_connected() is tud_cdc_connected()
// unless PICO_STDIO_USB_CONNECTION_WITHOUT_DTR is set, which we do not set.
static bool     wf_sink_ready(void) { return stdio_usb_connected(); }

#else   // WFMF_HOST_TEST

// The host build is single-threaded, so the lock is a no-op -- exactly the
// shape psram_image.c uses for the same reason.
#define WF_LOCK()    do { } while (0)
#define WF_UNLOCK()  do { } while (0)

static uint64_t h_now;
static int      h_ready = 1;
static void (*h_sink)(const char *line);
static uint64_t wf_now_us(void) { return h_now; }
static unsigned wf_core(void)   { return 0; }
static void     wf_sink(const char *line) { if (h_sink) h_sink(line); }
static bool     wf_sink_ready(void) { return h_ready != 0; }

void wf_log_test_set_now(uint64_t us) { h_now = us; }
void wf_log_test_set_ready(int ready) { h_ready = ready; }
void wf_log_test_set_sink(void (*s)(const char *line)) { h_sink = s; }
int  wf_log_test_capacity(void) { return WF_LOG_SLOTS - 1; }
void wf_log_test_reset(void) {
    r_head = r_tail = r_dropped = 0;
    h_now = 0;
    h_ready = 1;
    memset(ring, 0, sizeof ring);
}

#endif

// ---------------------------------------------------------------- produce
//
// Both producers write the slot's fields and only then advance r_head, all
// inside the lock. The drainer never looks past r_head, so it cannot read a
// half-filled slot -- which is why this does not hand a slot pointer back to
// the caller to fill at its leisure.
static void wf_push(uint16_t ev, uint8_t lvl, uint32_t a, uint32_t b,
                    const char *msg) {
    WF_LOCK();
    uint32_t next = (r_head + 1u) % WF_LOG_SLOTS;
    if (next == r_tail) {
        r_dropped++;                       // drop newest, count it, never block
    } else {
        rec_t *r = &ring[r_head];
        r->us   = wf_now_us();
        r->a    = a;
        r->b    = b;
        r->ev   = ev;
        r->lvl  = lvl;
        r->core = (uint8_t)wf_core();
        if (msg) {
            size_t n = strlen(msg);
            if (n >= WF_LOG_MSG) n = WF_LOG_MSG - 1;
            memcpy(r->msg, msg, n);
            r->msg[n] = '\0';
        } else {
            r->msg[0] = '\0';
        }
        r_head = next;
    }
    WF_UNLOCK();
}

void wf_logf(wf_level_t lvl, const char *fmt, ...) {
    // Formatted OUTSIDE the lock. vsnprintf is far too slow to hold a
    // spinlock across when the other core may be trying to trace an edge.
    char tmp[WF_LOG_MSG];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(tmp, sizeof tmp, fmt, ap);
    va_end(ap);
    wf_push(WF_EV__COUNT, (uint8_t)lvl, 0, 0, tmp);
}

#ifndef WFMF_HOST_TEST
// Placed in RAM for the same reason dma_irq is, and with the same caveat
// its comment already records: this covers wf_trace's own body, not
// everything it calls (time_us_64 and the spinlock helpers still live in
// flash). What actually makes that safe is the multicore lockout -- core0
// executes nothing at all while XIP is down, so the flux DMA handler cannot
// be running then either. __not_in_flash_func is the same cheap second
// layer here that it is there.
void __not_in_flash_func(wf_trace)(wf_ev_t ev, uint32_t a, uint32_t b) {
#else
void wf_trace(wf_ev_t ev, uint32_t a, uint32_t b) {
#endif
    wf_push((uint16_t)ev, (uint8_t)WF_INFO, a, b, NULL);
}

uint32_t wf_log_dropped(void) { return r_dropped; }

// ---------------------------------------------------------------- consume
static const char *const ev_name[WF_EV__COUNT] = {
    "BOOT", "SEL", "MOTOR", "STEP", "SIDE", "INDEX",
    "TRACK-WANT", "TRACK-SERVED", "TRACK-MISS", "WGATE", "MOUNT", "EJECT",
    "DIR-LATE", "BUS",
};
static const char *const lvl_tag[] = { "", "WARN ", "ERROR " };

static void wf_emit(const rec_t *r) {
    char line[WF_LOG_MSG + 64];
    unsigned sec = (unsigned)(r->us / 1000000u);
    unsigned ms  = (unsigned)((r->us / 1000u) % 1000u);
    if (r->ev < WF_EV__COUNT) {
        snprintf(line, sizeof line, "[%5u.%03u] c%u %-12s a=%lu b=%lu",
                 sec, ms, r->core, ev_name[r->ev],
                 (unsigned long)r->a, (unsigned long)r->b);
    } else {
        unsigned lvl = r->lvl < 3u ? r->lvl : 0u;
        snprintf(line, sizeof line, "[%5u.%03u] c%u %s%s",
                 sec, ms, r->core, lvl_tag[lvl], r->msg);
    }
    wf_sink(line);
}

int wf_log_drain(int max_records) {
    // A DETACHED USB CDC PORT DISCARDS WHAT IS WRITTEN TO IT. pico-sdk's
    // stdio_usb_out_chars() returns without writing when DTR is deasserted,
    // and PICO_STDIO_USB_CONNECT_WAIT_TIMEOUT_MS defaults to 0, so boot never
    // waits for a terminal. Draining into that sink therefore DESTROYS
    // records instead of delivering them -- and destroys them silently, since
    // the ring never overflows and the dropped-record line never fires.
    //
    // Measured on a rev A2 board 2026-09-10, before this guard existed: the
    // "wifi-floppy boot" banner and "radio up (RM2)" were both already gone
    // by the time a terminal could attach (~560 ms of board uptime), with
    // nothing in the stream to say they had ever been written. A board cannot
    // be attached to before it enumerates, so every boot-time record was
    // structurally unobservable -- which is precisely the window this log was
    // added to make visible.
    //
    // So hold instead of drain. Records stay in the ring until someone is
    // listening, where the existing policy applies: oldest kept, newest
    // dropped, and the loss REPORTED when the backlog clears. A long
    // detachment therefore costs the most recent records rather than the boot
    // history, which is the right way round for bring-up -- and unlike the
    // silent discard, it says so.
    if (!wf_sink_ready()) return 0;

    int emitted = 0;
    while (emitted < max_records) {
        rec_t local;
        WF_LOCK();
        if (r_tail == r_head) { WF_UNLOCK(); break; }
        local = ring[r_tail];
        r_tail = (r_tail + 1u) % WF_LOG_SLOTS;
        WF_UNLOCK();
        wf_emit(&local);
        emitted++;
    }

    // Report drops only once the backlog is clear, so the count covers a
    // whole overflow episode rather than one line per record lost -- which
    // would itself be a burst of USB writes at precisely the busiest moment.
    uint32_t d = 0;
    WF_LOCK();
    if (r_tail == r_head && r_dropped) { d = r_dropped; r_dropped = 0; }
    WF_UNLOCK();
    if (d) {
        char line[64];
        snprintf(line, sizeof line, "[     .   ] -- %lu record(s) dropped --",
                 (unsigned long)d);
        wf_sink(line);
        emitted++;
    }
    return emitted;
}

void wf_log_init(void) {
    r_head = r_tail = r_dropped = 0;
#ifndef WFMF_HOST_TEST
    g_lock = spin_lock_instance(spin_lock_claim_unused(true));
#endif
}
