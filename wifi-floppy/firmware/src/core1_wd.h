#ifndef CORE1_WD_H
#define CORE1_WD_H
// core1 supervision (fw 1.21.0). Only core0 feeds the 8 s hardware watchdog (fw_rom_service), so a core1 that hangs
// -- lwIP, TLS, the device client, an upload -- used to leave the board up but deaf until someone pulled the power
// (HANDOFF 3cb, "core1 is not watchdog-supervised"). core1 already stamps the boot trail's heartbeat, bt_hw_tick(1),
// at least once a second in its poll loop (boot_trail_hw.c). core0 reads that tick every pass of its own loop and
// asks c1wd_step what to do:
//   * measure -- the gap (now - core1's last tick) and the longest one seen since core1 first reached its loop,
//     logged when a new maximum is at least max(1 s, 25%) past the last one logged, and every 10 minutes;
//   * enforce -- a gap PAST C1WD_LIMIT_MS: core0 logs, marks the boot trail (BT0_C1STALL: the next boot reports
//     reset "core1-stall") and stops feeding the watchdog, which resets the board within 8 s.
// Supervised only while core1 is in its poll loop (boot-trail stage BT1_LOOP or BT1_CONTACT): joining Wi-Fi, the
// captive portal, registration and an update's trial all block for as long as they take, and are not judged.
// A stall is latched: once the watchdog is let go, nothing feeds it again.
//
// RULE: pure C, host-tested (test/test_core1_wd.c). The tick is read through bt_hw_core1_view (boot_trail_hw.c).
#include <stdbool.h>
#include <stdint.h>

// What the A500 bench measured (2026-10-22, fw 1.21.0 TEST, "c1wd: longest core1 gap"): 27.3 s idle for 12 h (the
// 25 s long poll); uploads, a 2 MB send to the Amiga and DF0 swaps stayed under 34 s; Wi-Fi and internet cut for
// 90 s mid-upload: 37.2 s; Wi-Fi cut for 90 s while idle: 60.4 s -- a poll's 30 s read timeout, then its retry's
// 15 s handshake timeout, then the next request's handshake, all in one pass of core1's loop with no tick between.
#define C1WD_BENCH_LONGEST_MS 60419u
// One request's worst sum of timeouts (transport_tls.c, device_client.c): the kept connection's write 10 + read 30,
// then the one retry on a new connection, DNS 10 + connect 15 + write 10 + read 30.
#define C1WD_WORST_REQUEST_MS 105000u
// The limit: core1 silent for longer than this resets the board. Never below 3x the bench's longest gap, nor below
// one request's worst sum of timeouts (test_core1_wd.c checks both). 300 s: a pass may chain requests, so the
// longest bad-network gap is a few of them, not one -- and a real hang is still caught in 5 minutes instead of
// never. One #define, overridable with -DC1WD_LIMIT_MS=...
#ifndef C1WD_LIMIT_MS
#define C1WD_LIMIT_MS 300000u
#endif
// The periodic report of the longest gap.
#define C1WD_REPORT_MS (10u * 60u * 1000u)
// A new maximum is logged once it is at least max(C1WD_LOG_STEP_MS, 25%) past the last one logged.
#define C1WD_LOG_STEP_MS 1000u

typedef struct {
    bool     started;     // core1 has been seen in its loop: the report clock runs
    bool     stalled;     // latched: the watchdog has been let go
    uint32_t gap;         // this step's gap (0 when not supervised)
    uint32_t max_gap;     // the longest supervised gap since boot
    uint32_t logged_max;  // the last maximum logged
    uint32_t report_at;   // the next periodic report (valid once started)
} c1wd_t;

// What core0 does after a step (bits).
enum { C1WD_FEED = 1u, C1WD_NEW_MAX = 2u, C1WD_REPORT = 4u, C1WD_STALL = 8u };

void c1wd_init(c1wd_t *w);
// `now_ms` and `last_tick_ms` on the same clock (ms since boot, wrapping at 2^32); `in_loop`: core1's stage is its
// poll loop. Returns C1WD_* bits: FEED unless stalled; NEW_MAX: log w->max_gap; REPORT: the periodic line; STALL:
// once, the step the limit was passed (w->gap is how long).
unsigned c1wd_step(c1wd_t *w, uint32_t now_ms, uint32_t last_tick_ms, bool in_loop);
#endif
