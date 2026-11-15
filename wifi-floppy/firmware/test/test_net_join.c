// net_join.c against a model of the radio driver's link states (review I1).
//
// The model keeps what the real driver keeps: a station netif whose link flag
// and address survive a new join (only a link-down event, or our drop, clears
// them), and a join state the join call resets. Status reads like the
// driver's: UP if link + address, NOIP if link only, else the join state.
#include "harness.h"
#include "../src/net_join.h"
#include <string.h>

typedef enum { EV_NONE, EV_ASSOC, EV_LEASE, EV_NONET, EV_BADAUTH, EV_FAIL } ev_t;

typedef struct {
    // the driver
    bool       link_up;
    bool       has_ip;
    net_link_t join_state;
    // the network being joined: what happens on each wait, in order
    ev_t       script[64];
    int        n_script, step;
    int        waits, max_waits;   // the deadline, in waits
    // what the loop did
    int        joins, drops;
    bool       drop_broken;        // a drop that clears nothing (belt and braces)
} fake_t;

static net_link_t f_status(void *v) {
    fake_t *f = v;
    if (f->link_up && f->has_ip) return NET_LINK_UP;
    if (f->link_up) return NET_LINK_NOIP;
    return f->join_state;
}
static int  f_join(void *v)    { fake_t *f = v; f->joins++; f->join_state = NET_LINK_JOIN; return 0; }
static void f_drop(void *v)    {
    fake_t *f = v;
    f->drops++;
    if (f->drop_broken) return;
    f->link_up = false;
    f->has_ip = false;
}
static bool f_time_up(void *v) { fake_t *f = v; return f->waits >= f->max_waits; }
static void f_wait(void *v) {
    fake_t *f = v;
    f->waits++;
    ev_t e = f->step < f->n_script ? f->script[f->step++] : EV_NONE;
    switch (e) {
    case EV_ASSOC:   f->link_up = true; break;
    case EV_LEASE:   f->has_ip = true; break;
    case EV_NONET:   f->join_state = NET_LINK_NONET; break;
    case EV_BADAUTH: f->join_state = NET_LINK_BADAUTH; break;
    case EV_FAIL:    f->join_state = NET_LINK_FAIL; break;
    case EV_NONE:    break;
    }
}

static net_join_t run(fake_t *f, const ev_t *script, int n) {
    memcpy(f->script, script, sizeof(ev_t) * (size_t)n);
    f->n_script = n;
    f->step = 0;
    f->waits = 0;
    if (!f->max_waits) f->max_waits = 30;
    const net_join_ops_t ops = { f, f_status, f_join, f_drop, f_time_up, f_wait };
    return net_join_run(&ops);
}

static void test_a_clean_join(void) {
    fake_t f = {0};
    const ev_t s[] = { EV_NONE, EV_ASSOC, EV_LEASE };
    CHECK_EQ_INT(run(&f, s, 3), NET_JOIN_OK);
    CHECK(f.link_up && f.has_ip, "joined");
}

// The review's case: A associated but its lease came too late, so A's attempt
// timed out as NO_ADDRESS -- and then the lease landed. The netif now reads UP.
// B (absent) must not "join" on that.
static void test_a_stale_up_from_the_last_network_is_not_this_join(void) {
    fake_t f = {0};
    const ev_t a[] = { EV_ASSOC };   // associated, never a lease within the deadline
    f.max_waits = 5;
    CHECK_EQ_INT(run(&f, a, 1), NET_JOIN_NO_ADDRESS);
    CHECK(!f.link_up && !f.has_ip, "a failed attempt drops what it held");
    // The model of the late lease: A's association and address come back as
    // the driver would leave them if nothing dropped them.
    f.link_up = true;
    f.has_ip = true;
    CHECK_EQ_INT(f_status(&f), NET_LINK_UP);   // stale UP, before B starts
    const ev_t b[] = { EV_NONET, EV_NONET, EV_NONET };
    int drops = f.drops;
    CHECK_EQ_INT(run(&f, b, 3), NET_JOIN_NOT_FOUND);
    CHECK(f.drops >= drops + 2, "B dropped first, and again when it failed");
}

// Belt and braces: even when the drop clears nothing, a stale UP is never
// taken as this attempt's success.
static void test_up_counts_only_after_this_attempt_was_seen_joining(void) {
    fake_t f = {0};
    f.drop_broken = true;
    f.link_up = true;
    f.has_ip = true;   // stale, from anywhere
    f.max_waits = 5;
    const ev_t none[] = { EV_NONE };
    // The join resets the join state, but the stale netif keeps reading UP: no
    // JOIN/NOIP is ever seen, so this is not a success.
    CHECK(run(&f, none, 1) != NET_JOIN_OK, "a stale UP is not a join");
}

// A wrong password in the portal must not "verify" on a stale UP either.
static void test_a_wrong_password_after_a_good_join_is_still_wrong(void) {
    fake_t f = {0};
    const ev_t good[] = { EV_ASSOC, EV_LEASE };
    CHECK_EQ_INT(run(&f, good, 2), NET_JOIN_OK);   // joined A (the board is on it)
    const ev_t bad[] = { EV_NONE, EV_BADAUTH };
    CHECK_EQ_INT(run(&f, bad, 2), NET_JOIN_BAD_AUTH);
    CHECK(!f.link_up, "and nothing is left joined");
}

static void test_each_outcome(void) {
    fake_t f = {0};
    const ev_t nonet[] = { EV_NONET, EV_NONET };
    f.max_waits = 4;
    CHECK_EQ_INT(run(&f, nonet, 2), NET_JOIN_NOT_FOUND);
    CHECK(f.joins >= 3, "re-issued the join on every no-network, as the SDK does");
    fake_t g = {0};
    const ev_t fail[] = { EV_FAIL };
    CHECK_EQ_INT(run(&g, fail, 1), NET_JOIN_FAILED);
    fake_t h = {0};
    h.max_waits = 3;
    const ev_t slow[] = { EV_NONE };
    CHECK_EQ_INT(run(&h, slow, 1), NET_JOIN_TIMEOUT);
    // Found after a no-network, then associated without a lease: no address wins.
    fake_t k = {0};
    k.max_waits = 6;
    const ev_t late[] = { EV_NONET, EV_NONE, EV_ASSOC };
    CHECK_EQ_INT(run(&k, late, 3), NET_JOIN_NO_ADDRESS);
}

int main(void) {
    RUN(test_a_clean_join);
    RUN(test_a_stale_up_from_the_last_network_is_not_this_join);
    RUN(test_up_counts_only_after_this_attempt_was_seen_joining);
    RUN(test_a_wrong_password_after_a_good_join_is_still_wrong);
    RUN(test_each_outcome);
    return REPORT();
}
