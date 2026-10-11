#ifndef PNET_RING_H
#define PNET_RING_H
/*
 * PaulaNET Phase 1's frame rings: fixed slots, one producer and one consumer on DIFFERENT cores.
 * RX: core1's netif input hook produces, core0 consumes (into the batch the Amiga reads).
 * TX: core0 produces (the Amiga's batch), core1's send worker consumes.
 *
 * THE HANDOFF. head and tail are free-running counters in SRAM; the slots are in PSRAM, which both
 * cores reach through the RP2350's one shared XIP cache (psram_image.c relies on the same).
 *   producer: write the slot's bytes and length -> barrier -> head++   (publish)
 *   consumer: load head -> barrier -> read the slot                    (acquire)
 *   consumer: finish reading -> barrier -> tail += k                   (release the slots)
 *   producer: load tail -> barrier -> overwrite a freed slot           (acquire)
 * The barrier is __dmb() on the board and a sequentially consistent fence on the host, whose test
 * runs a real producer thread against a consumer.
 *
 * A slot: the length (uint16_t, native order) at 0, the frame at 16. A frame is 1..PNET_RING_MTU.
 */
#include <stdint.h>
#include <stdbool.h>

#define PNET_RING_MTU  1518u
#define PNET_RING_SLOT 1536u

typedef struct {
    uint8_t *slots;
    uint32_t n;
    volatile uint32_t head;
    volatile uint32_t tail;
    volatile uint32_t drops;
} pnet_ring_t;

/* False (and an empty, refusing ring) unless n is a power of two. */
bool pnet_ring_init(pnet_ring_t *r, uint8_t *mem, uint32_t n);
uint32_t pnet_ring_count(const pnet_ring_t *r);
uint32_t pnet_ring_space(const pnet_ring_t *r);
/* Producer: the next slot's frame bytes to fill in place, or NULL (full; counted in drops). */
uint8_t *pnet_ring_claim(pnet_ring_t *r);
/* Producer: publishes the claimed slot with `len` bytes (1..PNET_RING_MTU). */
void pnet_ring_commit(pnet_ring_t *r, uint16_t len);
/* Producer: claim + copy + commit. False when full or len is 0 or over PNET_RING_MTU (counted). */
bool pnet_ring_push(pnet_ring_t *r, const uint8_t *f, uint16_t len);
/* Consumer: the i-th frame past the tail, or NULL when there are not i + 1. */
const uint8_t *pnet_ring_peek(const pnet_ring_t *r, uint32_t i, uint16_t *len);
/* Consumer: releases the first k frames (at most count). */
void pnet_ring_drop(pnet_ring_t *r, uint32_t k);
#endif
