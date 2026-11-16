// Moving to another saved network while running: the decisions (wifi_fallback.h has the rules and why).
#include "wifi_fallback.h"
#include <string.h>

static uint32_t doubled(uint32_t ms, uint32_t max) { return ms >= max / 2u ? max : ms * 2u; }

void wfb_reset(wifi_fb_t *fb, uint32_t now, uint32_t answers) {
    memset(fb, 0, sizeof *fb);
    fb->started = true;
    fb->answers = answers;
    fb->quiet_since = now;
    fb->dead_ms = WFB_DEAD_MS;
    fb->rescan_at = now;
    fb->rescan_ms = WFB_RESCAN_MS;
}

wfb_due_t wfb_due(wifi_fb_t *fb, const wfb_in_t *in) {
    const uint32_t now = in->now;
    if (!fb->started) wfb_reset(fb, now, in->answers);
    if (in->answers != fb->answers) {   // the server answered: the network works
        fb->answers = in->answers;
        fb->quiet_since = now;
        fb->dead_ms = WFB_DEAD_MS;
    }
    if (in->link_up) {
        if (fb->down) {                 // back by itself (or by a run): A starts afresh
            fb->down = false;
            fb->quiet_since = now;
            fb->rescan_at = now;
            fb->rescan_ms = WFB_RESCAN_MS;
        }
    } else {
        if (!fb->down) {
            fb->down = true;
            fb->down_since = now;
        }
        fb->quiet_since = now;          // B counts only time on an up link
    }
    if (in->hold) return WFB_DUE_NONE;
    if (fb->lost) return (int32_t)(now - fb->lost_at) >= 0 ? WFB_DUE_LOST : WFB_DUE_NONE;
    if (in->n_nets < 2) return WFB_DUE_NONE;
    if (fb->down)
        return (uint32_t)(now - fb->down_since) >= WFB_LINK_GRACE_MS && (int32_t)(now - fb->rescan_at) >= 0
                   ? WFB_DUE_DOWN : WFB_DUE_NONE;
    return (uint32_t)(now - fb->quiet_since) >= fb->dead_ms ? WFB_DUE_DEAD : WFB_DUE_NONE;
}

int wfb_pick(wifi_fb_t *fb, wfb_due_t due, uint32_t now, int cur, int n_nets, int seen) {
    if (n_nets <= 0) return -1;
    const bool on = cur >= 0 && cur < n_nets;
    const int from_cur = on ? cur : 0;
    if (due == WFB_DUE_LOST) return from_cur;
    // The saved networks in range other than the current one.
    unsigned others = 0;
    if (seen >= 0) {
        const unsigned all = n_nets >= 32 ? ~0u : (1u << n_nets) - 1u;
        others = (unsigned)seen & all & (on ? ~(1u << cur) : ~0u);
    }
    if (due == WFB_DUE_DOWN) {
        if (seen < 0 || others) return from_cur;   // the current one first, then the others
        fb->rescan_at = now + fb->rescan_ms;       // nothing else there: the driver keeps trying the current one
        fb->rescan_ms = doubled(fb->rescan_ms, WFB_RESCAN_MAX_MS);
        return -1;
    }
    if (due == WFB_DUE_DEAD) {
        if (others) {
            for (int i = 0; i < n_nets && i < 32; i++)
                if (others & (1u << i)) return i;   // the first in saved order
        }
        fb->quiet_since = now;                       // nowhere to go (or no scan): look again later, less often
        fb->dead_ms = doubled(fb->dead_ms, WFB_DEAD_MAX_MS);
        return -1;
    }
    return -1;
}

void wfb_ran(wifi_fb_t *fb, wfb_due_t due, uint32_t now, int back_on) {
    if (back_on >= 0) {
        fb->lost = false;
        fb->down = false;
        fb->quiet_since = now;
        fb->rescan_at = now;
        fb->rescan_ms = WFB_RESCAN_MS;
        // A move for an unreachable server proves nothing until the server answers: the next one waits longer.
        if (due == WFB_DUE_DEAD) fb->dead_ms = doubled(fb->dead_ms, WFB_DEAD_MAX_MS);
        return;
    }
    fb->lost = true;
    fb->lost_at = now + WFB_LOST_RETRY_MS;
}
