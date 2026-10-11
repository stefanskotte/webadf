#include "flux_capture.h"
#include "flux_bits.h"
#include "mfm.h"
#include "psram_image.h"
#include "wf_log.h"
#include "hardware/dma.h"
#include "hardware/clocks.h"
#include "pico/time.h"
#include <string.h>
#if WF_PNET_LOOP
#include "pnet_rx.h"
#endif

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

/* One HD write, lead gap included (flux_bits.h says how it is sized). */
#define MFM_BUF_BYTES   FLUX_CAPTURE_BUF_BYTES

static uint32_t ring[RING_WORDS] __attribute__((aligned(RING_BYTES)));
static uint8_t  mfm_buf[MFM_BUF_BYTES];

static PIO      cap_pio;
static uint     cap_sm;
static int      cap_dma = -1;
static uint32_t cap_read;           /* ring index we have consumed to */
static uint32_t pio_hz;
/* The capture channel's configuration, EN set: arm() re-applies it to start a capture. Between
 * captures the channel is paused (cap_pause) and flux_in keeps running (flux_capture_init). */
static dma_channel_config cap_cfg;
/* flux_in's first instruction: an arm sends the machine there instead of disabling it. */
static uint     cap_pc0;

static flux_bits_t bits;
static volatile bool armed;
static volatile uint32_t armed_at_ms;
static volatile bool ended;         /* set by disarm, cleared by take */

// Diagnostics for flux_capture_result_t. Reset on arm.
static uint32_t d_max_backlog, d_max_gap_ms, d_last_poll_ms;
static uint32_t d_cells[3], d_ns_min, d_ns_max, d_glitches;
static uint32_t d_count, d_lead_ns, d_min_at;   // HANDOFF 3av (b)
#if WF_PNET_LOOP
// The PaulaNET loopback's raw capture (flux_capture.h). raw_mode is set at arm and read by
// consume() and both takes; a DF0 arm clears it.
static volatile bool raw_mode;
static pnet_rx_t raw_rx;
static volatile uint64_t raw_ended_us;
// A DF0 capture taken and still being decoded: flux_capture_take() hands out mfm_buf itself, and
// the decode reads it for ~3-7 ms after the take. Set by the take, cleared by flux_capture_done()
// (main.c, once the decode is over, on every path) -- and by flux_capture_timeout() once it has
// stood for FLUX_CAPTURE_MAX_MS, so a missed done cannot shut the loopback out for good. While it
// is set flux_capture_idle() is false: a DF1 raw arm then waits (counted busy, the Amiga resends)
// instead of re-initialising the buffer under the decode (final review, Important 1).
static volatile bool held;
static volatile uint32_t held_at_ms;
// The PRE-ARM (pnet_loop.h): a raw capture armed by core0's loop ahead of a DF1 batch, claimed by
// no write yet. While it stands the capture is armed (flux_capture_idle is false, so nothing else
// arms over anything), the poll consumes nothing, and the timeout does not run -- it is not a
// write. Every WGATE assert ends it: a DF1 batch claims it, anything else cancels it, and a DF0
// arm cancels it itself (arm(), below) before it arms. flux_in's start PC, for the raw arms.
static volatile bool prearmed;
#endif

static void consume(uint32_t word) {
    const uint32_t ns = flux_counter_to_ns(word, pio_hz);
#if WF_PNET_LOOP
    if (raw_mode) { pnet_rx_feed(&raw_rx, ns); return; }
#endif
    // Word 0 is not a flux interval: arming only restarts flux_in, so it
    // counts from the arm (or carries the previous capture's count) to the
    // first edge. Measured 2026-10-04 (HANDOFF 3av): the sub-3000 ns minimum
    // that made rev B look glitched was word 0 every time (lead 2613 ns,
    // shortest at word 0), and every real interval was >= 3333 ns. It is
    // logged as `lead` and kept out of the statistics -- min/max, cells and
    // `short` describe the line, not the arm. Still fed to the decoder: it
    // lands before the first sync, where the decoder looks for nothing.
    if (d_count == 0) {
        d_lead_ns = ns;
    } else {
        const int c = mfm_interval_to_bits(ns);
        if (c >= 2 && c <= 4) d_cells[c - 2]++;
        if (ns < d_ns_min) { d_ns_min = ns; d_min_at = d_count; }
        if (ns > d_ns_max) d_ns_max = ns;
        if (flux_ns_is_glitch(ns)) d_glitches++;
    }
    d_count++;
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
    cap_cfg = c;
    dma_channel_configure(cap_dma, &c, ring, &pio->rxf[sm], 0xffffffffu, false);

    flux_bits_init(&bits, mfm_buf, sizeof mfm_buf);
    cap_pc0 = pio_sm_get_pc(pio, sm);    // flux_in_program_init left it at the program's start
    // flux_in runs from here on, and its enable bit is never written again. pio2's CTRL holds the
    // enable bits of every machine on the block -- the radio's too -- and the radio's SDK driver
    // read-modify-writes that register from core1 with no lock: an enable or disable here racing
    // one of those would undo the other (HANDOFF backlog, "pio2 CTRL"). This runs on core0 before
    // core1 starts. With no capture running, the channel is paused and flux_in's FIFO, which it
    // pushes with `noblock`, fills and then drops: nothing reaches the ring.
    pio_sm_set_enabled(pio, sm, true);
}

/* Stops the capture's channel through the atomic CLR alias of its non-triggering control
 * register: no more words reach the ring. flux_in keeps running. */
static void cap_pause(void) {
    hw_clear_bits(&dma_hw->ch[cap_dma].al1_ctrl, DMA_CH0_CTRL_TRIG_EN_BITS);
}

/** Where the DMA has written up to, as a ring index. */
static uint32_t dma_head(void) {
    uintptr_t w = (uintptr_t)dma_hw->ch[cap_dma].write_addr;
    return (uint32_t)(((w - (uintptr_t)ring) / 4u) & (RING_WORDS - 1u));
}

#if WF_PNET_LOOP
static void arm(bool raw);
void flux_capture_arm(void) { arm(false); }
void flux_capture_arm_raw(void) { arm(true); }
static void arm(bool raw) {
#else
void flux_capture_arm(void) {
#endif
#if WF_PNET_LOOP
    // A standing pre-arm is no capture of anyone's: any arm replaces it -- DF0's above all, which
    // must arm exactly as it would without one (WDATA is shared; the `armed` test below would
    // refuse DF0 otherwise).
    flux_capture_prearm_cancel();
#endif
    if (cap_dma < 0 || armed) return;
#if WF_PNET_LOOP
    if (!raw) held = false;          // a DF0 arm re-initialises the buffer anyway: nothing is held
#endif
    // Everything stale goes first: a FIFO still holding intervals from the
    // last write would put another track's flux at the head of this one.
    // flux_in is never disabled (flux_capture_init): the channel stops, the machine restarts at its
    // first instruction (`start: set x, 0`, so word 0 is arm -> first edge), and only THEN is the
    // FIFO emptied -- a word pushed from a stale count before the jump is cleared with the rest.
    // pio_sm_restart writes CTRL's self-clearing SM_RESTART bit through the atomic SET alias.
    cap_pause();
    dma_channel_abort(cap_dma);
    pio_sm_restart(cap_pio, cap_sm);
    pio_sm_exec(cap_pio, cap_sm, pio_encode_jmp(cap_pc0));
    pio_sm_clear_fifos(cap_pio, cap_sm);

    cap_read = 0;
#if WF_PNET_LOOP
    raw_mode = raw;
    // O(1): pnet_rx clears the buffer lazily, from the loop, as its bits land (pnet_rx.h). A 32 KB
    // memset here cost ~55-95 us in this ISR before the PIO below was enabled -- against a first
    // sync pulse ~32 us after Paula starts the write (final review, Important 2).
    if (raw) {
        pnet_rx_init(&raw_rx, mfm_buf, sizeof mfm_buf);
        // The sentinel the pre-arm's edge test reads (flux_capture_prearm_edges): the DMA is
        // aborted above and not yet re-triggered, so nothing lands before this store.
        ring[0] = 0u;
    } else
#endif
    flux_bits_init(&bits, mfm_buf, sizeof mfm_buf);
    d_max_backlog = d_max_gap_ms = 0;
    d_cells[0] = d_cells[1] = d_cells[2] = 0;
    d_ns_min = 0xffffffffu; d_ns_max = 0;
    d_glitches = 0;
    d_count = d_lead_ns = d_min_at = 0;
    d_last_poll_ms = to_ms_since_boot(get_absolute_time());
    armed = true;
    armed_at_ms = to_ms_since_boot(get_absolute_time());
    ended = false;
    // Last: the channel runs again from the ring's start (cap_cfg has EN set, and this triggers it).
    dma_channel_configure(cap_dma, &cap_cfg, ring, &cap_pio->rxf[cap_sm], 0xffffffffu, true);
}

void flux_capture_disarm(void) {
    if (!armed) return;
    cap_pause();
    armed = false;
#if WF_PNET_LOOP
    raw_ended_us = time_us_64();
#endif
    // NOT decoded here: this runs in the WGATE ISR. The service loop drains
    // what is left and decides what to do with it.
    ended = true;
}

uint32_t flux_capture_poll(void) {
    if (cap_dma < 0) return 0;
#if WF_PNET_LOOP
    // A standing pre-arm: whatever is in the ring is no write's (WGATE has not claimed it). Left
    // where it is, for flux_capture_prearm_edges to see, and never fed to the decoder.
    if (prearmed) return 0;
#endif

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
#if WF_PNET_LOOP
    // The safety clear for `held`: a decode is milliseconds, never FLUX_CAPTURE_MAX_MS.
    if (held && (uint32_t)(now_ms - held_at_ms) > FLUX_CAPTURE_MAX_MS) held = false;
    // A pre-arm is not a write, however long it stands: its timeout starts at the claim.
    if (prearmed) return false;
#endif
    if (!armed) return false;
    if ((uint32_t)(now_ms - armed_at_ms) <= FLUX_CAPTURE_MAX_MS) return false;

    // Abandoned, NOT completed: `ended` stays clear, so flux_capture_take()
    // never offers this to the decoder. A capture that ran for seconds holds
    // whatever a floating line produced, and handing that to mfm_decode_track
    // would at best waste the work and at worst report sectors that were never
    // written.
    cap_pause();
    armed = false;
    ended = false;
    return true;
}

bool flux_capture_take(flux_capture_result_t *out) {
#if WF_PNET_LOOP
    if (raw_mode) return false;      // a loopback batch: flux_capture_take_raw's
#endif
    if (!ended) return false;
    // Drain whatever the DMA landed between the last poll and WGATE going
    // away -- the tail of the track, which is where the last sector lives.
    while (cap_read != dma_head()) {
        consume(ring[cap_read]);
        cap_read = (cap_read + 1u) & (RING_WORDS - 1u);
    }
#if WF_PNET_LOOP
    // Before `ended` clears, so flux_capture_idle() never sees a gap between the two.
    held_at_ms = to_ms_since_boot(get_absolute_time());
    held = true;
#endif
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
    out->lead_ns = d_lead_ns; out->min_at = d_min_at;
    out->glitches = d_glitches;
    return true;
}

#if WF_PNET_LOOP
bool flux_capture_idle(void) { return !armed && !ended && !held; }

bool flux_capture_prearm_raw(void) {
    if (!flux_capture_idle()) return false;
    arm(true);
    if (!armed) return false;
    raw_rx.prearmed = true;          // every edge is seen: the measured sync, never implied
    prearmed = true;
    return true;
}

bool flux_capture_prearmed(void) { return prearmed; }

bool flux_capture_prearm_edges(void) {
    if (!prearmed) return false;
    // Anything the DMA has written (ring[0] is the sentinel arm() zeroed; a pushed word is never 0
    // short of a 2^32-iteration count), or still in the FIFO for it.
    const volatile uint32_t *r0 = &ring[0];
    return (uintptr_t)dma_hw->ch[cap_dma].write_addr != (uintptr_t)ring || *r0 != 0u ||
           !pio_sm_is_rx_fifo_empty(cap_pio, cap_sm);
}

bool flux_capture_prearm_claim(void) {
    if (!prearmed) return false;
    prearmed = false;
    // The write starts now: the timeout and the poll-gap statistic count from here.
    const uint32_t now = to_ms_since_boot(get_absolute_time());
    armed_at_ms = now;
    d_last_poll_ms = now;
    return true;
}

bool flux_capture_prearm_cancel(void) {
    if (!prearmed) return false;
    // As the timeout abandons a capture: stopped, and `ended` stays clear, so no take ever sees
    // it. raw_mode stays set, which flux_capture_take() refuses anyway; the next arm resets all.
    cap_pause();
    prearmed = false;
    armed = false;
    ended = false;
    return true;
}

void flux_capture_done(void) { held = false; }

bool flux_capture_take_raw(flux_capture_raw_t *out) {
    if (!ended || !raw_mode) return false;
    while (cap_read != dma_head()) {          // the tail, as flux_capture_take does
        consume(ring[cap_read]);
        cap_read = (cap_read + 1u) & (RING_WORDS - 1u);
    }
    ended = false;
    out->bytes        = mfm_buf;
    out->nbytes       = (uint32_t)pnet_rx_bytes(&raw_rx);
    out->words        = raw_rx.words;
    out->lead_ns      = raw_rx.lead_ns;
    out->sync_ns      = raw_rx.sync_ns;
    out->pw_ns        = raw_rx.pw_ns;
    out->hunt_n       = raw_rx.hunt_n;
    out->implied      = raw_rx.implied;
    out->sync_ok      = raw_rx.sync_ok;
    out->overflowed   = raw_rx.overflowed;
    out->out_of_range = raw_rx.out_of_range;
    out->max_backlog  = d_max_backlog;
    out->ended_us     = raw_ended_us;
    out->prearmed     = raw_rx.prearmed;
    return true;
}
#endif
