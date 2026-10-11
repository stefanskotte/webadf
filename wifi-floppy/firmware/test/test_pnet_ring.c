#include "harness.h"
#include "../src/pnet_ring.h"
#include <pthread.h>
#include <stdint.h>
#include <string.h>
#include <time.h>

static uint8_t mem[64 * PNET_RING_SLOT];

static void frames_come_out_in_order(void) {
    pnet_ring_t r;
    CHECK(pnet_ring_init(&r, mem, 4), "4 is a power of two");
    const uint8_t a[3] = {1, 2, 3}, b[1] = {9};
    CHECK(pnet_ring_push(&r, a, 3) && pnet_ring_push(&r, b, 1), "two pushes");
    CHECK_EQ_INT(pnet_ring_count(&r), 2);
    CHECK_EQ_INT(pnet_ring_space(&r), 2);
    uint16_t len = 0;
    const uint8_t *p = pnet_ring_peek(&r, 0, &len);
    CHECK(p && len == 3 && p[0] == 1 && p[2] == 3, "first");
    p = pnet_ring_peek(&r, 1, &len);
    CHECK(p && len == 1 && p[0] == 9, "second, by index");
    CHECK(pnet_ring_peek(&r, 2, &len) == NULL, "no third");
    pnet_ring_drop(&r, 1);
    p = pnet_ring_peek(&r, 0, &len);
    CHECK(p && len == 1 && p[0] == 9, "after the drop the second is first");
}

static void a_full_ring_drops_and_counts(void) {
    pnet_ring_t r;
    pnet_ring_init(&r, mem, 4);
    uint8_t f[PNET_RING_MTU];
    for (unsigned i = 0; i < 4; i++) { memset(f, (int)i, sizeof f); CHECK(pnet_ring_push(&r, f, PNET_RING_MTU), "fits"); }
    CHECK(!pnet_ring_push(&r, f, 64), "a fifth does not");
    CHECK(pnet_ring_claim(&r) == NULL, "nor a claim");
    CHECK_EQ_INT(r.drops, 2);
    uint16_t len;
    const uint8_t *p = pnet_ring_peek(&r, 3, &len);
    CHECK(p && len == PNET_RING_MTU && p[0] == 3 && p[PNET_RING_MTU - 1] == 3, "the fourth intact");
    /* Nothing was written past the four slots. */
    CHECK_EQ_INT(mem[4 * PNET_RING_SLOT], 0);
    pnet_ring_drop(&r, 2);
    CHECK_EQ_INT(pnet_ring_space(&r), 2);
    CHECK(pnet_ring_push(&r, f, 64), "room again");
}

static void bad_lengths_are_refused(void) {
    pnet_ring_t r;
    pnet_ring_init(&r, mem, 4);
    uint8_t f[PNET_RING_MTU + 1];
    memset(f, 0, sizeof f);
    CHECK(!pnet_ring_push(&r, f, 0), "empty");
    CHECK(!pnet_ring_push(&r, f, PNET_RING_MTU + 1), "too long");
    CHECK_EQ_INT(pnet_ring_count(&r), 0);
    CHECK_EQ_INT(r.drops, 2);
}

static void claim_and_commit_fill_in_place(void) {
    pnet_ring_t r;
    pnet_ring_init(&r, mem, 4);
    uint8_t *d = pnet_ring_claim(&r);
    CHECK(d != NULL, "a slot");
    CHECK_EQ_INT(pnet_ring_count(&r), 0);                    /* not published yet */
    d[0] = 0xAB; d[99] = 0xCD;
    pnet_ring_commit(&r, 100);
    uint16_t len;
    const uint8_t *p = pnet_ring_peek(&r, 0, &len);
    CHECK(p == d && len == 100 && p[99] == 0xCD, "the claimed bytes, published");
}

static void indices_wrap(void) {
    pnet_ring_t r;
    pnet_ring_init(&r, mem, 4);
    r.head = r.tail = 0xFFFFFFFEu;
    const uint8_t f[2] = {7, 8};
    for (unsigned i = 0; i < 4; i++) CHECK(pnet_ring_push(&r, f, 2), "across the wrap");
    CHECK_EQ_INT(pnet_ring_count(&r), 4);
    CHECK_EQ_INT(pnet_ring_space(&r), 0);
    pnet_ring_drop(&r, 9);                                   /* more than there are: all */
    CHECK_EQ_INT(pnet_ring_count(&r), 0);
    CHECK_EQ_INT(r.tail, 2);
}

static void init_refuses_what_is_not_a_power_of_two(void) {
    pnet_ring_t r;
    CHECK(!pnet_ring_init(&r, mem, 6), "6");
    CHECK(!pnet_ring_init(&r, mem, 0), "0");
    const uint8_t f[1] = {1};
    CHECK(!pnet_ring_push(&r, f, 1), "and the ring refuses");
}

/* A real second thread: the producer pushes T frames, each length and content a function of its
 * sequence number; the consumer checks every one, in order. A missing barrier shows as a frame
 * whose length or bytes are not yet (or no longer) the ones published. */
#define T_FRAMES 200000u
static pnet_ring_t tr;
static volatile int stop_producer;   /* the consumer gave up: let the producer go */
static double now_s(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec * 1e-9;
}
static uint16_t len_of(uint32_t i) { return (uint16_t)(1u + (i * 7u) % PNET_RING_MTU); }
static void *producer(void *arg) {
    (void)arg;
    static uint8_t f[PNET_RING_MTU];
    for (uint32_t i = 0; i < T_FRAMES;) {
        const uint16_t n = len_of(i);
        memset(f, (int)(i & 0xFFu), n);
        if (pnet_ring_push(&tr, f, n)) i++;
        else if (stop_producer) break;
    }
    return NULL;
}
static void the_ring_survives_two_threads(void) {
    pnet_ring_init(&tr, mem, 8);
    pthread_t t;
    stop_producer = 0;
    if (pthread_create(&t, NULL, producer, NULL) != 0) { CHECK(0, "pthread_create failed"); return; }
    uint32_t bad = 0;
    const double deadline = now_s() + 30.0;   /* 200,000 frames take well under a second */
    int timed_out = 0;
    for (uint32_t i = 0; i < T_FRAMES;) {
        uint16_t n;
        const uint8_t *p = pnet_ring_peek(&tr, 0, &n);
        if (!p) {
            if (now_s() > deadline) { timed_out = 1; break; }   /* a frame was lost: fail, do not spin */
            continue;
        }
        const uint8_t v = (uint8_t)(i & 0xFFu);
        if (n != len_of(i) || p[0] != v || p[n - 1] != v || p[n / 2] != v) bad++;
        pnet_ring_drop(&tr, 1);
        i++;
    }
    stop_producer = 1;
    pthread_join(t, NULL);
    CHECK(!timed_out, "the consumer timed out waiting for a frame");
    if (timed_out) return;
    CHECK_EQ_INT(bad, 0);
    CHECK_EQ_INT(pnet_ring_count(&tr), 0);
}

int main(void) {
    RUN(frames_come_out_in_order);
    RUN(a_full_ring_drops_and_counts);
    RUN(bad_lengths_are_refused);
    RUN(claim_and_commit_fill_in_place);
    RUN(indices_wrap);
    RUN(init_refuses_what_is_not_a_power_of_two);
    RUN(the_ring_survives_two_threads);
    return REPORT();
}
