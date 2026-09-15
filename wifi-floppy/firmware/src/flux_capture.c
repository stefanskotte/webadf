#include "flux_capture.h"
#include "flux_bits.h"
#include "mfm.h"
#include "psram_image.h"
#include "wf_log.h"
#include "hardware/dma.h"
#include "hardware/clocks.h"
#include "pico/time.h"
#include <string.h>

/*
 * WHY A RING AND NOT AN INTERRUPT PER INTERVAL.
 *
 * A written track is ~200 ms of flux with a transition every 4-8 us: on the
 * order of 25,000-50,000 of them, one every few microseconds. An interrupt
 * each would spend most of core0 on prologue and epilogue, on the same core
 * that has to keep servicing the floppy bus. The PIO's RX FIFO is 8 deep --
 * about 32 us -- so polling it directly is not an option either.
 *
 * So the DMA writes into a power-of-two ring and nothing interrupts at all.
 * The service loop reads how far the DMA has got and consumes up to there.
 * 4096 words is ~16 ms of headroom against a loop that turns over every 1-2 ms,
 * which is margin of about ten to one.
 */
#define RING_WORDS      4096u
#define RING_BYTES      (RING_WORDS * 4u)
#define RING_ORDER      14              /* 2^14 == RING_BYTES */

/* One track of MFM plus room for the Amiga writing a slightly long one. */
#define MFM_BUF_BYTES   16384u

static uint32_t ring[RING_WORDS] __attribute__((aligned(RING_BYTES)));
static uint8_t  mfm_buf[MFM_BUF_BYTES];

static PIO      cap_pio;
static uint     cap_sm;
static int      cap_dma = -1;
static uint32_t cap_read;           /* ring index we have consumed to */
static uint32_t pio_hz;

static flux_bits_t bits;
static volatile bool armed;
static volatile uint32_t armed_at_ms;
static volatile bool ended;         /* set by disarm, cleared by take */

// Diagnostics for flux_capture_result_t. Reset on arm.
static uint32_t d_max_backlog, d_max_gap_ms, d_last_poll_ms;
static uint32_t d_cells[3], d_ns_min, d_ns_max;

static void consume(uint32_t word) {
    const uint32_t ns = flux_counter_to_ns(word, pio_hz);
    const int c = mfm_interval_to_bits(ns);
    if (c >= 2 && c <= 4) d_cells[c - 2]++;
    if (ns < d_ns_min) d_ns_min = ns;
    if (ns > d_ns_max) d_ns_max = ns;
    flux_bits_feed(&bits, ns);
}

void flux_capture_init(PIO pio, uint sm) {
    cap_pio = pio;
    cap_sm  = sm;
    cap_dma = dma_claim_unused_channel(true);
    pio_hz  = clock_get_hz(clk_sys);   /* flux_in runs at clkdiv 1.0 */

    dma_channel_config c = dma_channel_get_default_config(cap_dma);
    channel_config_set_transfer_data_size(&c, DMA_SIZE_32);
    channel_config_set_read_increment(&c, false);
    channel_config_set_write_increment(&c, true);
    // Wrap the WRITE address every RING_BYTES, so the channel never finishes
    // and never needs re-arming. The buffer is aligned to its own size
    // because the hardware wrap requires it.
    channel_config_set_ring(&c, true, RING_ORDER);
    channel_config_set_dreq(&c, pio_get_dreq(pio, sm, false));
    dma_channel_configure(cap_dma, &c, ring, &pio->rxf[sm], 0xffffffffu, false);

    flux_bits_init(&bits, mfm_buf, sizeof mfm_buf);
}

/** Where the DMA has written up to, as a ring index. */
static uint32_t dma_head(void) {
    uintptr_t w = (uintptr_t)dma_hw->ch[cap_dma].write_addr;
    return (uint32_t)(((w - (uintptr_t)ring) / 4u) & (RING_WORDS - 1u));
}

void flux_capture_arm(void) {
    if (cap_dma < 0 || armed) return;
    // Everything stale goes first: a FIFO still holding intervals from the
    // last write would put another track's flux at the head of this one.
    pio_sm_set_enabled(cap_pio, cap_sm, false);
    pio_sm_clear_fifos(cap_pio, cap_sm);
    pio_sm_restart(cap_pio, cap_sm);

    dma_channel_abort(cap_dma);
    dma_channel_set_write_addr(cap_dma, ring, false);
    dma_channel_set_trans_count(cap_dma, 0xffffffffu, true);

    cap_read = 0;
    flux_bits_init(&bits, mfm_buf, sizeof mfm_buf);
    d_max_backlog = d_max_gap_ms = 0;
    d_cells[0] = d_cells[1] = d_cells[2] = 0;
    d_ns_min = 0xffffffffu; d_ns_max = 0;
    d_last_poll_ms = to_ms_since_boot(get_absolute_time());
    armed = true;
    armed_at_ms = to_ms_since_boot(get_absolute_time());
    ended = false;
    pio_sm_set_enabled(cap_pio, cap_sm, true);
}

void flux_capture_disarm(void) {
    if (!armed) return;
    pio_sm_set_enabled(cap_pio, cap_sm, false);
    armed = false;
    // NOT decoded here: this runs in the WGATE ISR. The service loop drains
    // what is left and decides what to do with it.
    ended = true;
}

uint32_t flux_capture_poll(void) {
    if (cap_dma < 0) return 0;

    const uint32_t head = dma_head();
    uint32_t n = 0;
    if (armed) {
        const uint32_t now = to_ms_since_boot(get_absolute_time());
        if (now - d_last_poll_ms > d_max_gap_ms) d_max_gap_ms = now - d_last_poll_ms;
        d_last_poll_ms = now;
        const uint32_t backlog = (head - cap_read) & (RING_WORDS - 1u);
        if (backlog > d_max_backlog) d_max_backlog = backlog;
    }

    // Bounded per call, for the same reason wf_log_drain() and display_pump()
    // are: this shares the 1 ms loop with track service. 512 intervals is
    // ~2 ms of flux and a few tens of microseconds of work, so a capture is
    // consumed faster than it arrives without ever owning the loop.
    while (cap_read != head && n < 512u) {
        consume(ring[cap_read]);
        cap_read = (cap_read + 1u) & (RING_WORDS - 1u);
        n++;
    }
    return n;
}

bool flux_capture_timeout(uint32_t now_ms) {
    if (!armed) return false;
    if ((uint32_t)(now_ms - armed_at_ms) <= FLUX_CAPTURE_MAX_MS) return false;

    // Abandoned, NOT completed: `ended` stays clear, so flux_capture_take()
    // never offers this to the decoder. A capture that ran for seconds holds
    // whatever a floating line produced, and handing that to mfm_decode_track
    // would at best waste the work and at worst report sectors that were never
    // written.
    pio_sm_set_enabled(cap_pio, cap_sm, false);
    armed = false;
    ended = false;
    return true;
}

bool flux_capture_take(flux_capture_result_t *out) {
    if (!ended) return false;
    // Drain whatever the DMA landed between the last poll and WGATE going
    // away -- the tail of the track, which is where the last sector lives.
    while (cap_read != dma_head()) {
        consume(ring[cap_read]);
        cap_read = (cap_read + 1u) & (RING_WORDS - 1u);
    }
    ended = false;

    out->complete     = true;
    out->intervals    = bits.intervals;
    out->out_of_range = bits.out_of_range;
    out->overflowed   = bits.overflowed;
    out->mfm          = mfm_buf;
    out->mfm_bytes    = (uint32_t)flux_bits_bytes(&bits);
    out->max_backlog  = d_max_backlog;
    out->max_poll_gap_ms = d_max_gap_ms;
    out->cells[0] = d_cells[0]; out->cells[1] = d_cells[1]; out->cells[2] = d_cells[2];
    out->ns_min = d_ns_min; out->ns_max = d_ns_max;
    return true;
}
