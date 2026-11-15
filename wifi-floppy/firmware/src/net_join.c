// See net_join.h. The loop is the SDK's join loop (pico-sdk 2.3.0,
// cyw43_arch_wifi_connect_bssid_until) -- same async join, same re-issue
// while no network matches, same poll and wait -- plus what it saw, the
// leading drop, and the rule that "up" counts only after this attempt's own
// join was seen in progress.
#include "net_join.h"

static void drop_if_held(const net_join_ops_t *ops) {
    if (ops->held(ops->ctx)) ops->drop(ops->ctx);
}

static net_join_t finish(const net_join_ops_t *ops, net_join_t r) {
    if (r != NET_JOIN_OK) drop_if_held(ops);   // the next attempt starts from nothing
    return r;
}

net_join_t net_join_run(const net_join_ops_t *ops) {
    drop_if_held(ops);
    if (ops->join(ops->ctx)) return finish(ops, NET_JOIN_ERROR);

    bool saw_nonet = false;
    bool saw_progress = false;   // JOIN or NOIP read during THIS attempt
    net_link_t last = NET_LINK_DOWN;
    for (;;) {
        net_link_t s = ops->status(ops->ctx);
        if (s == NET_LINK_UP && saw_progress) return NET_JOIN_OK;
        if (s == NET_LINK_BADAUTH) return finish(ops, NET_JOIN_BAD_AUTH);
        if (s == NET_LINK_FAIL)    return finish(ops, NET_JOIN_FAILED);
        if (s == NET_LINK_NONET) {
            // As the SDK: no network yet, keep trying (a router may still be booting).
            saw_nonet = true;
            s = NET_LINK_JOIN;
            if (ops->join(ops->ctx)) return finish(ops, NET_JOIN_ERROR);
        }
        if (s == NET_LINK_JOIN || s == NET_LINK_NOIP) saw_progress = true;
        // A stale UP (never preceded by this attempt's own progress) is not
        // remembered as a state: it says nothing about this network.
        if (s != NET_LINK_UP) last = s;
        if (ops->time_up(ops->ctx)) break;
        ops->wait(ops->ctx);
    }
    if (last == NET_LINK_NOIP) return finish(ops, NET_JOIN_NO_ADDRESS);
    if (saw_nonet) return finish(ops, NET_JOIN_NOT_FOUND);
    return finish(ops, NET_JOIN_TIMEOUT);
}
