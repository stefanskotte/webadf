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
#include <stdio.h>
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
static void start_streaming(const uint8_t *mfm, uint32_t bit_count) {
    uint32_t nwords = (bit_count + 31) / 32;
    // repack bytes MSB-first into words for autopull
    for (uint32_t i = 0; i < nwords; i++) {
        uint32_t w = 0;
        for (int b = 0; b < 4; b++) w = (w << 8) | mfm[i * 4 + b];
        track_words[i] = w;
    }
    track_word_count = nwords;
    dma_channel_abort(dma_ch);
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
    } else if (gpio == PIN_SEL0 && (events & GPIO_IRQ_EDGE_FALL)) {
        dskchg_on_sel_edge();
    } else if (gpio == PIN_MTR) {
        dskchg_on_motor(!gpio_get(PIN_MTR));         // active low
    } else if (gpio == PIN_SIDE) {
        cur_side = gpio_get(PIN_SIDE) ? 0 : 1;       // low = side 1
        want_track = cur_cyl * 2 + cur_side;
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

static void mac_address_string(char *out, size_t out_len) {
    uint8_t mac[6] = {0};
    cyw43_wifi_get_mac(&cyw43_state, CYW43_ITF_STA, mac);
    snprintf(out, out_len, "%02x:%02x:%02x:%02x:%02x:%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

// ---------------------------------------------------------------- core 1
static void core1_main(void) {
    if (cyw43_arch_init()) while (1) tight_loop_contents();
    cyw43_arch_enable_sta_mode();
    while (cyw43_arch_wifi_connect_timeout_ms(WIFI_SSID, WIFI_PASS,
              CYW43_AUTH_WPA2_AES_PSK, 15000)) sleep_ms(1000);

    // Spec §6.2: SNTP before the first TLS handshake, and the firmware
    // never skips straight to a handshake with an unset clock --
    // transport_tls.c's tls_connect() itself refuses to start one at all
    // while sntp_time_valid() is false. A poll or register attempted
    // before this succeeds just fails at connect() and falls into the
    // same backoff dc_step()/dc_register() already use for any other
    // transient network fault, so no separate SNTP-specific retry loop is
    // needed here -- sntp_sync_blocking() also keeps periodically
    // resyncing in the background for as long as the process runs.
    sntp_sync_blocking(30000);

    char mac[18];   // "aa:bb:cc:dd:ee:ff" + NUL
    mac_address_string(mac, sizeof mac);

    // Registration (spec §7): load a stored token, or register for one.
    // Never logs `token` or the pairing code -- see device_client.h.
    static char token[TOKEN_STORE_MAX_LEN + 1];
    if (!token_store_load(token, sizeof token)) {
        // dc_register() needs only a transport + host; it never reads
        // c->token (it deliberately sends no bearer at all), so this
        // throwaway device_client_t's token is irrelevant -- NULL is
        // honest about that, and leaves `reg` in DC_UNPROVISIONED, which
        // is never used for anything but this loop.
        device_client_t reg;
        dc_init(&reg, tls_transport(), clock_ms, WEBADF_HOST, NULL);
        while (!dc_register(&reg, WEBADF_PAIRING_CODE, FIRMWARE_VERSION, mac)) {
            sleep_ms(reg.backoff_ms ? reg.backoff_ms : DC_BACKOFF_FLOOR_MS);
        }
        if (!token_store_load(token, sizeof token)) {
            // dc_register() only ever returns true after token_store_save()
            // itself succeeded, so this should be unreachable. Halting
            // rather than looping back to register again is deliberate:
            // the pairing code has almost certainly been single-used
            // server-side by the successful attempt above, so retrying
            // would just fail forever.
            while (1) tight_loop_contents();
        }
    }

    device_client_t c;
    dc_init(&c, tls_transport(), clock_ms, WEBADF_HOST, token);

    char last_reported_sha[65] = "";
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
        uint32_t now = clock_ms();
        bool disk_changed = strcmp(c.mounted_sha256, last_reported_sha) != 0;
        if (disk_changed || (now - last_status_ms) >= DC_STATUS_PERIOD_MS) {
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
            sleep_ms(DC_BACKOFF_CAP_MS);
        }
    }
}

// ---------------------------------------------------------------- main
int main(void) {
    stdio_init_all();

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

    multicore_launch_core1(core1_main);
    // Lets core1's (rare, one-time) token flash write -- token_store.c,
    // guarded to only ever run before any disk is mounted -- pause core0
    // for its duration via flash_safe_execute's multicore lockout: core0
    // executes nothing at all (interrupts disabled) while XIP is down.
    // This -- not the DMA IRQ's __not_in_flash_func above -- is what
    // actually prevents that handler from stalling mid-flash-write; see
    // its comment for why RAM-placement alone does not fully cover it
    // (its own call graph still reaches into flash). __not_in_flash_func
    // is kept as a second, cheap layer regardless.
    // multicore_launch_core1() returns almost immediately and core1 has a
    // WiFi connect, an SNTP sync, and (on a fresh device) a register
    // round-trip ahead of it before it can reach that write, so there is
    // no meaningful race with doing this init here rather than earlier.
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
            } else {
                dskchg_image_ejected();
                track_live = false;
                dma_channel_abort(dma_ch);
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
            }
        }
        sleep_ms(1);
    }
}
