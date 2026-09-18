#include "bus_gate.h"
#include "floppy_io.h"

#define BIT(p) (1u << (p))

uint32_t bus_gate_status_mask(void) {
    return BIT(PIN_INDEX) | BIT(PIN_CHNG) | BIT(PIN_WPROT) | BIT(PIN_RDY) | BIT(PIN_TRK0);
}

uint32_t bus_gate_apply(uint32_t shadow, unsigned pin, bool assert) {
    if (pin >= 32 || !(bus_gate_status_mask() & BIT(pin))) return shadow;
    // Bit set = pin HIGH = BSS138 on = bus line pulled low = asserted.
    return assert ? (shadow | BIT(pin)) : (shadow & ~BIT(pin));
}

bus_step_t bus_step_decode(uint32_t word) {
    // Bit n = GP(PIN_SEL0 + n), active low through the '541.
    bus_step_t s;
    s.selected = (word & BIT(PIN_SEL0 - PIN_SEL0)) == 0;
    s.outwards = (word & BIT(PIN_DIR - PIN_SEL0)) != 0;
    return s;
}

uint32_t bus_sniff_decode(uint32_t packed) {
    // bus_sniff takes GP0..GP6 first, then GP8..GP10, then GP12..GP13, into a
    // left-shifting ISR -- so the first group lands highest.
    uint32_t lo  = (packed >> 5) & 0x7fu;   // GP0..GP6
    uint32_t mid = (packed >> 2) & 0x7u;    // GP8..GP10
    uint32_t hi  = packed & 0x3u;           // GP12..GP13
    return lo | (mid << 8) | (hi << 12);
}

bool bus_sniff_violation(uint32_t gpio_mask) {
    const bool released = (gpio_mask & BIT(PIN_SEL0)) != 0;
    return released && (gpio_mask & bus_gate_status_mask()) != 0;
}
