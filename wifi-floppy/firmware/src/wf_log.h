#ifndef WF_LOG_H
#define WF_LOG_H
// Console logging over USB CDC, for hardware bring-up.
//
// Until now the firmware wrote nothing at all: stdio_init_all() brought up
// the CDC device, so a port appeared and a terminal could attach, but there
// was not one printf in src/. Listening returned zero bytes. That was
// survivable while the only thing to check was externally visible (an AP
// either broadcasts or it does not); it stops being survivable on the Amiga,
// where every interesting event is a signal edge nobody can see.
//
// TWO ENTRY POINTS, AND THE DIFFERENCE MATTERS:
//
//   wf_logf()  formats immediately with vsnprintf. Use from core1 and from
//              core0's ordinary loop. NOT from an interrupt: it is slow, and
//              its format string lives in flash.
//
//   wf_trace() takes an integer event code and two integers. No formatting,
//              no string constant, so it is safe from interrupt context
//              including the flux DMA handler. The drainer turns the code
//              into text later, on core0's loop, where being slow is fine.
//
// WHERE IT DRAINS, AND WHY THERE. core0's service loop already sleeps 1 ms
// per iteration -- the bit-level work is done by PIO and DMA, not by that
// loop -- so it has the slack to write to USB. core1 does not: its loop
// blocks for tens of seconds inside a long-poll, which would strand every
// core0 trace behind it. So core0 drains, and core1 only produces.
//
// The ring drops NEWEST records when full and counts what it dropped, rather
// than overwriting oldest or blocking a producer. A logger that stalls the
// floppy service loop to report on the floppy service loop would be worse
// than no logger, and one that silently loses records would be worse still.
//
// NOTHING IS DRAINED UNTIL A TERMINAL IS ATTACHED. A detached USB CDC port
// does not buffer what is written to it, it discards it -- so a drain with
// nobody listening destroys records silently, which is exactly the failure
// the paragraph above says is the worst one available. wf_log_drain() holds
// instead, and the boot history survives to whenever someone attaches. See
// its definition for the measurement that produced this rule.
#include <stdint.h>

typedef enum {
    WF_INFO = 0,
    WF_WARN,
    WF_ERR,
} wf_level_t;

// Trace events. Integer codes deliberately: see wf_trace() above.
typedef enum {
    WF_EV_BOOT = 0,
    WF_EV_SEL,            // a = asserted
    WF_EV_MOTOR,          // a = running
    WF_EV_STEP,           // a = cylinder after the step, b = 1 if outwards
    WF_EV_SIDE,           // a = side
    WF_EV_INDEX,          // wrap of a revolution
    WF_EV_TRACK_WANT,     // a = track the head is now over
    WF_EV_TRACK_SERVED,   // a = track, b = bit count streamed
    WF_EV_TRACK_MISS,     // a = track that was not in PSRAM
    WF_EV_WGATE,          // a = asserted
    WF_EV_MOUNT,          // a = token
    WF_EV_EJECT,
    WF_EV_DIR_LATE,       // a = cylinder after the step, b = DIR read at interrupt time
    WF_EV_BUS,            // WF_BUS_SNIFF: a = GP2..GP9 levels (bit 8 = samples dropped before), b = time_us
    WF_EV__COUNT
} wf_ev_t;

void wf_log_init(void);

// Formatted. Core1, or core0's loop. Never from an interrupt, and never
// while a flash write is in progress -- vsnprintf and the format string are
// both in flash, and XIP is down for the duration.
void wf_logf(wf_level_t lvl, const char *fmt, ...)
    __attribute__((format(printf, 2, 3)));

// Interrupt-safe. No formatting, no flash access of its own.
void wf_trace(wf_ev_t ev, uint32_t a, uint32_t b);

// Emit up to max_records queued records. Returns how many lines it wrote,
// including the "records dropped" line if one was due. Call from core0.
// Returns 0 without consuming anything while no terminal is attached.
int wf_log_drain(int max_records);

// Records lost to a full ring since the last drain reported them.
uint32_t wf_log_dropped(void);

#ifdef WFMF_HOST_TEST
// Test seams. The device build has no equivalent: it takes its time from
// time_us_64() and its sink is puts().
void wf_log_test_reset(void);
void wf_log_test_set_now(uint64_t us);
// Stands in for stdio_usb_connected(). Defaults to attached on reset, so
// every test written before the hold existed still exercises the drain.
void wf_log_test_set_ready(int ready);
void wf_log_test_set_sink(void (*sink)(const char *line));
int  wf_log_test_capacity(void);
#endif

#endif
