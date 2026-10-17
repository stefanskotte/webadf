#include "activity_led.h"
#include "floppy_io.h"
#include "pico/stdlib.h"
#include "pico/time.h"

// 40 ms is chosen to be seen, not to be brief: below about 20 ms a single
// flash on a modern LED is easy to miss entirely, and the events this reports
// (a track load, a step pulse) are microseconds long.
#define LED_BLIP_MS      40
// Off-time between self-test blinks. Must exceed LED_BLIP_MS or the blinks
// run together into one long glow and count as one.
#define LED_SELFTEST_GAP_MS 160

static bool     armed;          // led_init() has run; guards a stray blip
static volatile int selftest_left;
// Two sources share the pin: the drive-activity level core0's loop sets
// (led_set_activity; led_activity.h decides it) and the one-shot flashes
// (led_blip: an NFC tap; the boot self-test). The pin shows either. A flash
// ending puts back the activity level rather than driving the pin dark, and
// the loop rewrites the pin every pass, so a race between the two heals
// within a millisecond.
static volatile bool act_lit;
static volatile bool blip_lit;

// Returning 0 means "do not reschedule". The pin is driven low rather than
// toggled: overlapping blips are expected (a seek delivers a STEP every ~3 ms)
// and a toggle would invert the state half the time, leaving the LED dark for
// precisely the burst it is meant to show.
static int64_t led_off_cb(alarm_id_t id, void *arg) {
    (void)id; (void)arg;
    blip_lit = false;
    gpio_put(PIN_ACT_LED, act_lit);
    return 0;
}

static int64_t led_selftest_cb(alarm_id_t id, void *arg) {
    (void)id; (void)arg;
    blip_lit = true;
    gpio_put(PIN_ACT_LED, 1);
    add_alarm_in_us(LED_BLIP_MS * 1000, led_off_cb, NULL, true);
    if (--selftest_left > 0) {
        // Negative return = reschedule this many us after the LAST fire, so
        // the cadence does not drift with callback latency.
        return -(int64_t)((LED_BLIP_MS + LED_SELFTEST_GAP_MS) * 1000);
    }
    return 0;
}

void led_init(void) {
    gpio_init(PIN_ACT_LED);
    gpio_set_dir(PIN_ACT_LED, GPIO_OUT);
    // The WEAKEST drive the pad offers, because the LED on the bench is wired
    // with NO SERIES RESISTOR (operator, 2026-09-12) and floppy_io.h's pinout
    // assumes one.
    //
    // Without a resistor nothing sets the current except the pad's own output
    // impedance against the LED's forward voltage: the "4 mA" default is a
    // guaranteed drive at a specified VOH, not a current limit, and into a ~2 V
    // load it will pass several times that. 2 mA roughly doubles the pad
    // resistance and so roughly halves the current. It is a mitigation, not a
    // fix -- the fix is a resistor, and rev B is unfabricated, which is the
    // cheap moment to add the footprint.
    //
    // Duty cycle no longer helps: the LED is now a level, lit for the whole of
    // every disk access (led_activity.h), the way a real drive's light is --
    // seconds at a time while the Amiga loads. A resistor matters more, not less.
    gpio_set_drive_strength(PIN_ACT_LED, GPIO_DRIVE_STRENGTH_2MA);
    // Dark, not lit. A LED that comes up lit and stays lit would be
    // indistinguishable from a shorted pin.
    gpio_put(PIN_ACT_LED, 0);
    armed = true;
}

void led_selftest(int blinks) {
    if (!armed || blinks <= 0) return;
    selftest_left = blinks;
    // Scheduled, not blocked: this runs during main()'s init, and blocking
    // here would delay entry into the service loop by half a second for a
    // decoration. The Amiga may already be powered and selecting the drive.
    add_alarm_in_us(1, led_selftest_cb, NULL, true);
}

void led_blip(void) {
    if (!armed) return;
    blip_lit = true;
    gpio_put(PIN_ACT_LED, 1);
    // add_alarm_in_us from an interrupt: dma_irq() already does exactly this
    // for the INDEX pulse, under the same multicore-lockout argument its
    // comment sets out. If that ever stops being true, this call goes with it.
    add_alarm_in_us(LED_BLIP_MS * 1000, led_off_cb, NULL, true);
}

void led_set_activity(bool lit) {
    if (!armed) return;
    act_lit = lit;
    gpio_put(PIN_ACT_LED, lit || blip_lit);
}
