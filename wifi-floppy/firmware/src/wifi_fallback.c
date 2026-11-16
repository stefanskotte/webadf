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
    fb->better_since = now;
    fb->better_ms = WFB_BETTER_MS;
    fb->better_cur = -1;
    fb->better_from = -1;
    fb->home_since = now;
}

bool wfb_no_server(const wifi_fb_t *fb) { return fb->down || fb->unheard || fb->fails_seen != fb->fails_answer; }

wfb_due_t wfb_due(wifi_fb_t *fb, const wfb_in_t *in) {
    const uint32_t now = in->now;
    if (!fb->started) {
        wfb_reset(fb, now, in->answers);
        fb->fails_seen = fb->fails_base = fb->fails_answer = in->fails;
    }
    fb->fails_seen = in->fails;
    if (in->answers != fb->answers) {   // the server answered: the network works
        fb->answers = in->answers;
        fb->fails_base = fb->fails_answer = in->fails;
        fb->unheard = false;
        fb->quiet_since = now;
        fb->dead_ms = WFB_DEAD_MS;
        // The return period starts over only once home has stayed up AND answering for a whole period (third
        // review, Important 1): a marginal home network that answers once and drops must not bring the 10 min back.
        if (in->cur == 0 && in->link_up && (uint32_t)(now - fb->home_since) >= fb->better_ms)
            fb->better_ms = WFB_BETTER_MS;
    }
    if (in->cur != 0 || !in->link_up) fb->home_since = now;   // home's unbroken stretch starts again
    if (in->cur != fb->better_cur) {    // a new network: BETTER's period runs from now
        fb->better_cur = in->cur;
        fb->better_since = now;
    }
    if (in->link_up) {
        if (fb->down) {                 // back by itself (or by a run): A starts afresh
            fb->down = false;
            fb->scan_fails = 0;         // a new outage counts its own failed scans (third review)
            fb->fails_base = in->fails; // and B its own failed requests
            fb->quiet_since = now;
            fb->rescan_at = now;
            fb->rescan_ms = WFB_RESCAN_MS;
        }
    } else {
        fb->unheard = true;             // the panel stays marked until the first answer after it
        if (!fb->down) {
            fb->down = true;
            fb->down_since = now;
        }
        fb->quiet_since = now;          // B counts only time on an up link
        fb->fails_base = in->fails;
    }
    if (in->hold) return WFB_DUE_NONE;
    if (fb->lost) return (int32_t)(now - fb->lost_at) >= 0 ? WFB_DUE_LOST : WFB_DUE_NONE;
    if (in->n_nets < 2) return WFB_DUE_NONE;
    if (fb->down)
        return (uint32_t)(now - fb->down_since) >= WFB_LINK_GRACE_MS && (int32_t)(now - fb->rescan_at) >= 0
                   ? WFB_DUE_DOWN : WFB_DUE_NONE;
    if (!in->hold_dead && (uint32_t)(now - fb->quiet_since) >= fb->dead_ms &&
        (uint32_t)(in->fails - fb->fails_base) >= WFB_DEAD_FAILS)
        return WFB_DUE_DEAD;
    if (in->cur > 0 && in->idle && in->cur != in->page_idx && (uint32_t)(now - fb->better_since) >= fb->better_ms) return WFB_DUE_BETTER;
    return WFB_DUE_NONE;
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
        if (seen < 0 && ++fb->scan_fails >= 2) {   // the second failed scan in a row: the rounds anyway
            fb->scan_fails = 0;
            return from_cur;
        }
        if (seen >= 0) fb->scan_fails = 0;
        if (others) return from_cur;               // the current one first, then the others
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
        fb->fails_base = fb->fails_seen;
        fb->dead_ms = doubled(fb->dead_ms, WFB_DEAD_MAX_MS);
        return -1;
    }
    if (due == WFB_DUE_BETTER) {
        if (on && seen >= 0) {
            const unsigned earlier = (unsigned)seen & ((1u << cur) - 1u);
            for (int i = 0; i < cur; i++)
                if (earlier & (1u << i)) { fb->better_from = i; return i; }   // the earliest saved network in range
        }
        fb->better_since = now;                      // none in range: look again in a period
        return -1;
    }
    return -1;
}

void wfb_ran(wifi_fb_t *fb, wfb_due_t due, uint32_t now, int back_on) {
    fb->scan_fails = 0;
    if (back_on >= 0) {
        fb->lost = false;
        fb->no_restart = false;
        fb->down = false;
        fb->quiet_since = now;
        fb->fails_base = fb->fails_seen;
        fb->rescan_at = now;
        fb->rescan_ms = WFB_RESCAN_MS;
        // A move for an unreachable server proves nothing until the server answers: the next one waits longer.
        if (due == WFB_DUE_DEAD) fb->dead_ms = doubled(fb->dead_ms, WFB_DEAD_MAX_MS);
        // A return may be followed by the outage that caused the move, and a return that did not reach the earlier
        // network (a stale password there) counts as an empty scan: either way the next one waits longer.
        if (due == WFB_DUE_BETTER) fb->better_ms = doubled(fb->better_ms, WFB_BETTER_MAX_MS);
        fb->better_cur = back_on;
        fb->better_since = now;
        return;
    }
    fb->lost = true;
    fb->lost_at = now + WFB_LOST_RETRY_MS;
    // Never a restart because of a return (third review, Important 2): the board was online before it. Kept for
    // the whole episode, until a run joins.
    if (due == WFB_DUE_BETTER) {
        fb->no_restart = true;
        fb->better_ms = doubled(fb->better_ms, WFB_BETTER_MAX_MS);
    }
}

int wfb_page_after_run(int page_idx, int back_on) { return back_on >= 0 && back_on != page_idx ? -1 : page_idx; }

int wfb_page_after_remove(int page_idx, int removed) {
    if (page_idx < 0 || removed < 0) return page_idx;
    if (removed == page_idx) return -1;
    return removed < page_idx ? page_idx - 1 : page_idx;
}

int wfb_scan_seen(wfb_due_t due, int seen, int results) {
    if (seen < 0) return -1;
    if (results == 0 && due != WFB_DUE_DOWN) return -1;
    return seen;
}

bool wfb_may_restart(const wifi_fb_t *fb) { return !fb->no_restart; }
bool wfb_returned(const wifi_fb_t *fb, int back_on) { return back_on >= 0 && back_on == fb->better_from; }
