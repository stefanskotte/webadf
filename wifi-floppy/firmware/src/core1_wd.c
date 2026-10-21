#include "core1_wd.h"
#include <string.h>

void c1wd_init(c1wd_t *w) { memset(w, 0, sizeof *w); }

// a - b on the wrapping ms clock, as a signed difference: negative when b is the later one.
static int32_t ms_diff(uint32_t a, uint32_t b) { return (int32_t)(a - b); }

unsigned c1wd_step(c1wd_t *w, uint32_t now_ms, uint32_t last_tick_ms, bool in_loop) {
    unsigned r = 0;
    w->gap = 0;
    if (in_loop) {
        if (!w->started) {
            w->started = true;
            w->report_at = now_ms + C1WD_REPORT_MS;
        }
        // A tick written after core0 read its clock is no gap -- and never a 49-day one.
        const int32_t d = ms_diff(now_ms, last_tick_ms);
        w->gap = d > 0 ? (uint32_t)d : 0;
        if (w->gap > w->max_gap) {
            w->max_gap = w->gap;
            const uint32_t quarter = w->logged_max / 4u;
            const uint32_t step = quarter > C1WD_LOG_STEP_MS ? quarter : C1WD_LOG_STEP_MS;
            if (w->max_gap - w->logged_max >= step) {
                w->logged_max = w->max_gap;
                r |= C1WD_NEW_MAX;
            }
        }
        if (!w->stalled && w->gap > C1WD_LIMIT_MS) {
            w->stalled = true;
            r |= C1WD_STALL;
        }
    }
    if (w->started && ms_diff(now_ms, w->report_at) >= 0) {
        w->report_at = now_ms + C1WD_REPORT_MS;
        r |= C1WD_REPORT;
    }
    if (!w->stalled) r |= C1WD_FEED;
    return r;
}
