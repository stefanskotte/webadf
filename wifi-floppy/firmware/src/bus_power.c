#include "bus_power.h"

void bus_power_init(bus_power_t *b) {
    b->unpowered = false;
    b->low_timing = false;
    b->low_since_ms = 0;
}

bus_power_event_t bus_power_step(bus_power_t *b, uint32_t pads_high, uint32_t now_ms) {
    if (pads_high != 0) {
        b->low_timing = false;
        if (!b->unpowered) return BUS_POWER_NO_CHANGE;
        b->unpowered = false;
        return BUS_POWER_RETURNED;
    }
    if (!b->low_timing) {
        b->low_timing = true;
        b->low_since_ms = now_ms;
    }
    if (!b->unpowered && now_ms - b->low_since_ms >= BUS_UNPOWERED_MS) {
        b->unpowered = true;
        return BUS_POWER_LOST;
    }
    return BUS_POWER_NO_CHANGE;
}
