#include "led_activity.h"

bool led_pnet_track(bool pnet_on, int cyl) {
    return pnet_on && (cyl == PNET_CYL || cyl == PNET_CYL_STATUS);
}

bool led_drive_busy(bool selected, bool motor_on, bool pnet_track) {
    return selected && motor_on && !pnet_track;
}

void led_activity_init(led_activity_t *a) {
    a->ever = false;
    a->last_busy_ms = 0;
}

bool led_activity_step(led_activity_t *a, uint32_t now_ms, bool busy) {
    if (busy) {
        a->ever = true;
        a->last_busy_ms = now_ms;
        return true;
    }
    // Unsigned difference: correct across the 49-day wrap of the ms clock.
    return a->ever && (uint32_t)(now_ms - a->last_busy_ms) < LED_ACT_HOLD_MS;
}
