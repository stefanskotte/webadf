// ---------------------------------------------------------------------------
// WiFi floppy emulator — Pico 2 W main.
// Core 0: floppy bus real-time (STEP/SEL ISRs, DMA feed, INDEX pulse).
// Core 1: WiFi + track streaming from the ADF webservice.
// ---------------------------------------------------------------------------
#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "pico/cyw43_arch.h"
#include "hardware/pio.h"
#include "hardware/dma.h"
#include "hardware/irq.h"
#include "floppy.pio.h"
#include "floppy_io.h"
#include "dskchg.h"
#include "track_cache.h"
#include "psram_image.h"
#include "image_loader.h"

static PIO  pio = pio0;
static uint sm_out, sm_in;
static int  dma_ch;

static volatile int  cur_cyl   = 0;
static volatile int  cur_side  = 0;
static volatile int  want_track = -1;      // core0 -> core1 request
static volatile bool track_live = false;

static uint32_t track_words[(TRACK_MFM_MAX + 3) / 4];
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
static void __isr dma_irq(void) {
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

// ---------------------------------------------------------------- core 1
static void core1_main(void) {
    if (cyw43_arch_init()) while (1) tight_loop_contents();
    cyw43_arch_enable_sta_mode();
    while (cyw43_arch_wifi_connect_timeout_ms(WIFI_SSID, WIFI_PASS,
              CYW43_AUTH_WPA2_AES_PSK, 15000)) sleep_ms(1000);
    track_cache_init();

    // One bulk transfer, then the network is out of the picture. RDY and
    // CHNG stay deasserted until the whole image is in PSRAM, so the Amiga
    // simply sees "no disk yet" rather than a drive that stalls mid-track.
    while (!image_load(0)) {
        printf("image load failed (%d%%), retrying\n", image_load_percent());
        sleep_ms(1000);
    }
    dskchg_image_inserted();

    int loaded = -1;
    uint32_t bits;
    while (true) {
        int want = want_track;
        if (want >= 0 && want != loaded) {
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
    gpio_put(PIN_WPROT, OUT_ASSERT);         // read-only until write path lands

    // inputs
    const uint ins[] = {PIN_SEL0, PIN_SEL1, PIN_MTR, PIN_DIR,
                        PIN_STEP, PIN_WGATE, PIN_SIDE};
    for (unsigned i = 0; i < count_of(ins); i++) {
        gpio_init(ins[i]); gpio_set_dir(ins[i], GPIO_IN);
    }

    dskchg_init();

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
    want_track = 0;

    while (true) {
        dskchg_poll();
        sleep_ms(2);
    }
}
