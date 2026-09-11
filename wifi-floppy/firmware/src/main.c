// ---------------------------------------------------------------------------
// WiFi floppy emulator — Pico 2 W main.
// Core 0: floppy bus real-time (STEP/SEL ISRs, DMA feed, INDEX pulse).
// Core 1: WiFi + track streaming from the ADF webservice.
// ---------------------------------------------------------------------------
#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "pico/cyw43_arch.h"
#include "pico/flash.h"
#include "pico/time.h"
#include "hardware/pio.h"
#include "hardware/dma.h"
#include "hardware/irq.h"
#include "floppy.pio.h"
#include "floppy_io.h"
#include "dskchg.h"
#include "track_cache.h"
#include "psram_image.h"
#include "image_loader.h"
#include "transport.h"
#include "device_client.h"
#include "token_store.h"
#include "sntp_time.h"
#include "provisioning.h"
#include "config_store.h"
#include "portal_net.h"
#include "lwip/netif.h"   // default_route_str(): netif_default, see portal_stop()
#include <stdio.h>
#include "wf_log.h"
#include "activity_led.h"
#include "i2c_probe.h"
#include <string.h>

// transport_tls.c is device-only (no host test exercises it, unlike every
// other file this task wires in), so it has no shared header of its own --
// see CMakeLists.txt's -Wl,-u,tls_transport comment for how it stays
// linked in regardless of whether anything referenced it yet. Declaring
// the one entry point here, now that this file is that "anything".
transport_t *tls_transport(void);

// Write-back (WGATE -> PSRAM -> flush to the server) does not exist yet --
// flux_in_program is only ever set up, never enabled, and there is no code
// anywhere that walks psram_image_next_dirty(). Until that lands, WPROT
// must stay asserted for every mounted disk regardless of what the server
// reports, because presenting a disk the server marks writable would let
// the Amiga believe writes land somewhere, and every one of them would
// silently vanish. See core1_main's WPROT comment for how this is wired;
// flip this to 1 (and see the comment there) once the write path exists.
#define WRITE_BACK_IMPLEMENTED 0

static PIO  pio = pio0;
static uint sm_out, sm_in;
static int  dma_ch;

static volatile int  cur_cyl   = 0;
static volatile int  cur_side  = 0;
static volatile int  want_track = -1;      // core0 -> core1 request
static volatile bool track_live = false;

static uint32_t track_words[(TRACK_MAX_BYTES + 3) / 4];
static uint32_t track_word_count;

// ---------------------------------------------------------------- DMA feed
// Revolutions of the current stream, the previous stream's total, and whether
// this stream has already logged its INDEX. Touched from dma_irq (an ISR) and
// from start_streaming on core0; volatile for the same reason track_live is.
static volatile uint32_t rev_count;
static volatile uint32_t prev_revs;
static volatile bool     index_traced;

static void start_streaming(const uint8_t *mfm, uint32_t bit_count) {
    uint32_t nwords = (bit_count + 31) / 32;

    // Carry the outgoing track's revolution count into the next INDEX record
    // and restart the counters. See dma_irq(): INDEX is traced ONCE per
    // stream, not once per revolution.
    prev_revs = rev_count;
    rev_count = 0;
    index_traced = false;

    // Review (final), Important 3: the abort MUST come before the repack
    // loop, not after it. `track_words` is the DMA's read address; the
    // caller clearing `track_live` only stops dma_irq() re-arming at the
    // next revolution wrap, it does not stop a transfer already in flight.
    // Rewriting the buffer underneath a running channel hands the PIO a
    // mixture of the outgoing and incoming track for the remainder of that
    // revolution -- one torn revolution, which the Amiga reads as a bad
    // sector on a drive that is otherwise fine. That was survivable while
    // this only ran on a seek; it now also runs on every swap and on
    // eject-then-remount, at times nobody chose.
    dma_channel_abort(dma_ch);

    // repack bytes MSB-first into words for autopull
    for (uint32_t i = 0; i < nwords; i++) {
        uint32_t w = 0;
        for (int b = 0; b < 4; b++) w = (w << 8) | mfm[i * 4 + b];
        track_words[i] = w;
    }
    track_word_count = nwords;
    dma_channel_config c = dma_channel_get_default_config(dma_ch);
    channel_config_set_transfer_data_size(&c, DMA_SIZE_32);
    channel_config_set_read_increment(&c, true);
    channel_config_set_write_increment(&c, false);
    channel_config_set_dreq(&c, pio_get_dreq(pio, sm_out, true));
    dma_channel_configure(dma_ch, &c, &pio->txf[sm_out],
                          track_words, track_word_count, true);
    dma_channel_set_irq0_enabled(dma_ch, true);
    track_live = true;
}

// index pulse + wrap: retrigger DMA each revolution
static int64_t index_off(alarm_id_t id, void *ud) {
    gpio_put(PIN_INDEX, OUT_RELEASE);
    return 0;
}
// Flash writes disable XIP. This handler re-arms the DMA each revolution and
// raises INDEX; stalling it mid-revolution presents to the Amiga as a
// malformed revolution -- a flaky drive, essentially undiagnosable without a
// scope.
//
// Review round 1, Minor M-1: moved into RAM with __not_in_flash_func, but
// this alone is NOT sufficient -- objdump shows this handler's own call
// graph still reaches into flash: the veneers it calls out through resolve
// to alarm_pool_get_default()/time_us_64()/alarm_pool_add_alarm_at(), and
// index_off() -- the callback add_alarm_in_us() installs below -- is itself
// a flash-resident function. What actually prevents this handler stalling
// mid-flash-write is main()'s flash_safe_execute_core_init() call, which
// lets core1's token write park core0 (interrupts disabled, nothing
// executing at all) for the write's duration -- see that comment for the
// real argument. __not_in_flash_func is kept anyway as a second, cheap
// layer, but it is not "either mitigation would suffice alone": only the
// lockout actually covers this handler's full call graph.
static void __isr __not_in_flash_func(dma_irq)(void) {
    dma_hw->ints0 = 1u << dma_ch;
    if (!track_live) return;
    dma_channel_set_read_addr(dma_ch, track_words, false);
    dma_channel_set_trans_count(dma_ch, track_word_count, true);
    gpio_put(PIN_INDEX, OUT_ASSERT);                 // ~2 ms index at wrap
    add_alarm_in_us(INDEX_PULSE_US, index_off, NULL, true);
    rev_count++;
    // ONCE PER STREAM, NOT ONCE PER REVOLUTION, and the difference is not
    // cosmetic. At 300 RPM a per-revolution record is a permanent ~5 Hz
    // producer, and wf_log's ring keeps OLDEST and drops NEWEST -- a policy
    // written for bursts. Measured on a rev A2 board 2026-09-11: a board left
    // mounted and unattended for 8.6 h reported "151362 record(s) dropped",
    // which is INDEX alone (151362 / 4.93 Hz = 8.5 h). The ring saturates
    // about thirteen seconds after a disk mounts and stays that way, so ANY
    // later event -- a TRACK-MISS, an error, an eject -- is dropped before a
    // terminal can ever be attached. The boot history survives, which is the
    // policy working as designed; everything after it did not.
    //
    // Edge-triggered, this pairs with TRACK-SERVED: one line proving the DMA
    // actually wrapped on the track just loaded. `b` carries how many
    // revolutions the PREVIOUS track completed, which is the fact a
    // per-revolution flood was standing in for -- and it costs one record per
    // seek instead of five per second. A live "still spinning" indicator is
    // what the activity LED in the backlog is for; it is not the log's job.
    if (!index_traced) {
        index_traced = true;
        wf_trace(WF_EV_INDEX, (uint32_t)track_word_count, prev_revs);
    }
}

// ---------------------------------------------------------------- bus ISRs
static void __isr gpio_isr(uint gpio, uint32_t events) {
    if (gpio == PIN_STEP && (events & GPIO_IRQ_EDGE_FALL)) {
        bool outwards = gpio_get(PIN_DIR);           // DIRC high = towards 0
        if (outwards) { if (cur_cyl > 0) cur_cyl--; }
        else          { if (cur_cyl < NUM_CYL - 1) cur_cyl++; }
        gpio_put(PIN_TRK0, cur_cyl == 0 ? OUT_ASSERT : OUT_RELEASE);
        dskchg_on_step();
        want_track = cur_cyl * 2 + cur_side;
        wf_trace(WF_EV_STEP, (uint32_t)cur_cyl, outwards ? 1u : 0u);
        led_blip();
    } else if (gpio == PIN_SEL0 && (events & GPIO_IRQ_EDGE_FALL)) {
        dskchg_on_sel_edge();
        wf_trace(WF_EV_SEL, 1, 0);
    } else if (gpio == PIN_MTR) {
        bool running = !gpio_get(PIN_MTR);           // active low
        dskchg_on_motor(running);
        wf_trace(WF_EV_MOTOR, running ? 1u : 0u, 0);
    } else if (gpio == PIN_SIDE) {
        cur_side = gpio_get(PIN_SIDE) ? 0 : 1;       // low = side 1
        want_track = cur_cyl * 2 + cur_side;
        wf_trace(WF_EV_SIDE, (uint32_t)cur_side, (uint32_t)want_track);
    }
}

static uint32_t clock_ms(void) {
    return to_ms_since_boot(get_absolute_time());
}

// Coarse "psramFree" for the status report (device_client.h): there is no
// general allocator here -- PSRAM is two fixed whole-disk slots
// (psram_image.h) -- so this reports headroom in whichever slot core1 is
// free to fetch into (psram_inactive_slot()), the only one it ever writes.
static int psram_free_estimate(void) {
    if (!psram_image_available()) return 0;
    return psram_image_missing_count(psram_inactive_slot()) * (int)TRACK_MAX_BYTES;
}

static int wifi_rssi(void) {
    int32_t rssi = 0;
    cyw43_wifi_get_rssi(&cyw43_state, &rssi);
    return (int)rssi;
}

// Renders lwIP's default route. This exists for ONE open question that plan
// 4b's ledger has carried unanswered since it was written: whether
// portal_stop() really restores the STA netif as netif_default after the
// provisioning AP tears down, or leaves it NULL. Nothing else on the board
// can answer it -- a wrong answer looks exactly like "TLS is broken", since
// every handshake fails with no route and no message. Call it AFTER
// portal_stop() and after association.
//
// Reads under the lwIP lock: cyw43_arch_lwip_begin()/end() is recursive, so
// this is safe from core1's ordinary flow. Never call it from an interrupt.
static const char *default_route_str(void) {
    static char buf[48];
    cyw43_arch_lwip_begin();
    struct netif *nif = netif_default;
    if (!nif) {
        cyw43_arch_lwip_end();
        return "NONE -- netif_default is NULL";
    }
    snprintf(buf, sizeof buf, "%c%c%d ip=%s", nif->name[0], nif->name[1],
             nif->num, ip4addr_ntoa(netif_ip4_addr(nif)));
    cyw43_arch_lwip_end();
    return buf;
}

static void mac_address_string(char *out, size_t out_len) {
    uint8_t mac[6] = {0};
    cyw43_wifi_get_mac(&cyw43_state, CYW43_ITF_STA, mac);
    snprintf(out, out_len, "%02x:%02x:%02x:%02x:%02x:%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

// ---------------------------------------------------------------- core 1
// Core 1's stack. multicore_launch_core1() would put this in SCRATCH_X --
// PICO_CORE1_STACK_SIZE, which defaults to 2 KB and cannot exceed the
// 4 KB the whole SCRATCH_X bank holds. Neither figure is enough, and the
// reason is not this file's own frames:
//
//   * core1_main -> dc_step -> dc_exchange -> tls_connect reaches
//     mbedtls_ctr_drbg_seed -> block_cipher_df -> aes_gen_tables, ~2.0 KB
//     of mbedTLS below tls_connect alone.
//   * pico_cyw43_arch_lwip_threadsafe_background services lwIP from a
//     low-priority IRQ on THIS core, so altcp_mbedtls_lower_recv ->
//     mbedtls_ssl_handshake -> ..._hkdf_expand_label -> sha256 (~2.6 KB)
//     lands on this same stack, on top of whatever the foreground is
//     doing, at a moment nothing here chooses.
//
// Task 7 re-measured this after adding the portal's DHCP/DNS/HTTP servers
// to this same core, rather than assuming the AP and TLS phases not
// overlapping in TIME means their stack use doesn't need re-checking --
// plan 4a's 2 KB-stack Critical happened by exactly that kind of
// unverified assumption. Method: built ELF, `-fstack-usage` per function,
// cross-referenced against `arm-none-eabi-objdump -d`'s actual `bl`
// targets (not guessed from names) to find the actual longest call chain
// by summed frame size, with the two known indirect edges (dc_exchange's
// transport_t calls into tls_connect/tls_write/tls_read; lwIP's
// callback-based dispatch into the recv handlers) bridged by hand since a
// static disassembly can't see through a function pointer.
//
//   * Foreground, core1_main down through tls_connect's mbedtls setup
//     (mbedtls_ctr_drbg_seed -> ctr_drbg_reseed_internal -> block_cipher_df
//     -> aes_gen_tables): 2536 B, confirmed by an independent re-derivation
//     (round 2 review). (Before this task, with core1_main's smaller
//     pre-provisioning frame: 2304 B -- this task's +232 B here is
//     entirely provisioning_t/device_config_t locals in core1_main itself;
//     see its definition.)
//   * IRQ: the first pass here started counting from
//     altcp_mbedtls_lower_recv (2576 B down through the deepest branch of
//     the TLS 1.3 client handshake state machine --
//     mbedtls_ssl_tls13_compute_handshake_transform -> ..._evolve_secret
//     -> ..._hkdf_expand_label -> PSA's HMAC/SHA-256 path, found by
//     exhaustively comparing every branch of mbedtls_ssl_tls13_handshake_
//     client_step's dispatch, not just the one named here; the
//     next-largest, ...compute_application_transform, is close behind).
//     That undercounted the true chain by 448 B -- the same mistake plan
//     4a's original 2 KB estimate made, missing everything ABOVE the
//     point picked as the walk's root. The actual root is the vector:
//     low_priority_worker_irq -> async_context_base_execute_once ->
//     cyw43_poll_worker -> cyw43_poll_func -> cyw43_ll_ioctl ->
//     cyw43_do_ioctl -> cyw43_cb_process_ethernet -> ethernet_input ->
//     ip4_input -> tcp_input, +312 B of dispatch this core also pays for
//     every inbound packet before ever reaching altcp_mbedtls_lower_recv.
//     Separately, the hardware exception entry itself is not the 32 B
//     basic AAPCS frame this comment implicitly assumed -- runtime_init.c
//     enables the FPU (CPACR CP10/11), and alarm_pool_irq_handler/
//     mbedtls_sha256 both use `d`-registers (vpush/vldr), so FPCA is set
//     and every exception on this core stacks the extended ~104 B frame,
//     not the basic one. 2576 + 312 (dispatch) + 104 (exception frame) =
//     2992, 32 B short of the confirmed 3024 B total -- that residual is
//     8-byte AAPCS alignment padding accumulating across the ~10 frames
//     in the dispatch/handshake chain above, not separately itemized;
//     conservative direction, not chased further. IRQ chain total: 3024 B.
//   * TLS path worst case (sum, matching plan 4a's IRQ-lands-on-
//     whatever-the-foreground-is-doing reasoning): 2536 + 3024 = 5560 B.
//   * Portal path, same accounting (core1_main + portal_run's own frame
//     blocked in its `while (!g_submitted) sleep_ms(5)` poll, plus the
//     deepest of the three servers' IRQ-invoked chains, the same corrected
//     dispatch prefix and exception frame included): ~2260 B -- still well
//     under the TLS path, since the AP phase never has a live TLS
//     connection to service concurrently. CORE1_STACK_BYTES is unchanged.
//
// Worst case is therefore 5560 B (TLS path), up from the ~4.9 KB this
// comment previously recorded (partly core1_main's own growth, partly two
// missed pieces of the IRQ chain above), which no SCRATCH_X-resident stack
// can hold regardless. Beyond 4 KB the only option is a stack in main SRAM
// launched via multicore_launch_core1_with_stack(); 16 KB leaves
// 16384 - 5560 = 10824 B (~66% headroom) of margin against a build with
// ~390 KB of SRAM unallocated, and the MSPLIM stack guard
// (PICO_USE_STACK_GUARDS in CMakeLists.txt) turns any future overrun into
// a hard fault rather than silent heap corruption. 32-byte aligned because
// the guard rounds the limit address up to a 32-byte boundary.
#define CORE1_STACK_BYTES 16384
static __attribute__((aligned(32))) uint32_t core1_stack[CORE1_STACK_BYTES / 4];

// Maps a failed cyw43_arch_wifi_connect_timeout_ms() into one of the two
// corrections spec §6 requires the portal to distinguish, plus a generic
// fallback -- a bare "failed" would send the user back to retype a
// password that was already right. Per pico_cyw43_arch.h's own
// documentation of this call: PICO_ERROR_BADAUTH means the password was
// wrong; PICO_ERROR_TIMEOUT means the timeout elapsed without ever
// joining, which for a *_timeout_ms() (as opposed to *_blocking()) call
// is what a persistently-unmatched SSID looks like --
// cyw43_arch_wifi_connect_bssid_until() (pico-sdk's cyw43_arch.c) treats
// CYW43_LINK_NONET as "keep retrying" internally rather than surfacing it,
// so the timeout is the only signal this call exposes for "never found
// it". Anything else (PICO_ERROR_CONNECT_FAILED, etc.) gets the fallback.
static const char *assoc_failure_message(int err) {
    if (err == PICO_ERROR_BADAUTH)  return "Wrong password";
    if (err == PICO_ERROR_TIMEOUT)  return "Network not found";
    return "Could not connect";
}

static void core1_main(void) {
    if (cyw43_arch_init()) {
        // This loop never exits, but core0 is what drains the log, so this
        // line does get out -- which is the whole reason the drain lives
        // there and not here.
        wf_logf(WF_ERR, "cyw43_arch_init failed, radio is dead");
        while (1) tight_loop_contents();
    }
    wf_logf(WF_INFO, "radio up (RM2)");
    cyw43_arch_enable_sta_mode();

    // Plan 4b: decide whether to serve the captive portal or run plan 4a's
    // protocol loop against stored credentials. Touches no radio itself
    // (provisioning.h's file-wide rule) -- prov.state is what the loop
    // below acts on.
    provisioning_t prov;
    prov_init(&prov);

    // Shown on the portal form after a failed association with freshly
    // submitted credentials (spec D-4b-3's verify-then-commit). NULL
    // until that happens.
    const char *last_error = NULL;

    for (;;) {
        if (prov.state == PROV_PORTAL) {
            wf_logf(WF_INFO, "portal: raising AP%s%s",
                    last_error ? ", last error: " : "", last_error ? last_error : "");
            // Blocks until a POST /save decodes to a complete
            // device_config_t. portal_run() tears down any sockets still
            // up from a previous call itself (it is re-entrant-safe), so
            // looping back here after a failed verify below needs no
            // extra teardown first.
            device_config_t submitted;
            // Final-review Important 2: the wait is bounded ONLY when
            // there is a stored configuration worth going back to.
            //   * have_config true: the portal was opened by three
            //     consecutive association failures, so the credentials in
            //     flash may simply have lost a race with a router that was
            //     still booting. Re-try them every PORTAL_IDLE_TIMEOUT_MS
            //     of nobody touching the AP, so an unattended board
            //     self-heals instead of parking in AP mode forever.
            //   * have_config false: a factory-fresh board, or one whose
            //     config prov_on_pairing_code_rejected() just erased.
            //     There is nothing to re-try, so 0 (wait forever) --
            //     timing out would only bounce the AP under whoever is
            //     mid-form for no gain.
            uint32_t portal_wait_ms =
                prov.have_config ? PORTAL_IDLE_TIMEOUT_MS : 0u;
            portal_run_result_t pr =
                portal_run(&submitted, last_error, portal_wait_ms);

            if (pr == PORTAL_RUN_IDLE_TIMEOUT) {
                // Same teardown as the submit path below -- an idle
                // timeout leaves the AP up exactly as a submission does,
                // and the retry attempt underneath needs STA back as
                // lwIP's default route just as much.
                portal_stop();
                // Back to PROV_RUNNING with a fresh set of attempts
                // against prov.cfg. If those fail too, prov_on_assoc_
                // result() opens the portal again and this repeats --
                // which is the intended shape: a slow sweep, not a
                // permanent strand.
                prov_on_portal_idle_timeout(&prov);
                continue;
            }

            // Load-bearing, and must run before the connect attempt
            // below, not after: bringing the AP up made it lwIP's
            // default route, and portal_stop() is what restores the STA
            // netif cyw43_arch_enable_sta_mode() registered above as
            // netif_default. Skipping this (or reordering it after the
            // connect) leaves the board associated with no route to
            // anywhere, and every TLS handshake in the RUNNING loop below
            // fails as a result.
            portal_stop();
            wf_logf(WF_INFO, "portal: AP down, default route now %s",
                    default_route_str());

            int err = cyw43_arch_wifi_connect_timeout_ms(
                submitted.ssid, submitted.pass,
                CYW43_AUTH_WPA2_AES_PSK, 15000);
            if (err != PICO_OK) {
                last_error = assoc_failure_message(err);
                wf_logf(WF_WARN, "portal: association failed (%d): %s",
                        err, last_error);
                continue;   // portal_run() comes back up showing last_error
            }

            // Verify-then-commit (spec D-4b-3): reaches here only once
            // this exact association has just succeeded, so committing
            // now can never persist credentials that don't work.
            //
            // Review round 2, Important 2: the return value used to be
            // discarded. provisioning.h documents false as "the flash
            // write failed, state deliberately left PROV_PORTAL" -- the
            // one outcome that return exists to report. Discarding it and
            // unconditionally clearing last_error made a flash-write
            // failure loop portal -> submit -> associate -> save-fail ->
            // portal forever with the form showing no error at all, which
            // looks like the submission was silently ignored rather than
            // told "it didn't save, try again".
            wf_logf(WF_INFO, "portal: associated, default route %s",
                    default_route_str());
            if (prov_on_verified_submit(&prov, &submitted)) {
                wf_logf(WF_INFO, "portal: credentials verified and saved");
                last_error = NULL;
            } else {
                last_error = "Could not save configuration, try again";
            }
            continue;
        }

        // PROV_RUNNING: prov.cfg is populated either by prov_init() (a
        // config already on flash) or by prov_on_verified_submit() just
        // above.
        int err = cyw43_arch_wifi_connect_timeout_ms(
            prov.cfg.ssid, prov.cfg.pass,
            CYW43_AUTH_WPA2_AES_PSK, 15000);
        if (err != PICO_OK) {
            // prov_on_assoc_result(p, false) is the only call in this
            // loop that may move `state`: three consecutive failures
            // (PROV_MAX_ASSOC_FAILURES) send it back to PROV_PORTAL, and
            // the top of this loop picks that up on the next iteration.
            wf_logf(WF_WARN, "assoc failed (%d), failure %d of %d", err,
                    prov.assoc_failures + 1, PROV_MAX_ASSOC_FAILURES);
            prov_on_assoc_result(&prov, false);
            // Review round 2, Minor 1: if that was the third failure and
            // the portal just opened, show the same reason a submit-path
            // failure would (spec §6's two-message requirement) -- without
            // this, a boot that never had a chance to submit anything
            // shows a blank form instead of "wrong password"/"network not
            // found". A first or second failure leaves state at
            // PROV_RUNNING, so this is a no-op then.
            if (prov.state == PROV_PORTAL) {
                last_error = assoc_failure_message(err);
            }
            continue;
        }
        // Carried from task 2's review: prov_on_assoc_result(p, true)
        // returns p->state UNCHANGED rather than forcing PROV_RUNNING --
        // that is correct only because this call site is reached
        // exclusively from the PROV_RUNNING branch (this `else`, in
        // effect) above, never from PROV_PORTAL. Do not add another call
        // site to prov_on_assoc_result(true) without preserving that.
        prov_on_assoc_result(&prov, true);
        // Success was previously silent -- only failures logged -- so "did it
        // associate?" could not be answered from the console at all.
        wf_logf(WF_INFO, "associated, default route %s", default_route_str());

        // Spec §6.2: SNTP before the first TLS handshake, and the firmware
        // never skips straight to a handshake with an unset clock --
        // transport_tls.c's tls_connect() itself refuses to start one at all
        // while sntp_time_valid() is false. A poll or register attempted
        // before this succeeds just fails at connect() and falls into the
        // same backoff dc_step()/dc_register() already use for any other
        // transient network fault, so no separate SNTP-specific retry loop is
        // needed here -- sntp_sync_blocking() also keeps periodically
        // resyncing in the background for as long as the process runs.
        //
        // The RESULT is logged because discarding it silently is the single
        // most confusing failure this firmware can have: tls_connect()
        // refuses to start a handshake at all while sntp_time_valid() is
        // false, so a board that cannot reach an NTP server does not report a
        // clock problem -- it sits in dc_register()'s backoff loop forever,
        // looking for all the world like TLS or the server is broken. Saying
        // so costs one line. (The call's own contract is unchanged: a failure
        // here is still not fatal, and sntp keeps resyncing in the
        // background.)
        bool clock_ok = sntp_sync_blocking(30000);
        wf_logf(clock_ok ? WF_INFO : WF_WARN, "sntp: %s", clock_ok
                ? "clock set"
                : "NO clock -- TLS will refuse every handshake until it syncs");

        // static, like device_client.c's buffers and for the same reason:
        // this branch can re-run (a later prov_on_pairing_code_rejected()
        // sends control back to PROV_PORTAL and eventually back here), but
        // never concurrently with itself -- holding ~590 bytes of live
        // frame for the ensuing mbedTLS handshake chain is ~590 bytes it
        // does not get.
        static char mac[18];   // "aa:bb:cc:dd:ee:ff" + NUL
        mac_address_string(mac, sizeof mac);

        // Registration (spec §7): load a stored token, or register for one
        // using the pairing code the portal collected (or that was already
        // on flash). Never logs `token` or the pairing code -- see
        // device_client.h.
        static char token[TOKEN_STORE_MAX_LEN + 1];
        bool code_rejected = false;
        // Hoisted out of the `if` only so the outcome can be stated. Which of
        // these two paths a board takes is the first thing worth knowing when
        // registration misbehaves, and it was previously invisible.
        bool have_token = token_store_load(token, sizeof token);
        wf_logf(WF_INFO, "device: %s", have_token
                ? "stored token found, skipping registration"
                : "no stored token, registering with pairing code");
        if (!have_token) {
            // dc_register() needs only a transport + host; it never reads
            // c->token (it deliberately sends no bearer at all), so this
            // throwaway device_client_t's token is irrelevant -- NULL is
            // honest about that, and leaves `reg` in DC_UNPROVISIONED,
            // which is never used for anything but this loop.
            static device_client_t reg;
            dc_init(&reg, tls_transport(), clock_ms, WEBADF_HOST, NULL);
            dc_register_result_t rr;
            while ((rr = dc_register(&reg, prov.cfg.code, FIRMWARE_VERSION, mac))
                   != DC_REG_OK) {
                if (rr == DC_REG_BAD_CODE) {
                    // Spec D-4b-4: terminal, not retryable -- the code is
                    // single-use with a 10-minute TTL and this one has
                    // already been redeemed or has expired. Back to the
                    // portal for a fresh one rather than hammering
                    // /api/device/register with a code that can never
                    // become valid again.
                    //
                    // Latent, comment-only (review round 2): config_store_
                    // erase() (called from inside this) returns early,
                    // erasing nothing on flash, if disk_is_mounted() --
                    // the same guard token_store_save()/token_store_erase()
                    // use (config_store.c/token_store.c). At THIS call
                    // site nothing has been mounted yet -- registration
                    // runs before the poll loop even starts -- so the
                    // guard cannot fire here. The DC_HALTED path below is
                    // a different story (a disk is very plausibly mounted
                    // by the time a token goes bad in the field); see its
                    // comment for why that one explicitly ejects first.
                    prov_on_pairing_code_rejected(&prov);
                    wf_logf(WF_WARN, "register: pairing code rejected "
                            "(single-use, 10 min TTL) -- back to the portal");
                    last_error = "Invalid or already-used pairing code";
                    code_rejected = true;
                    break;
                }
                // Edge-triggered by construction: one line per ATTEMPT, and
                // every attempt is separated by the backoff below. Without
                // this the loop is a silent forever-retry -- the shape a
                // missing clock, a DNS failure and an unreachable host all
                // collapse into.
                wf_logf(WF_WARN, "register failed (rr=%d), retrying in %lu ms",
                        (int)rr,
                        (unsigned long)(reg.backoff_ms ? reg.backoff_ms
                                                       : DC_BACKOFF_FLOOR_MS));
                sleep_ms(reg.backoff_ms ? reg.backoff_ms : DC_BACKOFF_FLOOR_MS);
            }
            if (code_rejected) continue;   // prov.state is now PROV_PORTAL
            wf_logf(WF_INFO, "register: OK, token stored");
            if (!token_store_load(token, sizeof token)) {
                // dc_register() only ever returns DC_REG_OK after
                // token_store_save() itself succeeded, so this should be
                // unreachable. Halting rather than looping back to
                // register again is deliberate: the pairing code has
                // almost certainly been single-used server-side by the
                // successful attempt above, so retrying would just fail
                // forever.
                while (1) tight_loop_contents();
            }
        }

        static device_client_t c;
        dc_init(&c, tls_transport(), clock_ms, WEBADF_HOST, token);
        wf_logf(WF_INFO, "entering poll loop against %s", WEBADF_HOST);

        static char last_reported_sha[65] = "";
        uint32_t last_status_ms = clock_ms();

        while (true) {
            dc_state_t s = dc_step(&c);

            // Item 1: the drive may only ever report a disk once an image is
            // genuinely resident and published -- dc_step only reaches here
            // (mounted_sha256 non-empty) after a real fetch-and-verify or an
            // already-mounted no-op (dc_handle_poll_body), never as a boot-time
            // assumption. `mounted` here only feeds WPROT (item 3) below --
            // review round 1, Important I-1: dskchg_image_inserted()/ejected()
            // used to be called from THIS core, racing core0's gpio_isr/
            // dskchg_poll against dskchg.c's plain, unsynchronized `st` (a
            // pattern that was harmless when it fired exactly once at boot,
            // but became a real race once this loop could call it repeatedly
            // at arbitrary times). That signalling now lives entirely on core0
            // -- see main()'s track_cache_check_swap() call below -- so
            // dskchg.c stays single-threaded.
            bool mounted = c.mounted_sha256[0] != '\0';

            // Item 3: WPROT. Nothing mounted -> nothing to write to regardless
            // of the flag's stale value; a mounted disk's writeProtected flows
            // through untouched; and -- see WRITE_BACK_IMPLEMENTED's comment
            // above -- the write path's absence forces this true regardless of
            // either, until that path exists. Only main()'s core0 loop ever
            // wrote PIN_WPROT before this (a fixed boot-time default); this is
            // now the only place that updates it afterward.
            bool wprot = !mounted || c.mounted_write_protected || !WRITE_BACK_IMPLEMENTED;
            gpio_put(PIN_WPROT, wprot ? OUT_ASSERT : OUT_RELEASE);

            // Item 4: the status heartbeat. ~60s (DC_STATUS_PERIOD_MS) or
            // immediately on a mount/swap/eject (spec §4.3, §10) -- tracked by
            // the mounted disk's identity (sha256), not dc_state_t or
            // mounted_version (which can advance on a no-op reconciliation poll
            // that names the same already-mounted disk, which is not a
            // transition anyone needs an out-of-band report for).
            // Review (final), Minor 5: not while halted. DC_HALTED means a 401
            // (or a 404 device row) -- the bearer is dead everywhere it
            // appears, and /api/device/status uses the same one, so every
            // heartbeat from here on until this loop notices (see the
            // DC_HALTED case below, item 5) would otherwise be a guaranteed
            // 401 against a known-dead token. dc_report_status's own 401
            // handling would just re-set the state it is already in, so
            // there is no reason to send it even the one time before this
            // loop reacts.
            uint32_t now = clock_ms();
            bool disk_changed = strcmp(c.mounted_sha256, last_reported_sha) != 0;
            if (s != DC_HALTED && (disk_changed || (now - last_status_ms) >= DC_STATUS_PERIOD_MS)) {
                dc_report_status(&c, psram_free_estimate(), wifi_rssi(), NULL);
                last_status_ms = now;
                strncpy(last_reported_sha, c.mounted_sha256, sizeof(last_reported_sha) - 1);
                last_reported_sha[sizeof(last_reported_sha) - 1] = '\0';
            }

            // Item 5: actually honour c.backoff_ms between attempts -- dc_step
            // computes it (device_client.c's dc_enter_backoff) but never
            // sleeps on it itself; this loop is what turns the number into an
            // actual delay. DC_IDLE_POLL needs no extra sleep here: dc_step's
            // own long-poll read already blocked for up to DC_POLL_TIMEOUT_MS
            // server-side. DC_HALTED means the token is dead (401 anywhere);
            // re-provisioning is plan 4b's job, so this just idles rather than
            // hammering a dead token in a tight loop.
            if (s == DC_BACKOFF) {
                sleep_ms(c.backoff_ms);
            } else if (s == DC_HALTED) {
                // Review round 2, Important 1: DC_HALTED used to be a
                // permanent, unrecoverable strand. This `while (true)`
                // never broke, so once registered the outer state machine
                // (provisioning.h) was unreachable again for the rest of
                // the process's life -- a revoked token or a deleted
                // device row (401/404) idled here at the backoff cap
                // forever, and a power cycle did NOT help: config and
                // token both survive flash, prov_init() lands back in
                // PROV_RUNNING, token_store_load() at the top of this
                // branch succeeds, registration is skipped, and the very
                // first status/poll re-401s straight back into DC_HALTED.
                // Recovery needed a physical reflash for what should be a
                // routine re-pair in the web UI -- and task 8 is docs
                // only, so leaving this for "later" meant never.
                //
                // The fix reuses primitives this task already added:
                // eject whatever is mounted (psram_publish_slot(SLOT_NONE)
                // -- the same call dc_step() itself makes for a normal
                // eject, safe to call from core1) so the config/token
                // erases below cannot be silently refused by their
                // mounted-disk guard (see the prov_on_pairing_code_
                // rejected() comment above -- without this eject, a
                // DC_HALTED reached with a disk mounted, the ordinary
                // case in the field, would make token_store_erase() below
                // a no-op and every subsequent boot would just 401 straight
                // back into DC_HALTED again); then token_store_erase()
                // and break out of this inner loop. Back at the top of
                // the outer PROV_RUNNING branch, token_store_load() now
                // fails, so the registration loop runs again with
                // prov.cfg.code -- the same, already-redeemed pairing
                // code -- which the server reports as
                // invalid_or_used_code (DC_REG_BAD_CODE), landing on
                // prov_on_pairing_code_rejected() and the portal, exactly
                // where a human can supply a fresh pairing code.
                psram_publish_slot(SLOT_NONE);
                token_store_erase();
                break;
            } else if (s == DC_UNPROVISIONED) {
                // Review (final), Important 2: DC_UNPROVISIONED gets the same
                // floor as DC_HALTED used to. dc_step returns it immediately
                // without touching the network, so if token_store_load()
                // ever hands back a zero-length token (dc_init reads that
                // as unprovisioned) this loop would otherwise spin core1
                // flat out calling dc_step, dc_report_status and
                // cyw43_wifi_get_rssi forever. This state cannot change
                // from inside this loop (unlike DC_HALTED, above, which
                // now recovers), so idling is the whole correct behaviour.
                sleep_ms(DC_BACKOFF_CAP_MS);
            }
        }
    }
}

// ---------------------------------------------------------------- main
int main(void) {
    stdio_init_all();
    wf_log_init();
    wf_logf(WF_INFO, "wifi-floppy boot: %s", PICO_BOARD);

    // outputs (FET gates, idle released)
    const uint outs[] = {PIN_WPROT, PIN_RDY, PIN_TRK0, PIN_INDEX, PIN_CHNG};
    for (unsigned i = 0; i < count_of(outs); i++) {
        gpio_init(outs[i]); gpio_set_dir(outs[i], GPIO_OUT);
        gpio_put(outs[i], OUT_RELEASE);
    }
    gpio_put(PIN_TRK0, OUT_ASSERT);          // powered on at cyl 0
    // Boot-time default, before core1 has even started, let alone learned
    // whether a disk is mounted or what the server says about it -- core1's
    // main loop is the only thing that writes PIN_WPROT after this (see its
    // WPROT comment), but "asserted" is the only safe value to boot with
    // regardless: read-only until proven otherwise beats writable by default.
    gpio_put(PIN_WPROT, OUT_ASSERT);

    // inputs
    const uint ins[] = {PIN_SEL0, PIN_SEL1, PIN_MTR, PIN_DIR,
                        PIN_STEP, PIN_WGATE, PIN_SIDE};
    for (unsigned i = 0; i < count_of(ins); i++) {
        gpio_init(ins[i]); gpio_set_dir(ins[i], GPIO_IN);
    }

    dskchg_init();
    track_cache_init();

    // Both are hand-wired bring-up aids on unrouted header pins and both are
    // no-ops with nothing attached, so neither is conditional: a board with no
    // LED and no panel simply logs that it found no panel.
    led_init();
    // Three blinks, scheduled not blocked. With no Amiga connected there is no
    // floppy traffic at all, so this is the only thing that distinguishes a
    // working LED from a backwards one before the cable goes on.
    led_selftest(3);
    i2c_probe_bus();
    // psram_image_init() runs inside track_cache_init() and its bool result is
    // discarded there. Say it out loud, because PSRAM is the one part of this
    // board no footprint check and no host test can vouch for: a pin-compatible
    // module WITHOUT the PSRAM this design needs fits U1 perfectly, and the only
    // symptom is that image_parse_begin() goes straight to its error state and
    // every single fetch fails -- silently, forever, on a board that otherwise
    // associates, registers and polls perfectly.
    {
        bool ok = psram_image_available();
        wf_logf(ok ? WF_INFO : WF_ERR, "psram: %s (%u KB needed for %d slots)",
                ok ? "available" : "NOT AVAILABLE -- every image fetch will fail",
                (unsigned)((size_t)SLOT_COUNT * NUM_TRACKS * TRACK_MAX_BYTES / 1024u),
                SLOT_COUNT);
    }

    // PIO
    uint off_out = pio_add_program(pio, &flux_out_program);
    sm_out = pio_claim_unused_sm(pio, true);
    flux_out_program_init(pio, sm_out, off_out, PIN_RDATA);
    pio_sm_set_enabled(pio, sm_out, true);

    uint off_in = pio_add_program(pio, &flux_in_program);
    sm_in = pio_claim_unused_sm(pio, true);
    flux_in_program_init(pio, sm_in, off_in, PIN_WDATA);
    // (enabled when WGATE asserts; write path TODO)

    dma_ch = dma_claim_unused_channel(true);
    irq_set_exclusive_handler(DMA_IRQ_0, dma_irq);
    irq_set_enabled(DMA_IRQ_0, true);

    gpio_set_irq_enabled_with_callback(PIN_STEP, GPIO_IRQ_EDGE_FALL, true, gpio_isr);
    gpio_set_irq_enabled(PIN_SEL0, GPIO_IRQ_EDGE_FALL, true);
    gpio_set_irq_enabled(PIN_MTR,  GPIO_IRQ_EDGE_FALL | GPIO_IRQ_EDGE_RISE, true);
    gpio_set_irq_enabled(PIN_SIDE, GPIO_IRQ_EDGE_FALL | GPIO_IRQ_EDGE_RISE, true);

    // NOT multicore_launch_core1(): that uses the SCRATCH_X-resident
    // .stack1_dummy, which tops out at 4 KB and cannot hold core1's
    // measured ~4.9 KB worst case (foreground TLS setup plus the lwIP/
    // mbedTLS IRQ chain that runs on the same stack). See core1_stack's
    // comment above.
    multicore_launch_core1_with_stack(core1_main, core1_stack, sizeof core1_stack);
    // Lets core1's (rare, one-time) token flash write -- token_store.c,
    // guarded to only ever run before any disk is mounted -- pause core0
    // for its duration via flash_safe_execute's multicore lockout: core0
    // executes nothing at all (interrupts disabled) while XIP is down.
    // This -- not the DMA IRQ's __not_in_flash_func above -- is what
    // actually prevents that handler from stalling mid-flash-write; see
    // its comment for why RAM-placement alone does not fully cover it
    // (its own call graph still reaches into flash). __not_in_flash_func
    // is kept as a second, cheap layer regardless.
    // multicore_launch_core1() returns almost immediately, so the question
    // is whether core1 can reach a flash write before this line runs.
    //
    // Final-review Minor 6: this comment used to answer that with "core1
    // has a WiFi connect, an SNTP sync, and a register round-trip ahead of
    // it", which plan 4b made false -- the FIRST flash write on a
    // freshly-provisioned board is now config_store_save(), which lands in
    // core1_main()'s portal branch ahead of all three. The conclusion is
    // unchanged and if anything stronger: that write happens only after
    // the AP has been raised, a phone has joined it, a human has filled in
    // a form, and the board has associated with what they typed -- seconds
    // at the very best, and realistically much longer. There is no
    // meaningful race with doing this init here rather than earlier; the
    // reason stated for it just had to stop naming the wrong first write.
    flash_safe_execute_core_init();

    want_track = 0;

    // Track service: psram_image.h/.c's own repeated documentation is
    // explicit that "core0 (track_cache.c's track_cache_get()) is the only
    // reader" of the published active slot -- this loop is where that
    // reading happens, in the same real-time loop as dskchg_poll(), NOT in
    // core1_main()'s loop. core1's loop now blocks for tens of seconds at
    // a time inside dc_step()'s long poll; a track change noticed only
    // when that call returns would leave the flux DMA replaying a stale
    // track for however long is left of the poll, which the Amiga would
    // see as reading the wrong data after a seek. track_cache.h's
    // track_cache_get() comment previously said "Core 1" -- corrected
    // alongside this move.
    //
    // Review round 1, Critical C-1: a seek (a STEP pulse, which is what
    // sets `want_track`) was previously the ONLY thing that ever re-entered
    // track_cache_get(), so a swap or an eject with no seek in between was
    // invisible here -- the flux DMA would keep replaying whatever track it
    // last loaded from a disk that may no longer even be mounted, with
    // INDEX still pulsing, forever. last_active_token latches
    // psram_active_token() (see track_cache_check_swap(), which is the
    // pure/host-tested half of this fix) so this loop notices the change
    // itself, independent of `want_track`, and reacts immediately: force
    // re-entry into track_cache_get() at the CURRENT head position (a swap
    // takes effect right away, not on the next seek), and on an eject stop
    // the flux DMA outright rather than letting it run one more revolution
    // on a disk that is already gone.
    //
    // Review round 1, Important I-1: dskchg_image_inserted()/ejected() are
    // called from here too, not from core1 -- see core1_main()'s comment
    // on `mounted`. This keeps dskchg.c's `st` single-threaded (only ever
    // touched from core0: gpio_isr, dskchg_poll, and this call), since it
    // is plain and unsynchronized.
    int32_t last_active_token = 0;   // psram_image.c: 0 == the fresh-boot sentinel
    int loaded = -1;
    while (true) {
        dskchg_poll();

        bool now_mounted;
        if (track_cache_check_swap(&last_active_token, &now_mounted)) {
            loaded = -1;
            if (now_mounted) {
                dskchg_image_inserted();
                wf_trace(WF_EV_MOUNT, (uint32_t)last_active_token, 0);
            } else {
                dskchg_image_ejected();
                track_live = false;
                dma_channel_abort(dma_ch);
                wf_trace(WF_EV_EJECT, 0, 0);
            }
        }

        int want = want_track;
        if (want >= 0 && want != loaded) {
            uint32_t bits;
            const uint8_t *mfm = track_cache_get(want, &bits);
            if (mfm) {
                track_live = false;
                start_streaming(mfm, bits);
                loaded = want;
                wf_trace(WF_EV_TRACK_SERVED, (uint32_t)want, bits);
                led_blip();
            } else {
                // Not a cache miss to retry -- psram_image.h is explicit
                // that a track absent from PSRAM is a fault. Worth a record
                // every time it happens: on the Amiga this is a drive that
                // reads some tracks and not others, which looks like bad
                // media unless the log says otherwise.
                //
                // `loaded` latches here for the same reason it does on the
                // hit path, and NOT latching it was a real defect. The
                // condition above is level-triggered, so a miss that left
                // `loaded` alone re-entered this branch on the next 1 ms
                // iteration and traced the same track again, forever.
                // Measured on a rev A2 board 2026-09-10: a freshly booted
                // board with no disk mounted -- want_track == 0 and nothing
                // in PSRAM, which is the DEFAULT state of every board at
                // power-on -- emitted 44,929 TRACK-MISS records in 48
                // seconds (40 KB/s), burying every other event at several
                // thousand to one and defeating the whole point of the log.
                // Latching makes it one record per track change, which is
                // what "every time it happens" was always meant to mean.
                //
                // Not retrying costs nothing: track_cache_check_swap() above
                // resets `loaded` to -1 on every mount and every eject, so a
                // track that only arrives later is re-attempted then.
                loaded = want;
                wf_trace(WF_EV_TRACK_MISS, (uint32_t)want, 0);
            }
        }

        // Bounded on purpose. Four lines per 1 ms iteration keeps up with a
        // seek across the whole disk, and caps what a host that has stopped
        // reading can cost this loop (PICO_STDIO_USB_STDOUT_TIMEOUT_US in
        // CMakeLists bounds each write).
        wf_log_drain(4);
        sleep_ms(1);
    }
}
